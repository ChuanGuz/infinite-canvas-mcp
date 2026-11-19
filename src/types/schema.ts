import { z } from 'zod';

export const NodeCategorySchema = z.enum([
  'feature_impl', 'convention_practice', 'architecture_design', 'pitfall_fix', 'best_practice',
]);
export type NodeCategory = z.infer<typeof NodeCategorySchema>;
export const CATEGORY_ORDER: readonly NodeCategory[] = [
  'convention_practice', 'architecture_design', 'feature_impl', 'pitfall_fix', 'best_practice',
];
export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  convention_practice: '我们规定的做法',
  architecture_design: '架构与模型设计',
  feature_impl: '功能实现',
  pitfall_fix: '踩坑与问题修复',
  best_practice: '最终确定的好用法',
};

export const IdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const Text = z.string().trim().min(1);
const Timestamp = z.iso.datetime();
export const BoundsSchema = z.object({
  x: z.number().finite(), y: z.number().finite(),
  width: z.number().positive(), height: z.number().positive(),
});
export type Bounds = z.infer<typeof BoundsSchema>;

export const CanvasGroupSchema = z.object({
  id: IdSchema, name: Text, description: z.string(), color: Text, icon: Text,
  createdAt: Timestamp, updatedAt: Timestamp,
});
export type CanvasGroup = z.infer<typeof CanvasGroupSchema>;

export const CategoryClusterSchema = z.object({
  id: IdSchema, category: NodeCategorySchema, title: Text, bounds: BoundsSchema,
  nodeIds: z.array(IdSchema), summaryNodeId: IdSchema.nullable(),
});
export type CategoryCluster = z.infer<typeof CategoryClusterSchema>;

export const StageZoneSchema = z.object({
  id: IdSchema, stageNumber: z.number().int().positive(), title: Text, summary: z.string(),
  status: z.enum(['in_progress', 'consolidated']), bounds: BoundsSchema,
  clusters: z.record(NodeCategorySchema, CategoryClusterSchema),
  consolidatedAt: Timestamp.nullable(),
});
export type StageZone = z.infer<typeof StageZoneSchema>;

export const FinalDistillationZoneSchema = z.object({
  id: IdSchema, title: Text, bounds: BoundsSchema,
  // Node IDs refer to distillation cards in Canvas.nodes; originals stay in their stages.
  confirmedPractices: z.array(IdSchema), coreImplementations: z.array(IdSchema),
  reusablePatterns: z.array(IdSchema), handoffSummary: z.string(), distilledAt: Timestamp,
});
export type FinalDistillationZone = z.infer<typeof FinalDistillationZoneSchema>;

export const LearningInputSchema = z.object({
  title: Text.max(300), content: Text, tags: z.array(Text).default([]),
  category: NodeCategorySchema.optional(), relatedFiles: z.array(Text).default([]),
  importance: z.number().int().min(1).max(5).default(3),
  validated: z.boolean().default(false),
  status: z.enum(['active', 'open', 'superseded']).default('active'),
});
export type LearningInput = z.input<typeof LearningInputSchema>;

export const CanvasNodeSchema = z.object({
  id: IdSchema, canvasId: IdSchema, stageNumber: z.number().int().positive().nullable(),
  zone: z.enum(['stage', 'final']),
  kind: z.enum(['learning', 'imported', 'stage_summary', 'distillation']),
  category: NodeCategorySchema, title: Text, content: Text,
  summaryBullets: z.array(Text), reusablePatterns: z.array(Text),
  tags: z.array(Text), relatedFiles: z.array(Text), importance: z.number().int().min(1).max(5),
  validated: z.boolean(), status: z.enum(['active', 'open', 'superseded']),
  sourceNodeIds: z.array(IdSchema), sourceExperienceId: IdSchema.nullable(),
  bounds: BoundsSchema, createdAt: Timestamp, updatedAt: Timestamp,
}).refine(n => (n.zone === 'final') === (n.stageNumber === null), {
  message: 'Only final-zone nodes have a null stage number',
}).refine(n => (n.zone === 'final') === (n.kind === 'distillation'), {
  message: 'Distillation nodes belong exclusively to the final zone',
});
export type CanvasNode = z.infer<typeof CanvasNodeSchema>;

export const CanvasEdgeSchema = z.object({
  id: IdSchema, canvasId: IdSchema, source: IdSchema, target: IdSchema,
  type: z.enum(['evolution', 'summarizes', 'distills', 'depends_on']),
  label: z.string(), createdAt: Timestamp,
});
export type CanvasEdge = z.infer<typeof CanvasEdgeSchema>;

export const CanvasSchema = z.object({
  id: IdSchema, groupId: IdSchema, title: Text, projectKey: Text, description: z.string(),
  status: z.enum(['active', 'completed', 'archived']),
  currentStageNumber: z.number().int().positive(),
  viewport: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().positive() }),
  stages: z.array(StageZoneSchema).min(1), finalZone: FinalDistillationZoneSchema.nullable(),
  nodes: z.array(CanvasNodeSchema), edges: z.array(CanvasEdgeSchema),
  createdAt: Timestamp, updatedAt: Timestamp,
});
export type Canvas = z.infer<typeof CanvasSchema>;

export const CrossProjectExperienceSchema = z.object({
  id: IdSchema, title: Text, content: Text, category: NodeCategorySchema,
  summaryBullets: z.array(Text), tags: z.array(Text), relatedFiles: z.array(Text),
  sourceCanvasId: IdSchema, sourceNodeIds: z.array(IdSchema).min(1),
  validated: z.literal(true), appliedCanvasIds: z.array(IdSchema),
  createdAt: Timestamp, updatedAt: Timestamp,
});
export type CrossProjectExperience = z.infer<typeof CrossProjectExperienceSchema>;

