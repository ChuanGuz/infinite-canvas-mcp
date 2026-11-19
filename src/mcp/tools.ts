import { z } from 'zod';
import { CanvasEngine, CanvasInputSchema, GroupInputSchema, GroupPatchSchema } from '../core/engine.js';
import { IdSchema, LearningInputSchema, NodeCategorySchema } from '../types/schema.js';

const text = z.string().trim().min(1);
const canvasId = IdSchema.optional().describe('Omit to use the persisted active canvas.');

export class ToolInvocationError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, cause?: unknown) {
    super(message, { cause });
    this.name = 'ToolInvocationError';
  }
}

/** Keep transport errors stable without exposing filesystem paths on internal failures. */
export function invocationError(error: unknown): ToolInvocationError {
  if (error instanceof ToolInvocationError) return error;
  const message = error instanceof Error ? error.message : 'Unknown error';
  if (/^(Group|Canvas|Experience|Learning) not found:/.test(message))
    return new ToolInvocationError('NOT_FOUND', message, 404);
  if (message.startsWith('Store is locked:'))
    return new ToolInvocationError('STORE_BUSY', 'Store is busy; retry the operation.', 503);
  if (/^(Project key already exists|Canvas is |Current stage is consolidated|Experience must come)/.test(message))
    return new ToolInvocationError('CONFLICT', message, 409);
  if (message.startsWith('Cannot validate')) return new ToolInvocationError('INVALID_ARGUMENTS', message, 400);
  if (message.startsWith('Store committed,'))
    return new ToolInvocationError('HANDOFF_SYNC_FAILED', 'Store committed, but handoff synchronization failed. Restart to rebuild Markdown mirrors.', 500, error);
  return new ToolInvocationError('INTERNAL_ERROR', 'The operation failed; inspect the server diagnostics.', 500, error);
}

export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ToolInvocationError('INVALID_ARGUMENTS', parsed.error.message, 400);
  return parsed.data;
}

// Zod optional fields permit explicit undefined; core option interfaces omit those keys.
function defined<T extends object>(input: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}

function tool<S extends z.ZodType>(name: string, description: string, schema: S,
  run: (engine: CanvasEngine, input: z.output<S>) => unknown, readOnly = false) {
  return {
    name, description, schema, readOnly,
    invoke(engine: CanvasEngine, input: unknown): unknown { return run(engine, parseInput(schema, input)); },
  };
}

