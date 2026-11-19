import { CATEGORY_LABELS, CATEGORY_ORDER, HandoffPackageSchema } from '../types/schema.js';
import type { Canvas, CanvasNode, HandoffPackage, Store } from '../types/schema.js';

const inline = (text: string) => text.replace(/\r?\n/gu, ' ').replace(/[\\`*_{}\[\]<>#|]/gu, '\\$&');
const statuses: Record<string, string> = { active: '进行中', completed: '已结项', archived: '已归档',
  in_progress: '进行中', consolidated: '已整理', open: '待解决', superseded: '已替代' };
const kinds: Record<string, string> = { learning: '学习记录', imported: '引入经验', stage_summary: '阶段小结', distillation: '终局精华' };
const date = (value: string) => value.replace('T', ' ').replace(/\.\d+Z$/, '（协调世界时）');
const index = (nodes: CanvasNode[]) => nodes.length
  ? nodes.map(n => `- **${inline(n.title)}**（${n.stageNumber === null ? '终局精华' : '阶段 ' + n.stageNumber}；${statuses[n.status]}；${n.validated ? '已验证' : '待验证'}）\n${n.summaryBullets.map(b => '  - ' + inline(b)).join('\n')}`).join('\n')
  : '暂无记录。';

export function renderHandoffMarkdown(h: HandoffPackage): string {
  const nodeName = (id: string) => h.nodes.find(n => n.id === id)?.title
    ?? h.stages.find(s => s.id === id)?.title
    ?? h.stages.flatMap(s => Object.values(s.clusters)).find(c => c.id === id)?.title ?? '历史来源';
  const lines = [
    `# 项目交接 · ${inline(h.project.title)}`, '',
    `更新时间：${date(h.generatedAt)}`, '',
    '## 项目背景', '',
    `- 项目：${inline(h.project.title)}`,
    `- 所属分组：${inline(h.project.groupName)}`,
    `- 状态：${statuses[h.project.status]}`, '',
    ...h.project.description.split('\n').map(l => '> ' + l), '',
    '## 当前阶段与接续工作', '',
    `阶段 ${h.currentStage.stageNumber}：${inline(h.currentStage.title)}（${statuses[h.currentStage.status]}）`, '',
    '所有新增标题、内容、标签、阶段总结与好用法必须使用简体中文。保留原始依据，未验证的结论不得当作已确认的经验。', '',
    ...h.nextSteps.map(step => '- ' + inline(step)), '',
    '## 我们规定的做法', '', index(h.conventions), '',
    '## 阶段历史与分类小结', '',
  ];
  for (const stage of h.stages) {
    lines.push(`### 阶段 ${stage.stageNumber}：${inline(stage.title)}`, '',
      `状态：${statuses[stage.status]}；整理时间：${stage.consolidatedAt ? date(stage.consolidatedAt) : '尚未整理'}`, '', inline(stage.summary), '');
    for (const category of CATEGORY_ORDER) {
      const summary = h.nodes.find(n => n.id === stage.clusters[category].summaryNodeId);
      lines.push(`- ${CATEGORY_LABELS[category]}：${summary ? summary.summaryBullets.map(inline).join('；') : '尚未生成分类小结。'}`);
    }
    lines.push('');
  }
  lines.push('## 功能实现索引', '', index(h.featureIndex), '',
    '## 架构与决策', '', index(h.architecture), '',
    '## 踩坑与问题修复', '', index(h.pitfalls), '',
    '## 待办与未决事项', '', index(h.openItems), '',
    '## 已验证的好用法', '', index(h.bestPractices), '',
    '## 终局精华区', '', h.finalZone ? inline(h.finalZone.handoffSummary) : '项目尚未进行结尾总整理。', '',
    '## 已引入的跨项目经验', '',
    ...(h.appliedExperiences.length ? h.appliedExperiences.map(e =>
      `- ${inline(e.title)}；引入的经验需要在当前项目重新验证，完整来源保存在结构化交接数据中。`) : ['尚未引入。']), '',
    '## 完整学习记录与来源依据', '',
    '以下原始记录用于核对结论。引用前请确认其状态与验证结果。', '');
  for (const node of h.nodes) {
    lines.push(`### ${inline(node.title)}`, '',
      `分类：${CATEGORY_LABELS[node.category]}；类型：${kinds[node.kind]}；阶段：${node.stageNumber ?? '终局'}；状态：${statuses[node.status]}；验证：${node.validated ? '已验证' : '待验证'}；重要程度：${node.importance}/5`, '',
      ...node.content.split(/\r?\n/u).map(line => '> ' + line), '',
      `标签：${node.tags.map(inline).join('、') || '无'}`,
      `相关文件：${node.relatedFiles.map(inline).join('、') || '无'}`,
      `来源记录：${node.sourceNodeIds.map(id => inline(nodeName(id))).join('、') || '无'}`,
      `来源经验：${inline(h.appliedExperiences.find(e => e.id === node.sourceExperienceId)?.title ?? '无')}`, '',
      `可复用做法：${node.reusablePatterns.map(inline).join('；') || '无'}`, '');
  }
  lines.push('## 演进与证据连线', '',
    ...h.edges.map(e => `- ${inline(nodeName(e.source))} → ${inline(nodeName(e.target))}：${inline(e.label)}`), '');
  return lines.join('\n');
}

export function buildHandoff(store: Store, canvas: Canvas): HandoffPackage {
  const group = store.groups.find(g => g.id === canvas.groupId);
  const currentStage = canvas.stages.find(s => s.stageNumber === canvas.currentStageNumber);
  if (!group || !currentStage) throw new Error('无法生成交接：缺少分组或阶段');
  const originals = canvas.nodes.filter(n => ['learning', 'imported'].includes(n.kind));
  const effective = originals.filter(n => n.status === 'active');
  const openItems = originals.filter(n => n.status === 'open');
  const nextSteps = openItems.map(n => `待解决：${n.title}`);
  if (canvas.status === 'active') {
    nextSteps.push(currentStage.status === 'consolidated'
      ? '请先开启下一阶段，再继续记录学习成果。'
      : '继续推进当前阶段，记录成果后按类别整理阶段小结。');
  } else nextSteps.push('开启后续项目之前，请先审阅终局精华与可复用经验。');
  const result: HandoffPackage = {
    schemaVersion: 1, generatedAt: [canvas.updatedAt, group.updatedAt].sort().at(-1)!,
    project: { canvasId: canvas.id, groupId: group.id, groupName: group.name, title: canvas.title,
      projectKey: canvas.projectKey, description: canvas.description, status: canvas.status },
    currentStage, stages: canvas.stages,
    conventions: effective.filter(n => n.category === 'convention_practice'),
    featureIndex: effective.filter(n => n.category === 'feature_impl'),
    architecture: effective.filter(n => n.category === 'architecture_design'),
    pitfalls: effective.filter(n => n.category === 'pitfall_fix'),
    openItems,
    bestPractices: canvas.nodes.filter(n => n.status === 'active' && n.validated &&
      ((['learning', 'imported'].includes(n.kind) && n.category === 'best_practice') || n.kind === 'distillation')),
    finalZone: canvas.finalZone, nodes: canvas.nodes, edges: canvas.edges,
    appliedExperiences: store.crossProjectExperiences.filter(e => originals.some(n => n.sourceExperienceId === e.id)),
    nextSteps, markdown: '',
  };
  result.markdown = renderHandoffMarkdown(result);
  return HandoffPackageSchema.parse(result);
}