export const HandoffPackageSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: Timestamp,
  project: z.object({
    canvasId: IdSchema, groupId: IdSchema, groupName: Text, title: Text,
    projectKey: Text, description: z.string(), status: CanvasSchema.shape.status,
  }),
  currentStage: StageZoneSchema,
  stages: z.array(StageZoneSchema),
  conventions: z.array(CanvasNodeSchema),
  featureIndex: z.array(CanvasNodeSchema),
  architecture: z.array(CanvasNodeSchema),
  pitfalls: z.array(CanvasNodeSchema),
  openItems: z.array(CanvasNodeSchema),
  bestPractices: z.array(CanvasNodeSchema),
  finalZone: FinalDistillationZoneSchema.nullable(),
  // Complete source records and edges are retained, even when the overview is condensed.
  nodes: z.array(CanvasNodeSchema), edges: z.array(CanvasEdgeSchema),
  appliedExperiences: z.array(CrossProjectExperienceSchema),
  nextSteps: z.array(Text), markdown: z.string(),
});
export type HandoffPackage = z.infer<typeof HandoffPackageSchema>;

export const StoreSchema = z.object({
  schemaVersion: z.literal(1), activeCanvasId: IdSchema.nullable(),
  groups: z.array(CanvasGroupSchema), canvases: z.array(CanvasSchema),
  crossProjectExperiences: z.array(CrossProjectExperienceSchema),
}).superRefine((store, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const unique = (ids: string[], label: string) => {
    if (new Set(ids).size !== ids.length) fail(`Duplicate ${label} ID`);
  };
  unique(store.groups.map(g => g.id), 'group');
  unique(store.canvases.map(c => c.id), 'canvas');
  unique(store.crossProjectExperiences.map(e => e.id), 'experience');
  const canvasIds = new Set(store.canvases.map(c => c.id));
  const experienceIds = new Set(store.crossProjectExperiences.map(e => e.id));
  if (store.activeCanvasId && !canvasIds.has(store.activeCanvasId)) fail('Active canvas does not exist');
  for (const c of store.canvases) {
    if (!store.groups.some(g => g.id === c.groupId)) fail('Canvas group does not exist');
    unique(c.nodes.map(n => n.id), 'node');
    unique(c.edges.map(e => e.id), 'edge');
    unique(c.stages.map(s => s.id), 'stage');
    unique(c.stages.map(s => String(s.stageNumber)), 'stage number');
    unique([...c.nodes.map(n => n.id), ...c.stages.map(s => s.id),
      ...c.stages.flatMap(s => Object.values(s.clusters).map(cl => cl.id)),
      ...(c.finalZone ? [c.finalZone.id] : [])], 'canvas entity');
    if (!c.stages.some(s => s.stageNumber === c.currentStageNumber)) fail('Current stage does not exist');
    const nodes = new Map(c.nodes.map(n => [n.id, n]));
    const endpoints = new Set([...nodes.keys(), ...c.stages.map(s => s.id),
      ...c.stages.flatMap(s => Object.values(s.clusters).map(cl => cl.id))]);
    const memberships: string[] = [];
    for (const stage of c.stages) {
      if ((stage.status === 'consolidated') !== (stage.consolidatedAt !== null)) fail('Invalid checkpoint timestamp');
      for (const category of CATEGORY_ORDER) {
        const cluster = stage.clusters[category];
        if (cluster.category !== category) fail('Cluster category mismatch');
        for (const id of cluster.nodeIds) {
          const node = nodes.get(id);
          if (!node || node.zone !== 'stage' || node.category !== category || node.stageNumber !== stage.stageNumber)
            fail('Invalid cluster node reference');
          memberships.push(id);
        }
        if (cluster.summaryNodeId && (!cluster.nodeIds.includes(cluster.summaryNodeId) ||
          nodes.get(cluster.summaryNodeId)?.kind !== 'stage_summary')) fail('Invalid category summary reference');
      }
    }
    const finalIds = c.finalZone ? [...c.finalZone.confirmedPractices, ...c.finalZone.coreImplementations] : [];
    for (const id of finalIds) if (nodes.get(id)?.zone !== 'final') fail('Invalid final node reference');
    memberships.push(...finalIds);
    unique(memberships, 'node membership');
    if (memberships.length !== c.nodes.length) fail('Every node must belong to exactly one container');
    for (const n of c.nodes) {
      if (n.canvasId !== c.id) fail('Node canvas mismatch');
      if (n.sourceNodeIds.some(id => !nodes.has(id))) fail('Missing source node');
      if (n.sourceExperienceId && !experienceIds.has(n.sourceExperienceId)) fail('Missing source experience');
    }
    for (const e of c.edges) if (e.canvasId !== c.id || !endpoints.has(e.source) || !endpoints.has(e.target)) fail('Dangling edge');
    if (c.finalZone?.reusablePatterns.some(id => !experienceIds.has(id))) fail('Missing reusable pattern');
  }
  for (const e of store.crossProjectExperiences) {
    const source = store.canvases.find(c => c.id === e.sourceCanvasId);
    if (!source || e.sourceNodeIds.some(id => !source.nodes.some(n => n.id === id))) fail('Missing experience provenance');
    if (e.appliedCanvasIds.some(id => !canvasIds.has(id))) fail('Missing experience target');
  }
});
export type Store = z.infer<typeof StoreSchema>;
