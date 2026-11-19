import { existsSync, mkdirSync, readFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'smol-toml';
import type { TomlTable } from 'smol-toml';
import { CanvasEngine } from '../core/engine.js';
import { atomicWriteFile } from '../core/storage.js';
import { ToolInvocationError } from '../mcp/tools.js';

export const PROVIDERS = ['codex', 'claude', 'gemini', 'deepseek'] as const;
export type Provider = typeof PROVIDERS[number];
export interface ConnectOptions { mcpHomeDir?: string; mcpProjectRoot?: string }
const labels = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini', deepseek: 'DeepSeek' };
const descriptions = {
  codex: '自动注册本机助手工具配置，重启客户端后读取当前项目交接。',
  claude: '生成标准本地工具配置，导入支持工具协议的客户端后接续项目。',
  gemini: '生成命令行客户端可用的本地工具配置，导入后读取项目上下文。',
  deepseek: '生成兼容客户端配置；纯网页版可阅读交接内容，但不能直接访问本机服务。',
};

export function connectionBundle(engine: CanvasEngine, canvasId?: string, options: ConnectOptions = {}) {
  const root = options.mcpProjectRoot ?? fileURLToPath(new URL(import.meta.url.includes('/dist/src/') ? '../../../' : '../../', import.meta.url));
  const settings = { command: process.execPath,
    args: [resolve(root, 'node_modules/tsx/dist/cli.mjs'), resolve(root, 'src/mcp/server.ts')],
    env: { DATA_DIR: engine.storage.dataDir } };
  const json = JSON.stringify({ mcpServers: { infinite_canvas: settings } }, null, 2);
  const toml = stringify({ mcp_servers: { infinite_canvas: settings } });
  const context = canvasId || engine.storage.read().activeCanvasId ? engine.getHandoffContext(canvasId) : null;
  const cliCommand = `& '${settings.command.replaceAll("'", "''")}' ${settings.args.map(arg => `'${arg.replaceAll("'", "''")}'`).join(' ')}`;
  const providers = Object.fromEntries(PROVIDERS.map(id => {
    const configSnippet = id === 'codex' ? toml : json;
    const aiPrompt = [
      `请作为 ${labels[id]} 接续我的无限画布项目，全程使用简体中文。`,
      `本地项目目录：${resolve(root)}`, `本地工具启动命令（终端）：${cliCommand}`,
      `数据目录：${engine.storage.dataDir}`,
      context ? `当前画布：${context.project.title}\n当前阶段：阶段 ${context.currentStage.stageNumber} · ${context.currentStage.title}` : '当前尚无画布，请先创建分组和画布。',
      '我们规定的做法：',
      ...(context?.conventions.map(n => `- ${n.title}：${n.content}`) ?? []),
      '- 所有写入画布的标题、内容、标签、阶段总结与好用法必须使用简体中文。',
      '- 新会话先调用 get_handoff_context 获取最新状态；完成工作后调用 record_project_learning，阶段结束后整理。',
      context ? `- 本次操作明确指定 canvasId：${context.project.canvasId}，避免其他会话切换画布后写入错误项目。` : '',
      '连接配置：', configSnippet,
      id === 'codex' ? '自动配置后请重启客户端或重新加载工具服务。' : '请将以上配置合并到支持本地工具协议的客户端配置中，保留其他已有设置，然后重新加载客户端。',
      '粘贴指令本身不会授予本机访问权限。纯网页版或不支持本地工具的客户端只能阅读以下交接内容；请勿声称已经连接或写回画布。',
      '完整中文项目交接：', context?.markdown ?? '暂无交接记录。',
    ].filter(Boolean).join('\n\n');
    return [id, { id, label: labels[id], description: descriptions[id], aiPrompt, configSnippet, cliCommand }];
  })) as Record<Provider, { id: Provider; label: string; description: string; aiPrompt: string; configSnippet: string; cliCommand: string }>;
  return { providers, canvasId: context?.project.canvasId ?? null, settings, root };
}

/** Parse before mutation, preserve unrelated values, and keep the exact original as a backup. */
export function registerCodex(home: string, settings: ReturnType<typeof connectionBundle>['settings']): void {
  const dir = join(home, '.codex');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.toml');
  const lock = `${path}.infinite-canvas.lock`;
  let fd: number;
  try { fd = openSync(lock, 'wx'); }
  catch { throw new ToolInvocationError('CONFIG_BUSY', '客户端配置正在修改，请稍后重试。', 409); }
  try {
    const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
    let config: TomlTable;
    try { config = parse(before); }
    catch { throw new ToolInvocationError('INVALID_CONFIG', '现有客户端配置无法解析，已保留原文件，请修复后重试。', 409); }
    const servers = config.mcp_servers;
    if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers)))
      throw new ToolInvocationError('INVALID_CONFIG', '现有工具配置结构不正确，已保留原文件。', 409);
    const table = (config.mcp_servers ??= {}) as TomlTable;
    const current = table.infinite_canvas;
    if (current !== undefined && (!current || typeof current !== 'object' || Array.isArray(current)))
      throw new ToolInvocationError('INVALID_CONFIG', '已有无限画布配置结构不正确，已保留原文件。', 409);
    const previous = (current ?? {}) as TomlTable;
    if (previous.env !== undefined && (!previous.env || typeof previous.env !== 'object' || Array.isArray(previous.env)))
      throw new ToolInvocationError('INVALID_CONFIG', '现有环境配置结构不正确，已保留原文件。', 409);
    table.infinite_canvas = { ...previous, ...settings, env: { ...(previous.env as TomlTable ?? {}), ...settings.env } };
    // Preserve comments and all other sections for normal table-style configurations.
    const section = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;
    let managed = false;
    const kept = before.split(/\r?\n/).filter(line => {
      const match = line.match(section);
      if (match) managed = /^mcp_servers\.infinite_canvas(?:\.|$)/.test(match[1]!.trim());
      return !managed;
    }).join('\n');
    const candidate = `${kept.trimEnd()}\n\n${stringify({ mcp_servers: { infinite_canvas: table.infinite_canvas } })}`;
    const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
    let output = stringify(config);
    try { if (canonical(parse(candidate)) === canonical(config)) output = candidate; } catch { /* Inline or quoted tables use semantic serialization. */ }
    parse(output);
    if (canonical(parse(before)) === canonical(config)) return;
    if (before) atomicWriteFile(`${path}.backup-${Date.now()}`, before);
    atomicWriteFile(path, output);
  } finally { closeSync(fd); unlinkSync(lock); }
}

export function quickConnect(engine: CanvasEngine, provider: Provider | 'all', canvasId?: string, options: ConnectOptions = {}) {
  const bundle = connectionBundle(engine, canvasId, options);
  const selected = provider === 'all' ? PROVIDERS : [provider];
  if (selected.includes('codex')) registerCodex(options.mcpHomeDir ?? homedir(), bundle.settings);
  const dir = join(engine.storage.dataDir, 'mcp-configs');
  mkdirSync(dir, { recursive: true });
  for (const id of selected) atomicWriteFile(join(dir, `${id}-mcp-config.${id === 'codex' ? 'toml' : 'json'}`), bundle.providers[id].configSnippet);
  atomicWriteFile(join(bundle.root, 'mcp-config.json'), bundle.providers.claude.configSnippet);
  return { ok: true, provider,
    message: selected.includes('codex') ? '已写入连接配置并注册本机 Codex，请重新加载客户端工具服务。' : '已生成本机连接配置文件，请导入对应客户端后重新加载工具服务。',
    aiPrompt: selected.map(id => bundle.providers[id].aiPrompt).join('\n\n'),
  };
}
