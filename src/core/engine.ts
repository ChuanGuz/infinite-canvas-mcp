import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CATEGORY_LABELS, CATEGORY_ORDER, LearningInputSchema, NodeCategorySchema, StageZoneSchema } from '../types/schema.js';
import type { Canvas, CanvasGroup, CanvasNode, CrossProjectExperience, LearningInput, NodeCategory, StageZone, Store } from '../types/schema.js';
import { classifyLearning, uniqueText } from './classifier.js';
import { buildHandoff } from './handoff.js';
import { initialBounds, layoutCanvas } from './layout.js';
import { emptyStore, JsonStorage } from './storage.js';

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const normalize = (text: string) => text.trim().toLocaleLowerCase().replace(/\s+/gu, ' ');
const GroupInputSchema = z.object({
  name: z.string().trim().min(1), description: z.string().default(''),
  color: z.string().trim().min(1).default('#6366f1'), icon: z.string().trim().min(1).default('folder'),
});
const CanvasInputSchema = z.object({
  groupId: z.string().min(1), title: z.string().trim().min(1), projectKey: z.string().trim().min(1),
  description: z.string().default(''), stageTitle: z.string().trim().min(1).default('Project foundation'),
});
export type CreateGroupInput = z.input<typeof GroupInputSchema>;
export type CreateCanvasInput = z.input<typeof CanvasInputSchema>;
export interface ConsolidateOptions { advanceToNextStage?: boolean; nextStageTitle?: string }
export interface FinalizeOptions { validatedNodeIds?: string[]; summary?: string }
export interface ExperienceQuery { query?: string; category?: NodeCategory; tags?: string[]; excludeCanvasId?: string; limit?: number }

function makeStage(stageNumber: number, title = `Stage ${stageNumber}`): StageZone {
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
  if (!store.groups.some(g => g.id === fields.groupId)) throw new Error(`Group not found: ${fields.groupId}`);
  if (store.canvases.some(c => normalize(c.projectKey) === normalize(fields.projectKey))) throw new Error('Project key already exists');
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
  if (!canvas) throw new Error(`Canvas not found: ${canvasId ?? store.activeCanvasId ?? '(no active canvas)'}`);
  return canvas;
}
function requireActive(canvas: Canvas): void {
  if (canvas.status !== 'active') throw new Error(`Canvas is ${canvas.status}; it cannot be modified`);
}
function currentStage(canvas: Canvas): StageZone {
  return canvas.stages.find(s => s.stageNumber === canvas.currentStageNumber)!;
}
function touch(canvas: Canvas): void { canvas.updatedAt = now(); layoutCanvas(canvas); }

