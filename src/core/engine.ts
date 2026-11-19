import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CATEGORY_LABELS, CATEGORY_ORDER, LearningInputSchema, NodeCategorySchema, StageZoneSchema } from '../types/schema.js';
import type { Canvas, CanvasGroup, CanvasNode, CrossProjectExperience, LearningInput, NodeCategory, StageZone, Store } from '../types/schema.js';
import { classifyLearning, uniqueText } from './classifier.js';
import { buildHandoff } from './handoff.js';
import { initialBounds, layoutCanvas } from './layout.js';
import { emptyStore, JsonStorage, DEMO_PROJECTS } from './storage.js';

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const normalize = (text: string) => text.trim().toLocaleLowerCase().replace(/\s+/gu, ' ');
export const GroupInputSchema = z.object({
  name: z.string().trim().min(1), description: z.string().default(''),
  color: z.string().trim().min(1).default('#2f6b55'), icon: z.string().trim().min(1).default('folder'),
});
// Patch validation must not reapply create defaults to omitted fields (Zod 4).
export const GroupPatchSchema = GroupInputSchema.extend({
  description: GroupInputSchema.shape.description.removeDefault(),
  color: GroupInputSchema.shape.color.removeDefault(),
  icon: GroupInputSchema.shape.icon.removeDefault(),
}).partial().strict();
export const CanvasInputSchema = z.object({
  groupId: z.string().min(1), title: z.string().trim().min(1), projectKey: z.string().trim().min(1),
  description: z.string().default(''), stageTitle: z.string().trim().min(1).default('项目基础'),
});
export type CreateGroupInput = z.input<typeof GroupInputSchema>;
export type CreateCanvasInput = z.input<typeof CanvasInputSchema>;
export interface ConsolidateOptions { advanceToNextStage?: boolean; nextStageTitle?: string }
export interface FinalizeOptions { validatedNodeIds?: string[]; summary?: string }
export interface ExperienceQuery { query?: string; category?: NodeCategory; tags?: string[]; excludeCanvasId?: string; limit?: number }

function makeStage(stageNumber: number, title = `阶段 ${stageNumber}`): StageZone {
  return {
    id: id('stage'), stageNumber, title, summary: '', status: 'in_progress',
    bounds: initialBounds(), consolidatedAt: null,
    clusters: StageZoneSchema.shape.clusters.parse(Object.fromEntries(CATEGORY_ORDER.map(category => [category, {
      id: id('cluster'), category, title: CATEGORY_LABELS[category], bounds: initialBounds(), nodeIds: [], summaryNodeId: null,
    }]))),
  };
}

function addGroup(store: Store, input: CreateGroupInput): CanvasGroup {
  const timestamp = now();
  const group: CanvasGroup = { ...GroupInputSchema.parse(input), id: id('group'), createdAt: timestamp, updatedAt: timestamp };
  store.groups.push(group);
  return group;
}

function addCanvas(store: Store, input: CreateCanvasInput): Canvas {
  const { stageTitle, ...fields } = CanvasInputSchema.parse(input);
  if (!store.groups.some(g => g.id === fields.groupId)) throw new Error('未找到分组');
  if (store.canvases.some(c => normalize(c.projectKey) === normalize(fields.projectKey))) throw new Error('项目标识已存在');
  const timestamp = now();
  const canvas: Canvas = { ...fields, id: id('canvas'), status: 'active', currentStageNumber: 1,
    viewport: { x: 0, y: 0, zoom: 1 }, stages: [makeStage(1, stageTitle)], finalZone: null,
    nodes: [], edges: [], createdAt: timestamp, updatedAt: timestamp };
  store.canvases.push(canvas);
  store.activeCanvasId = canvas.id;
  return layoutCanvas(canvas);
}

