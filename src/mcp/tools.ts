import { z } from 'zod';
import { CanvasEngine, CanvasInputSchema, GroupInputSchema, GroupPatchSchema } from '../core/engine.js';
import { IdSchema, LearningInputSchema, NodeCategorySchema } from '../types/schema.js';

export const CHINESE_POLICY = '【强制中文规范】所有写入画布的标题、内容、阶段总结与好用法必须使用简体中文。标签、说明与面向用户的输出也必须使用简体中文。';

const text = z.string().trim().min(1);
const canvasId = IdSchema.optional().describe('省略时使用已保存的当前活动画布。');

export class ToolInvocationError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, cause?: unknown) {
    super(message, { cause });
    this.name = 'ToolInvocationError';
  }
}

/** Keep transport errors stable without exposing filesystem paths on internal failures. */
export function invocationError(error: unknown): ToolInvocationError {
  if (error instanceof ToolInvocationError) return error;
  const message = error instanceof Error ? error.message : '未知错误';
  if (/^未找到(分组|画布|经验|学习记录)/.test(message))
    return new ToolInvocationError('NOT_FOUND', message, 404);
  if (message.startsWith('存储正在写入'))
    return new ToolInvocationError('STORE_BUSY', '存储正在写入，请稍后重试。', 503);
  if (/^(项目标识已存在|画布已|当前阶段已整理|只能引入其他项目)/.test(message))
    return new ToolInvocationError('CONFLICT', message, 409);
  if (message.startsWith('无法验证')) return new ToolInvocationError('INVALID_ARGUMENTS', message, 400);
  if (message.startsWith('数据已保存'))
    return new ToolInvocationError('HANDOFF_SYNC_FAILED', '数据已保存，但交接文档同步失败。请重新启动以重建文档。', 500, error);
  return new ToolInvocationError('INTERNAL_ERROR', '操作未完成，请查看服务诊断信息。', 500, error);
}

export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ToolInvocationError('INVALID_ARGUMENTS', `输入参数不符合要求：${parsed.error.issues.map(issue => issue.path.join('.')).filter(Boolean).join('、') || '请检查字段类型与必填项'}`, 400);
  return parsed.data;
}

// Zod optional fields permit explicit undefined; core option interfaces omit those keys.
function defined<T extends object>(input: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}

function tool<S extends z.ZodType>(name: string, description: string, schema: S,
  run: (engine: CanvasEngine, input: z.output<S>) => unknown, readOnly = false) {
  return {
    name, description: `${description}\n${CHINESE_POLICY}`, schema: schema.describe(CHINESE_POLICY), readOnly,
    invoke(engine: CanvasEngine, input: unknown): unknown { return run(engine, parseInput(schema, input)); },
  };
}

const groupSchema = GroupPatchSchema.extend({
  action: z.enum(['create', 'list', 'update']), groupId: IdSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.action === 'create' && !input.name) ctx.addIssue({ code: 'custom', path: ['name'], message: '创建分组时必须填写名称' });
  if (input.action === 'update' && !input.groupId) ctx.addIssue({ code: 'custom', path: ['groupId'], message: '更新分组时必须提供分组标识' });
});
const canvasSchema = CanvasInputSchema.partial().extend({
  action: z.enum(['create', 'switch']), canvasId: IdSchema.optional(),
}).strict().superRefine((input, ctx) => {
  for (const key of input.action === 'create' ? ['groupId', 'title', 'projectKey'] as const : ['canvasId'] as const) {
    if (!input[key]) ctx.addIssue({ code: 'custom', path: [key], message: `缺少必填参数：${key}` });
  }
});