function addLearning(canvas: Canvas, input: LearningInput, experienceId: string | null = null): CanvasNode {
  requireActive(canvas);
  if (currentStage(canvas).status !== 'in_progress') throw new Error('Current stage is consolidated; advance to the next stage first');
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
  return uniqueText(nodes.flatMap(n => n.summaryBullets.map(b => `${n.status === 'open' ? '[OPEN] ' : ''}${n.title}: ${b}`)));
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
      const summary = derivedNode(canvas, category, sources, 'stage_summary', `Stage ${stage.stageNumber} — ${CATEGORY_LABELS[category]}`);
      canvas.nodes.push(summary);
      cluster.summaryNodeId = summary.id;
      for (const source of sources) addEdge(canvas, source.id, summary.id, 'summarizes', 'Evidence for category checkpoint');
      const priorSummary = previous?.clusters[category].summaryNodeId;
      if (priorSummary) addEdge(canvas, priorSummary, summary.id, 'evolution', 'Category checkpoint evolution');
      counts.push(`${CATEGORY_LABELS[category]}: ${sources.length} item(s)`);
    }
    if (previous) addEdge(canvas, previous.clusters[category].id, cluster.id, 'evolution', CATEGORY_LABELS[category]);
  }
  stage.status = 'consolidated';
  stage.consolidatedAt = now();
  stage.summary = counts.join('; ') || 'No learning items recorded in this stage.';
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
    if (!node) throw new Error(`Cannot validate missing, open, superseded, or derived node: ${nodeId}`);
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
    const summary = derivedNode(canvas, category, sources, 'distillation', `Final — ${CATEGORY_LABELS[category]}`);
    canvas.nodes.push(summary);
    finalNodes.push(summary);
    for (const source of sources) addEdge(canvas, source.id, summary.id, 'distills', 'Validated evidence for final practice');
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
    id: id('final'), title: 'Final Distillation — Validated project knowledge', bounds: initialBounds(),
    confirmedPractices: finalNodes.filter(n => ['best_practice', 'convention_practice'].includes(n.category)).map(n => n.id),
    coreImplementations: finalNodes.filter(n => ['feature_impl', 'architecture_design'].includes(n.category)).map(n => n.id),
    reusablePatterns: patterns.map(p => p.id),
    handoffSummary: parsed.summary ?? `${canvas.title}: ${canvas.stages.length} stage(s) consolidated; ${eligible.length} validated findings synthesized into ${finalNodes.length} category summaries and ${patterns.length} reusable patterns.`,
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
    const patch = GroupInputSchema.partial().strict().parse(input);
    return this.storage.transaction(store => {
      const group = store.groups.find(g => g.id === groupId);
      if (!group) throw new Error(`Group not found: ${groupId}`);
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
      if (!node) throw new Error(`Learning not found: ${nodeId}`);
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
      if (!experience) throw new Error(`Experience not found: ${experienceId}`);
      if (experience.sourceCanvasId === canvas.id) throw new Error('Experience must come from a different project');
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

/** Realistic first-boot fixtures use exactly the same domain operations as user projects. */
export function createDemoStore(): Store {
  const store = emptyStore();
  const tooling = addGroup(store, { name: 'AI 工具链 / AI Tooling', description: 'Developer tooling and knowledge continuity', color: '#6366f1', icon: 'sparkles' });
  const platform = addGroup(store, { name: '平台工程 / Platform Engineering', description: 'Reusable service foundations', color: '#14b8a6', icon: 'layers' });
  const active = addCanvas(store, { groupId: tooling.id, title: 'Infinite Canvas Knowledge Workbench', projectKey: 'canvas-workbench',
    description: 'Capture AI-assisted engineering decisions, preserve stage history, and provide seamless handoff across sessions.', stageTitle: 'Foundation and persistence' });
  const learn = (canvas: Canvas, category: NodeCategory, title: string, content: string, tags: string[], relatedFiles: string[] = []) =>
    addLearning(canvas, { category, title, content, tags, relatedFiles, importance: 4, validated: true });
  learn(active, 'convention_practice', 'Strict TypeScript and reviewable changes', 'Use strict TypeScript for all domain modules. Run type checks and the Node test suite before each stage checkpoint.', ['typescript', 'workflow'], ['tsconfig.json']);
  learn(active, 'architecture_design', 'Transport-independent domain engine', 'Keep classification, layout, and persistence independent of MCP and HTTP. Transport adapters call the same engine API.', ['architecture', 'mcp'], ['src/core/engine.ts']);
  learn(active, 'feature_impl', 'Atomic JSON persistence', 'Implemented a same-directory temporary write, flush, and atomic rename. Validate the store before replacing persisted state.', ['storage', 'atomic'], ['src/core/storage.ts']);
  learn(active, 'pitfall_fix', 'UTF-8 metadata on Windows', 'Fixed mojibake caused by the default PowerShell file encoding. Read and write all project metadata explicitly as UTF-8.', ['windows', 'encoding']);
  learn(active, 'best_practice', 'Provenance-preserving summaries', 'Validated summaries retain source node IDs. Keep original evidence available in the handoff appendix.', ['handoff', 'provenance']);
  advance(active, 'MCP tools and live synchronization');
  learn(active, 'convention_practice', 'Structured tool validation', 'Validate every tool input before mutation. Return explicit errors for missing canvases or invalid stage transitions.', ['mcp', 'validation']);
  learn(active, 'architecture_design', 'Shared engine for MCP and HTTP', 'Use one transactional store for MCP and REST adapters. Publish committed updates over SSE after successful mutations.', ['mcp', 'sse']);
  learn(active, 'feature_impl', 'Canvas switching and stage checkpoint tools', 'Implemented tool handlers for canvas selection, learning capture, and checkpoint consolidation in the demo project.', ['mcp', 'tools']);
  learn(active, 'pitfall_fix', 'Keep diagnostics off the stdio protocol stream', 'Fixed protocol corruption from console logging. Send diagnostics to stderr and reserve stdout for MCP frames.', ['mcp', 'stdio']);
  learn(active, 'best_practice', 'Recoverable handoff mirrors', 'Use store.json as the source of truth. Rebuild Markdown handoffs on startup to repair interrupted mirror synchronization.', ['handoff', 'recovery']);
  advance(active, 'Interactive canvas and acceptance');
  learn(active, 'feature_impl', 'Viewport navigation prototype', 'Implemented a prototype for pan and zoom while retaining world-space node bounds.', ['canvas', 'viewport']);
  addLearning(active, { title: 'Keyboard navigation acceptance', content: 'TODO: validate focus navigation across category clusters and final distillation cards. Confirm screen-reader labels before release.', category: 'feature_impl', tags: ['accessibility', 'todo'], status: 'open', importance: 4 });
  addLearning(active, { title: 'Large-canvas performance decision', content: 'Pending: benchmark 5,000 cards before selecting viewport culling thresholds.', category: 'architecture_design', status: 'open', tags: ['performance'] });

  const completed = addCanvas(store, { groupId: platform.id, title: 'Reliable Release Service', projectKey: 'release-service',
    description: 'A completed internal release orchestration project with validated engineering conventions and reusable service patterns.', stageTitle: 'Service contracts and reliability' });
  learn(completed, 'convention_practice', 'Validate API inputs at the boundary', 'Use Zod schemas at every service boundary. Reject invalid input before invoking domain logic.', ['validation', 'zod'], ['src/api/contracts.ts']);
  learn(completed, 'architecture_design', 'Idempotent release orchestration', 'Use an idempotency key for each release request. Separate request validation, durable state transitions, and deployment side effects.', ['idempotency', 'architecture']);
  learn(completed, 'feature_impl', 'Retry-safe deployment queue', 'Implemented durable job IDs and bounded retries. Preserve the last failure reason so interrupted deployments can resume safely.', ['queue', 'reliability']);
  learn(completed, 'pitfall_fix', 'Backoff prevents retry storms', 'Fixed synchronized retries by adding randomized exponential backoff and a retry budget.', ['retry', 'reliability']);
  advance(completed, 'Operational validation and release');
  learn(completed, 'best_practice', 'Atomic state replacement', 'Use atomic file replacement for small local state stores. Write and flush a temporary file before renaming it over the previous snapshot.', ['storage', 'atomic', 'reliability']);
  learn(completed, 'convention_practice', 'Evidence before promotion', 'Require a successful recovery test before promoting a reliability pattern to shared guidance.', ['testing', 'workflow']);
  finalize(store, completed, { summary: 'Release service completed with validated boundary contracts, idempotent orchestration, bounded retries, and atomic local persistence. Reuse these patterns after checking target-project constraints.' });
  store.activeCanvasId = active.id;
  return store;
}