const groupSchema = GroupPatchSchema.extend({
  action: z.enum(['create', 'list', 'update']), groupId: IdSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.action === 'create' && !input.name) ctx.addIssue({ code: 'custom', path: ['name'], message: 'name is required for create' });
  if (input.action === 'update' && !input.groupId) ctx.addIssue({ code: 'custom', path: ['groupId'], message: 'groupId is required for update' });
});
const canvasSchema = CanvasInputSchema.partial().extend({
  action: z.enum(['create', 'switch']), canvasId: IdSchema.optional(),
}).strict().superRefine((input, ctx) => {
  for (const key of input.action === 'create' ? ['groupId', 'title', 'projectKey'] as const : ['canvasId'] as const) {
    if (!input[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required for ${input.action}` });
  }
});

export const TOOL_DEFINITIONS = [
  tool('manage_canvas_group', 'Create, list, or update canvas groups. create requires name; update requires groupId and changed fields.', groupSchema,
    (engine, { action, groupId, ...fields }) => {
      if (action === 'list') return engine.listGroups();
      if (action === 'update') return engine.updateGroup(groupId!, defined(fields));
      return engine.createGroup(parseInput(GroupInputSchema, fields));
    }),
  tool('create_or_switch_canvas', 'Create and activate a canvas (groupId, title, projectKey), or switch the active canvas (canvasId).', canvasSchema,
    (engine, { action, canvasId: target, ...fields }) => action === 'switch'
      ? engine.switchCanvas(target!) : engine.createCanvas(parseInput(CanvasInputSchema, fields))),
  tool('record_project_learning', 'Record learned, implemented, or agreed knowledge in the current stage. Omit category for automatic classification into the five knowledge categories. Only mark validated after verification.',
    LearningInputSchema.extend({ canvasId }).strict(),
    (engine, { canvasId: target, ...input }) => engine.recordLearning(input, target)),
  tool('consolidate_current_stage', 'Organize the current stage into category summaries and optionally open the next stage.',
    z.object({ canvasId, advanceToNextStage: z.boolean().optional(), nextStageTitle: text.optional() }).strict(),
    (engine, { canvasId: target, ...options }) => engine.consolidateStage(target, defined(options))),
  tool('advance_project_stage', 'Consolidate the current stage and explicitly open the next stage zone and its category clusters.',
    z.object({ canvasId, title: text.optional() }).strict(),
    (engine, input) => engine.advanceStage(input.canvasId, input.title)),
  tool('finalize_project_distillation', 'Complete the project, synthesize validated practices, conventions, and core implementations into the Final Distillation Zone, and publish reusable patterns globally. validatedNodeIds explicitly confirms reviewed original findings.',
    z.object({ canvasId, validatedNodeIds: z.array(IdSchema).optional(), summary: text.optional() }).strict(),
    (engine, { canvasId: target, ...options }) => engine.finalizeProjectDistillation(target, defined(options))),
  tool('get_handoff_context', 'Call first in a new AI session: return the complete structured project handoff including its Markdown document, conventions, stage history, unresolved work, and provenance.',
    z.object({ canvasId }).strict(), (engine, input) => engine.getHandoffContext(input.canvasId), true),
  tool('query_cross_project_experiences', 'Search validated cross-project practices and patterns by keywords, category, and tags. All query words and tags must match.',
    z.object({ query: z.string().optional(), category: NodeCategorySchema.optional(), tags: z.array(text).optional(),
      excludeCanvasId: IdSchema.optional(), limit: z.number().int().min(1).max(1000).optional() }).strict(),
    (engine, input) => engine.queryCrossProjectExperiences(defined(input)), true),
  tool('apply_experience_to_canvas', 'Import a proven pattern from another project into the active canvas. Preserve provenance; imported guidance needs validation in the new context.',
    z.object({ canvasId, experienceId: IdSchema }).strict(),
    (engine, input) => engine.applyExperienceToCanvas(input.experienceId, input.canvasId)),
] as const;

export function listTools() {
  return TOOL_DEFINITIONS.map(({ name, description, schema, readOnly }) => ({
    name, description, inputSchema: { ...z.toJSONSchema(schema, { io: 'input' }), type: 'object' as const },
    annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
  }));
}

/** Shared synchronous entry point: raw domain result on success, typed error on failure. */
export function invokeTool(engine: CanvasEngine, name: string, args: unknown = {}): unknown {
  const definition = TOOL_DEFINITIONS.find(item => item.name === name);
  if (!definition) throw new ToolInvocationError('UNKNOWN_TOOL', `Unknown tool: ${name}`, 404);
  try { return definition.invoke(engine, args); }
  catch (error) { throw invocationError(error); }
}

export const MCP_RESOURCES = [
  { uri: 'canvas://active/handoff.md', name: 'active_canvas_handoff', description: 'Current active canvas handoff Markdown.', mimeType: 'text/markdown' },
  { uri: 'canvas://active/handoff.json', name: 'active_canvas_handoff_json', description: 'Complete structured active canvas handoff.', mimeType: 'application/json' },
  { uri: 'canvas://global/experiences', name: 'global_experience_catalog', description: 'All validated cross-project experiences, without search pagination.', mimeType: 'application/json' },
] as const;

export function readResource(engine: CanvasEngine, uri: string) {
  const resource = MCP_RESOURCES.find(item => item.uri === uri);
  if (!resource) throw new ToolInvocationError('UNKNOWN_RESOURCE', `Unknown resource: ${uri}`, 404);
  try {
    const text = uri === 'canvas://global/experiences' ? JSON.stringify(engine.storage.read().crossProjectExperiences, null, 2)
      : uri === 'canvas://active/handoff.md' ? engine.getHandoffContext().markdown : JSON.stringify(engine.getHandoffContext(), null, 2);
    return { contents: [{ uri, mimeType: resource.mimeType, text }] };
  } catch (error) { throw invocationError(error); }
}