function findCanvas(store: Store, canvasId?: string): Canvas {
  const canvas = store.canvases.find(c => c.id === (canvasId ?? store.activeCanvasId));
  if (!canvas) throw new Error('未找到画布');
  return canvas;
}
function requireActive(canvas: Canvas): void {
  if (canvas.status !== 'active') throw new Error(`画布${canvas.status === 'completed' ? '已结项' : '已归档'}，无法修改`);
}
function currentStage(canvas: Canvas): StageZone {
  return canvas.stages.find(s => s.stageNumber === canvas.currentStageNumber)!;
}
function touch(canvas: Canvas): void { canvas.updatedAt = now(); layoutCanvas(canvas); }

function addLearning(canvas: Canvas, input: LearningInput, experienceId: string | null = null): CanvasNode {
  requireActive(canvas);
  if (currentStage(canvas).status !== 'in_progress') throw new Error('当前阶段已整理，请先开启下一阶段');
  const item = LearningInputSchema.parse(input);
  const classified = classifyLearning(item);
  const existing = canvas.nodes.find(n => n.stageNumber === canvas.currentStageNumber &&
    n.kind === (experienceId ? 'imported' : 'learning') && n.category === classified.category &&
    normalize(n.title) === normalize(item.title) && normalize(n.content) === normalize(item.content) &&
    n.status === item.status && n.sourceExperienceId === experienceId);
  if (existing) {
    existing.tags = uniqueText([...existing.tags, ...item.tags]);
    existing.relatedFiles = uniqueText([...existing.relatedFiles, ...item.relatedFiles]);
    existing.validated ||= item.validated;
    existing.importance = Math.max(existing.importance, item.importance);
    existing.updatedAt = now();
    touch(canvas);
    return existing;
  }
  const timestamp = now();
  const node: CanvasNode = {
    ...item, id: id('node'), canvasId: canvas.id, stageNumber: canvas.currentStageNumber,
    zone: 'stage', kind: experienceId ? 'imported' : 'learning', category: classified.category,
    summaryBullets: classified.summaryBullets, reusablePatterns: classified.reusablePatterns,
    sourceNodeIds: [], sourceExperienceId: experienceId, bounds: initialBounds(),
    createdAt: timestamp, updatedAt: timestamp,
  };
  canvas.nodes.push(node);
  touch(canvas);
  return node;
}

function addEdge(canvas: Canvas, source: string, target: string, type: Canvas['edges'][number]['type'], label: string): void {
  if (!canvas.edges.some(e => e.source === source && e.target === target && e.type === type))
    canvas.edges.push({ id: id('edge'), canvasId: canvas.id, source, target, type, label, createdAt: now() });
}

function summarizeNodes(nodes: CanvasNode[]): string[] {
  return uniqueText(nodes.flatMap(n => n.summaryBullets.map(b => `${n.status === 'open' ? '【待解决】' : ''}${n.title}：${b}`)));
}

function derivedNode(canvas: Canvas, category: NodeCategory, sources: CanvasNode[], kind: 'stage_summary' | 'distillation', title: string): CanvasNode {
  const timestamp = now();
  const summaryBullets = summarizeNodes(sources);
  return {
    id: id('node'), canvasId: canvas.id, stageNumber: kind === 'distillation' ? null : canvas.currentStageNumber,
    zone: kind === 'distillation' ? 'final' : 'stage', kind, category, title,
    content: summaryBullets.map(b => `- ${b}`).join('\n'), summaryBullets,
    reusablePatterns: uniqueText(sources.flatMap(n => n.reusablePatterns)),
    tags: uniqueText(sources.flatMap(n => n.tags)), relatedFiles: uniqueText(sources.flatMap(n => n.relatedFiles)),
    importance: Math.max(...sources.map(n => n.importance)),
    validated: sources.every(n => n.validated && n.status === 'active'), status: 'active',
    sourceNodeIds: sources.map(n => n.id), sourceExperienceId: null,
    bounds: initialBounds(), createdAt: timestamp, updatedAt: timestamp,
  };
}

