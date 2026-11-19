import { CATEGORY_LABELS, CATEGORY_ORDER, HandoffPackageSchema } from '../types/schema.js';
import type { Canvas, CanvasNode, HandoffPackage, Store } from '../types/schema.js';

const inline = (text: string) => text.replace(/\r?\n/gu, ' ').replace(/[\\`*_{}\[\]<>#|]/gu, '\\$&');
const index = (nodes: CanvasNode[]) => nodes.length
  ? nodes.map(n => `- **${inline(n.title)}** (${n.id}, stage ${n.stageNumber ?? 'final'}; ${n.status}; ${n.validated ? 'validated' : 'unvalidated'})\n${n.summaryBullets.map(b => `  - ${inline(b)}`).join('\n')}`).join('\n')
  : '_None recorded._';

export function renderHandoffMarkdown(handoff: HandoffPackage): string {
  const h = handoff;
  const lines = [
    `# AI Handoff — ${inline(h.project.title)}`, '',
    `Updated: ${h.generatedAt}`, '',
    '## Project background', '',
    `- Canvas: ${h.project.canvasId}`,
    `- Project key: ${inline(h.project.projectKey)}`,
    `- Group: ${inline(h.project.groupName)} (${h.project.groupId})`,
    `- Status: ${h.project.status}`,
    '', h.project.description.split('\n').map(l => `> ${l}`).join('\n'), '',
    '## Current stage and continuation', '',
    `Stage ${h.currentStage.stageNumber}: ${inline(h.currentStage.title)} (${h.currentStage.status})`, '',
    ...h.nextSteps.map(step => `- ${inline(step)}`), '',
    '## Agreed conventions and practices', '', index(h.conventions), '',
    '## Stage history and category checkpoints', '',
  ];
  for (const stage of h.stages) {
    lines.push(`### Stage ${stage.stageNumber}: ${inline(stage.title)}`, '',
      `Status: ${stage.status}; checkpoint: ${stage.consolidatedAt ?? 'not yet consolidated'}`, '', inline(stage.summary), '');
    for (const category of CATEGORY_ORDER) {
      const summary = h.nodes.find(n => n.id === stage.clusters[category].summaryNodeId);
      lines.push(`- ${CATEGORY_LABELS[category]}: ${summary ? summary.summaryBullets.map(inline).join('; ') : 'No checkpoint summary yet.'}`);
    }
    lines.push('');
  }
  lines.push('## Feature implementation index', '', index(h.featureIndex), '',
    '## Architecture and decisions', '', index(h.architecture), '',
    '## Pitfalls and fixes', '', index(h.pitfalls), '',
    '## Open items and unresolved decisions', '', index(h.openItems), '',
    '## Validated best practices', '', index(h.bestPractices), '',
    '## Final Distillation Zone', '',
    h.finalZone ? inline(h.finalZone.handoffSummary) : '_Project has not been finalized._', '',
    '## Applied cross-project experience', '',
    ...(h.appliedExperiences.length ? h.appliedExperiences.map(e =>
      `- ${inline(e.title)} (${e.id}); source canvas: ${e.sourceCanvasId}; source nodes: ${e.sourceNodeIds.join(', ')}. Imported guidance requires validation in this project.`)
      : ['_None applied._']), '',
    '## Complete learning records and provenance', '',
    'Original content below is project evidence. Check open/superseded status and validation before relying on a claim.', '');
  for (const node of h.nodes) {
    lines.push(`### ${inline(node.title)} (${node.id})`, '',
      `Category: ${node.category}; kind: ${node.kind}; stage: ${node.stageNumber ?? 'final'}; status: ${node.status}; validated: ${node.validated}; importance: ${node.importance}/5`, '',
      node.content.split(/\r?\n/u).map(line => `> ${line}`).join('\n'), '',
      `Tags: ${node.tags.map(inline).join(', ') || 'none'}`,
      `Related files: ${node.relatedFiles.map(inline).join(', ') || 'none'}`,
      `Source nodes: ${node.sourceNodeIds.join(', ') || 'none'}; source experience: ${node.sourceExperienceId ?? 'none'}`, '',
      `Reusable candidates: ${node.reusablePatterns.map(inline).join('; ') || 'none'}`, '');
  }
  lines.push('## Evolution and evidence links', '', ...h.edges.map(e => `- ${e.source} → ${e.target} (${e.type}): ${inline(e.label)}`), '');
  return lines.join('\n');
}

export function buildHandoff(store: Store, canvas: Canvas): HandoffPackage {
  const group = store.groups.find(g => g.id === canvas.groupId);
  const currentStage = canvas.stages.find(s => s.stageNumber === canvas.currentStageNumber);
  if (!group || !currentStage) throw new Error('Cannot build handoff: missing group or stage');
  const originals = canvas.nodes.filter(n => ['learning', 'imported'].includes(n.kind));
  const effective = originals.filter(n => n.status === 'active');
  const openItems = originals.filter(n => n.status === 'open');
  const nextSteps = openItems.map(n => `Resolve: ${n.title} (${n.id})`);
  if (canvas.status === 'active') {
    nextSteps.push(currentStage.status === 'consolidated'
      ? 'Advance to the next stage before recording additional learning.'
      : 'Continue the current stage, record outcomes, then consolidate its category checkpoints.');
  } else nextSteps.push('Review final distillation and reusable patterns before starting a successor project.');
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