export const TOOL_DEFINITIONS = [
  tool('manage_canvas_group', '创建、列出或更新画布分组。创建时填写名称，更新时提供分组标识和变更字段。', groupSchema,
    (engine, { action, groupId, ...fields }) => {
      if (action === 'list') return engine.listGroups();
      if (action === 'update') return engine.updateGroup(groupId!, defined(fields));
      return engine.createGroup(parseInput(GroupInputSchema, fields));
    }),
  tool('create_or_switch_canvas', '创建并激活画布，或按画布标识切换当前项目。名称、描述和阶段标题使用简体中文。', canvasSchema,
    (engine, { action, canvasId: target, ...fields }) => action === 'switch'
      ? engine.switchCanvas(target!) : engine.createCanvas(parseInput(CanvasInputSchema, fields))),
  tool('record_project_learning', '在当前阶段记录学习成果、功能实现与规定做法。省略分类时自动归类，经过实际验证后才能标记为已验证。',
    LearningInputSchema.extend({ canvasId }).strict(),
    (engine, { canvasId: target, ...input }) => engine.recordLearning(input, target)),
  tool('consolidate_current_stage', '按类别整理当前阶段，并可选择直接开启下一阶段。下一阶段名称使用简体中文。',
    z.object({ canvasId, advanceToNextStage: z.boolean().optional(), nextStageTitle: text.optional() }).strict(),
    (engine, { canvasId: target, ...options }) => engine.consolidateStage(target, defined(options))),
  tool('advance_project_stage', '整理当前阶段并开启下一阶段及其分类区域。',
    z.object({ canvasId, title: text.optional() }).strict(),
    (engine, input) => engine.advanceStage(input.canvasId, input.title)),
  tool('finalize_project_distillation', '完成项目，提炼已验证的约定、好用法和核心实现，并发布跨项目经验。只确认已经审阅的原始记录。',
    z.object({ canvasId, validatedNodeIds: z.array(IdSchema).optional(), summary: text.optional() }).strict(),
    (engine, { canvasId: target, ...options }) => engine.finalizeProjectDistillation(target, defined(options))),
  tool('get_handoff_context', '新会话首先调用本工具，获取完整中文交接：项目背景、约定、阶段历史、待办和原始依据。',
    z.object({ canvasId }).strict(), (engine, input) => engine.getHandoffContext(input.canvasId), true),
  tool('query_cross_project_experiences', '按关键词、分类与标签检索已验证的跨项目经验，所有关键词和标签均需匹配。',
    z.object({ query: z.string().optional(), category: NodeCategorySchema.optional(), tags: z.array(text).optional(),
      excludeCanvasId: IdSchema.optional(), limit: z.number().int().min(1).max(1000).optional() }).strict(),
    (engine, input) => engine.queryCrossProjectExperiences(defined(input)), true),
  tool('apply_experience_to_canvas', '将其他项目的好用法引入当前画布。保留来源，并在新项目中重新验证。',
    z.object({ canvasId, experienceId: IdSchema }).strict(),
    (engine, input) => engine.applyExperienceToCanvas(input.experienceId, input.canvasId)),
] as const;

export function listTools() {
  return TOOL_DEFINITIONS.map(({ name, description, schema, readOnly }) => {
    const inputSchema = { ...z.toJSONSchema(schema, { io: 'input' }), type: 'object' as const };
    const describe = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      if (record.properties && typeof record.properties === 'object') {
        for (const property of Object.values(record.properties)) {
          const field = property as Record<string, unknown>;
          field.description = `${field.description ?? '标识与枚举按协议填写；自然语言内容使用简体中文。'} ${CHINESE_POLICY}`;
        }
      }
      for (const child of Object.values(record)) describe(child);
    };
    describe(inputSchema);
    return { name, description, inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } };
  });
}

/** Shared synchronous entry point: raw domain result on success, typed error on failure. */
export function invokeTool(engine: CanvasEngine, name: string, args: unknown = {}): unknown {
  const definition = TOOL_DEFINITIONS.find(item => item.name === name);
  if (!definition) throw new ToolInvocationError('UNKNOWN_TOOL', `未找到工具： ${name}`, 404);
  try { return definition.invoke(engine, args); }
  catch (error) { throw invocationError(error); }
}

export const MCP_RESOURCES = [
  { uri: 'canvas://active/handoff.md', name: 'active_canvas_handoff', description: '当前画布的中文交接文档。', mimeType: 'text/markdown' },
  { uri: 'canvas://active/handoff.json', name: 'active_canvas_handoff_json', description: '当前画布的完整结构化交接。', mimeType: 'application/json' },
  { uri: 'canvas://global/experiences', name: 'global_experience_catalog', description: '所有已验证的跨项目经验，不分页。', mimeType: 'application/json' },
] as const;

export function readResource(engine: CanvasEngine, uri: string) {
  const resource = MCP_RESOURCES.find(item => item.uri === uri);
  if (!resource) throw new ToolInvocationError('UNKNOWN_RESOURCE', `未找到资源： ${uri}`, 404);
  try {
    const text = uri === 'canvas://global/experiences' ? JSON.stringify(engine.storage.read().crossProjectExperiences, null, 2)
      : uri === 'canvas://active/handoff.md' ? engine.getHandoffContext().markdown : JSON.stringify(engine.getHandoffContext(), null, 2);
    return { contents: [{ uri, mimeType: resource.mimeType, text }] };
  } catch (error) { throw invocationError(error); }
}