function consolidate(canvas: Canvas): StageZone {
  requireActive(canvas);
  const stage = currentStage(canvas);
  if (stage.status === 'consolidated') return stage;
  const previous = canvas.stages.find(s => s.stageNumber === stage.stageNumber - 1);
  const counts: string[] = [];
  for (const category of CATEGORY_ORDER) {
    const sources = canvas.nodes.filter(n => n.stageNumber === stage.stageNumber && n.category === category &&
      ['learning', 'imported'].includes(n.kind) && n.status !== 'superseded');
    const cluster = stage.clusters[category];
    if (sources.length) {
      const summary = derivedNode(canvas, category, sources, 'stage_summary', `阶段 ${stage.stageNumber} · ${CATEGORY_LABELS[category]}`);
      canvas.nodes.push(summary);
      cluster.summaryNodeId = summary.id;
      for (const source of sources) addEdge(canvas, source.id, summary.id, 'summarizes', '分类小结的原始依据');
      const priorSummary = previous?.clusters[category].summaryNodeId;
      if (priorSummary) addEdge(canvas, priorSummary, summary.id, 'evolution', '分类小结的阶段演进');
      counts.push(`${CATEGORY_LABELS[category]}：${sources.length} 条`);
    }
    if (previous) addEdge(canvas, previous.clusters[category].id, cluster.id, 'evolution', CATEGORY_LABELS[category]);
  }
  stage.status = 'consolidated';
  stage.consolidatedAt = now();
  stage.summary = counts.join('；') || '本阶段尚未记录学习成果。';
  touch(canvas);
  return stage;
}

function advance(canvas: Canvas, title?: string): StageZone {
  requireActive(canvas);
  if (title !== undefined) z.string().trim().min(1).parse(title);
  consolidate(canvas);
  canvas.currentStageNumber += 1;
  const stage = makeStage(canvas.currentStageNumber, title?.trim());
  canvas.stages.push(stage);
  touch(canvas);
  return stage;
}

function finalize(store: Store, canvas: Canvas, options: FinalizeOptions = {}): NonNullable<Canvas['finalZone']> {
  if (canvas.finalZone) return canvas.finalZone;
  requireActive(canvas);
  const parsed = z.object({ validatedNodeIds: z.array(z.string()).default([]), summary: z.string().trim().min(1).optional() }).parse(options);
  for (const nodeId of parsed.validatedNodeIds) {
    const node = canvas.nodes.find(n => n.id === nodeId && ['learning', 'imported'].includes(n.kind) && n.status === 'active');
    if (!node) throw new Error('无法验证不存在、待解决、已替代或自动生成的记录');
    node.validated = true;
    node.updatedAt = now();
  }
  consolidate(canvas);
  const eligible = canvas.nodes.filter(n => ['learning', 'imported'].includes(n.kind) && n.status === 'active' && n.validated &&
    (['best_practice', 'convention_practice'].includes(n.category) || n.importance >= 4));
  const finalNodes: CanvasNode[] = [];
  for (const category of CATEGORY_ORDER) {
    const sources = eligible.filter(n => (n.category === 'pitfall_fix' ? 'best_practice' : n.category) === category);
    if (!sources.length) continue;
    const summary = derivedNode(canvas, category, sources, 'distillation', `终局精华 · ${CATEGORY_LABELS[category]}`);
    canvas.nodes.push(summary);
    finalNodes.push(summary);
    for (const source of sources) addEdge(canvas, source.id, summary.id, 'distills', '最终好用法的已验证依据');
  }
  // Merge equivalent findings across stages, keeping every contributing source ID.
  const buckets = new Map<string, CanvasNode[]>();
  for (const node of eligible) {
    const key = `${node.category}:${normalize(node.content)}`;
    buckets.set(key, [...(buckets.get(key) ?? []), node]);
  }
  const patterns: CrossProjectExperience[] = [];
  for (const sources of buckets.values()) {
    const first = sources[0]!;
    const timestamp = now();
    const experience: CrossProjectExperience = {
      id: id('experience'), title: first.title, content: first.content,
      category: first.category === 'pitfall_fix' ? 'best_practice' : first.category,
      summaryBullets: uniqueText(sources.flatMap(n => n.summaryBullets)),
      tags: uniqueText(sources.flatMap(n => n.tags)), relatedFiles: uniqueText(sources.flatMap(n => n.relatedFiles)),
      sourceCanvasId: canvas.id, sourceNodeIds: sources.map(n => n.id), validated: true,
      appliedCanvasIds: [], createdAt: timestamp, updatedAt: timestamp,
    };
    patterns.push(experience);
  }
  store.crossProjectExperiences.push(...patterns);
  canvas.finalZone = {
    id: id('final'), title: '终局精华 · 已验证的项目知识', bounds: initialBounds(),
    confirmedPractices: finalNodes.filter(n => ['best_practice', 'convention_practice'].includes(n.category)).map(n => n.id),
    coreImplementations: finalNodes.filter(n => ['feature_impl', 'architecture_design'].includes(n.category)).map(n => n.id),
    reusablePatterns: patterns.map(p => p.id),
    handoffSummary: parsed.summary ?? `${canvas.title}：已整理 ${canvas.stages.length} 个阶段，将 ${eligible.length} 条已验证成果提炼为 ${finalNodes.length} 份分类小结和 ${patterns.length} 条可复用经验。`,
    distilledAt: now(),
  };
  canvas.status = 'completed';
  touch(canvas);
  return canvas.finalZone;
}

export interface EngineOptions { dataDir?: string; seedDemo?: boolean }

/** Synchronous transactional core; transport adapters can wrap these methods in Stage 2. */
export class CanvasEngine {
  readonly storage: JsonStorage;

  constructor(options: EngineOptions = {}) {
    this.storage = new JsonStorage(options.dataDir);
    this.storage.initialize(options.seedDemo === false ? emptyStore : createDemoStore);
  }

  createGroup(input: CreateGroupInput): CanvasGroup {
    return this.storage.transaction(store => addGroup(store, input));
  }
  listGroups(): CanvasGroup[] { return this.storage.read().groups; }
  updateGroup(groupId: string, input: Partial<CreateGroupInput>): CanvasGroup {
    const patch = GroupPatchSchema.parse(input);
    return this.storage.transaction(store => {
      const group = store.groups.find(g => g.id === groupId);
      if (!group) throw new Error('未找到分组');
      Object.assign(group, patch, { updatedAt: now() });
      return group;
    });
  }
  createCanvas(input: CreateCanvasInput): Canvas { return this.storage.transaction(store => addCanvas(store, input)); }
  listCanvases(groupId?: string): Canvas[] {
    return this.storage.read().canvases.filter(c => groupId === undefined || c.groupId === groupId);
  }
  getCanvas(canvasId?: string): Canvas { return findCanvas(this.storage.read(), canvasId); }
  switchCanvas(canvasId: string): Canvas {
    return this.storage.transaction(store => {
      const canvas = findCanvas(store, canvasId);
      store.activeCanvasId = canvas.id;
      return canvas;
    });
  }
  recordLearning(input: LearningInput, canvasId?: string): CanvasNode {
    return this.storage.transaction(store => addLearning(findCanvas(store, canvasId), input));
  }
  /** Explicit review supports open-item resolution and prevents unverified auto-publishing. */
  updateLearning(nodeId: string, input: { validated?: boolean; status?: CanvasNode['status'] }, canvasId?: string): CanvasNode {
    const patch = z.object({ validated: z.boolean().optional(), status: LearningInputSchema.shape.status.optional() }).strict().parse(input);
    return this.storage.transaction(store => {
      const canvas = findCanvas(store, canvasId);
      requireActive(canvas);
      const node = canvas.nodes.find(n => n.id === nodeId && ['learning', 'imported'].includes(n.kind));
      if (!node) throw new Error('未找到学习记录');
      Object.assign(node, patch, { updatedAt: now() });
      // Checkpoints are historical snapshots; current evidence and final distillation use the reviewed original.
      touch(canvas);
      return node;
    });
  }
  consolidateStage(canvasId?: string, options: ConsolidateOptions = {}): StageZone {
    const parsed = z.object({ advanceToNextStage: z.boolean().default(false), nextStageTitle: z.string().trim().min(1).optional() }).parse(options);
    return this.storage.transaction(store => {
      const canvas = findCanvas(store, canvasId);
      const checkpoint = consolidate(canvas);
      if (parsed.advanceToNextStage) advance(canvas, parsed.nextStageTitle);
      return checkpoint;
    });
  }
  advanceStage(canvasId?: string, title?: string): StageZone {
    return this.storage.transaction(store => advance(findCanvas(store, canvasId), title));
  }
  finalizeProjectDistillation(canvasId?: string, options: FinalizeOptions = {}): NonNullable<Canvas['finalZone']> {
    return this.storage.transaction(store => finalize(store, findCanvas(store, canvasId), options));
  }
  getHandoffContext(canvasId?: string) {
    const store = this.storage.read();
    return buildHandoff(store, findCanvas(store, canvasId));
  }
  queryCrossProjectExperiences(input: ExperienceQuery = {}): CrossProjectExperience[] {
    const query = z.object({ query: z.string().default(''), category: NodeCategorySchema.optional(),
      tags: z.array(z.string()).default([]), excludeCanvasId: z.string().optional(),
      limit: z.number().int().positive().max(1000).default(100) }).parse(input);
    const terms = normalize(query.query).split(' ').filter(Boolean);
    return this.storage.read().crossProjectExperiences.map(experience => {
      const title = normalize(experience.title);
      const text = normalize(`${experience.title} ${experience.content} ${experience.tags.join(' ')} ${experience.summaryBullets.join(' ')}`);
      const matches = terms.every(term => text.includes(term)) &&
        (!query.category || experience.category === query.category) &&
        experience.sourceCanvasId !== query.excludeCanvasId &&
        query.tags.every(tag => experience.tags.some(t => normalize(t) === normalize(tag)));
      return { experience, matches, score: terms.reduce((score, term) => score + (title.includes(term) ? 3 : 1), 0) };
    }).filter(item => item.matches).sort((a, b) => b.score - a.score || a.experience.title.localeCompare(b.experience.title))
      .slice(0, query.limit).map(item => item.experience);
  }
  applyExperienceToCanvas(experienceId: string, canvasId?: string): CanvasNode {
    return this.storage.transaction(store => {
      const canvas = findCanvas(store, canvasId);
      requireActive(canvas);
      const experience = store.crossProjectExperiences.find(e => e.id === experienceId);
      if (!experience) throw new Error('未找到经验');
      if (experience.sourceCanvasId === canvas.id) throw new Error('只能引入其他项目的经验');
      const existing = canvas.nodes.find(n => n.sourceExperienceId === experience.id);
      if (existing) return existing;
      const category = ['feature_impl', 'architecture_design'].includes(experience.category) ? 'architecture_design' : 'convention_practice';
      const node = addLearning(canvas, {
        title: experience.title, content: experience.content, category, tags: experience.tags,
        // Source file paths belong to the original project and remain in experience provenance.
        importance: 4, validated: false,
      }, experience.id);
      experience.appliedCanvasIds = [...new Set([...experience.appliedCanvasIds, canvas.id])];
      experience.updatedAt = now();
      return node;
    });
  }
}

/** 示例与用户项目共用领域操作，保留真实阶段演进与经验来源。 */
export function createDemoStore(): Store {
  const store = emptyStore();
  for (const demo of DEMO_PROJECTS) {
    const group = addGroup(store, demo.group);
    const canvas = addCanvas(store, { groupId: group.id, title: demo.title,
      projectKey: demo.title, description: demo.description, stageTitle: demo.stages[0]!.title });
    demo.stages.forEach((stage, index) => {
      if (index) advance(canvas, stage.title);
      for (const learning of stage.learnings) addLearning(canvas, learning);
    });
    if (demo.completed) finalize(store, canvas);
  }
  store.activeCanvasId = store.canvases[0]!.id;
  return store;
}
