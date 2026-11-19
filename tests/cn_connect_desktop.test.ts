import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from 'smol-toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CanvasEngine } from '../src/core/engine.js';
import { listTools, CHINESE_POLICY } from '../src/mcp/tools.js';
import { startHttpServer } from '../src/server/app.js';
import { connectionBundle, registerCodex, PROVIDERS } from '../src/server/mcp-connect.js';

test('all demo prose, derived labels, experiences and handoff documents are natural Chinese', t => {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-chinese-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const engine = new CanvasEngine({ dataDir: dir });
  const store = engine.storage.read();
  const chinese = (value: string) => {
    // Preserve the user's exact collaboration wording, including these product names.
    assert.doesNotMatch(value.replace(/\b(?:Codex|GitHub)\b/g, ''), /[a-zA-Z]|\?{2,}/, value);
    if (value) assert.match(value, /\p{Script=Han}/u, value);
  };
  for (const group of store.groups) [group.name, group.description].forEach(chinese);
  for (const canvas of store.canvases) {
    [canvas.title, canvas.description].forEach(chinese);
    for (const stage of canvas.stages) {
      [stage.title, stage.summary, ...Object.values(stage.clusters).map(c => c.title)].forEach(chinese);
    }
    for (const node of canvas.nodes) [node.title, node.content, ...node.summaryBullets, ...node.tags, ...node.reusablePatterns].forEach(chinese);
    for (const edge of canvas.edges) chinese(edge.label);
    if (canvas.finalZone) [canvas.finalZone.title, canvas.finalZone.handoffSummary].forEach(chinese);
    const handoff = engine.getHandoffContext(canvas.id);
    chinese(handoff.markdown);
    handoff.nextSteps.forEach(chinese);
    assert.equal(readFileSync(join(dir, 'handoffs', `HANDOFF-${canvas.id}.md`), 'utf8'), handoff.markdown);
  }
  for (const e of store.crossProjectExperiences) [e.title, e.content, ...e.tags, ...e.summaryBullets].forEach(chinese);
  for (const tool of listTools()) assert.ok(tool.description.includes(CHINESE_POLICY));
  // Existing user content, including historical non-Chinese records, must never be reset.
  engine.recordLearning({ title: 'Historical user evidence', content: 'Preserve this original.' });
  const before = readFileSync(engine.storage.storePath, 'utf8');
  new CanvasEngine({ dataDir: dir });
  assert.equal(readFileSync(engine.storage.storePath, 'utf8'), before);
});

test('four provider endpoints pin context, generate valid files, protect settings and reject foreign writes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-connect-'));
  const runtime = await startHttpServer({ dataDir: dir, port: 0, mcpHomeDir: dir, mcpProjectRoot: dir });
  t.after(async () => { await runtime.stop(); rmSync(dir, { recursive: true, force: true }); });
  const address = runtime.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (input: unknown, headers = {}) => fetch(`${base}/api/mcp/quick-connect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input),
  });
  const canvas = runtime.engine.getCanvas();
  const bundle = await (await fetch(`${base}/api/mcp/connect-bundle`)).json() as ReturnType<typeof connectionBundle>;
  assert.deepEqual(Object.keys(bundle.providers), PROVIDERS);
  for (const id of PROVIDERS) {
    const provider = bundle.providers[id];
    assert.equal(provider.id, id);
    assert.ok(provider.aiPrompt.includes(canvas.title));
    assert.ok(provider.aiPrompt.includes(canvas.stages[2]!.title));
    assert.ok(provider.aiPrompt.includes(canvas.id));
    assert.match(provider.aiPrompt, /我们规定的做法/);
    assert.match(provider.aiPrompt, /简体中文/);
    const config = id === 'codex' ? parse(provider.configSnippet) : JSON.parse(provider.configSnippet);
    assert.ok(id === 'codex' ? config.mcp_servers : config.mcpServers);
  }
  const other = runtime.engine.listCanvases()[1]!;
  const explicit = await (await fetch(`${base}/api/mcp/connect-bundle?canvasId=${other.id}`)).json() as ReturnType<typeof connectionBundle>;
  assert.equal(explicit.canvasId, other.id);
  assert.ok(explicit.providers.deepseek.aiPrompt.includes(other.title));
  assert.equal((await fetch(`${base}/api/mcp/connect-bundle?canvasId=missing`)).status, 404);
  assert.equal((await post({ provider: 'invalid' })).status, 400);
  assert.equal((await post({ provider: 'codex', canvasId: 'missing' })).status, 404);
  assert.equal((await post({ provider: 'codex' }, { Origin: 'https://example.com' })).status, 403);
  assert.equal(existsSync(join(dir, '.codex')), false);
  mkdirSync(join(dir, '.codex'));
  const path = join(dir, '.codex/config.toml');
  const original = '# 保留用户说明\nmodel = "my-model"\n[projects."E:\\\\work"]\ntrust_level = "trusted"\n[mcp_servers.other]\ncommand = "other.exe"\n[mcp_servers.infinite_canvas]\ncommand = "old.exe"\nenabled = true\n[mcp_servers.infinite_canvas.env]\nCUSTOM_SETTING = "preserve"\n';
  writeFileSync(path, original);
  const response = await post({ provider: 'all', canvasId: canvas.id });
  assert.equal(response.status, 200);
  const result = await response.json() as { ok: boolean; provider: string };
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'all');
  const updated = readFileSync(path, 'utf8');
  assert.match(updated, /# 保留用户说明/);
  const config = parse(updated) as any;
  assert.equal(config.model, 'my-model');
  assert.deepEqual(config.projects, (parse(original) as any).projects);
  assert.equal(config.mcp_servers.other.command, 'other.exe');
  assert.equal(config.mcp_servers.infinite_canvas.enabled, true);
  assert.equal(config.mcp_servers.infinite_canvas.env.CUSTOM_SETTING, 'preserve');
  assert.equal(config.mcp_servers.infinite_canvas.env.DATA_DIR, dir);
  assert.equal(readdirSync(join(dir, '.codex')).filter(f => f.includes('.backup-')).length, 1);
  const backup = readdirSync(join(dir, '.codex')).find(f => f.includes('.backup-'))!;
  assert.equal(readFileSync(join(dir, '.codex', backup), 'utf8'), original);
  assert.equal((await post({ provider: 'codex' })).status, 200);
  assert.equal(readFileSync(path, 'utf8'), updated, 'Repeated setup is idempotent');
  for (const id of PROVIDERS) {
    const file = join(dir, 'mcp-configs', `${id}-mcp-config.${id === 'codex' ? 'toml' : 'json'}`);
    assert.equal(readFileSync(file, 'utf8'), bundle.providers[id].configSnippet);
  }
  assert.ok(JSON.parse(readFileSync(join(dir, 'mcp-config.json'), 'utf8')).mcpServers.infinite_canvas);
  writeFileSync(path, '[invalid');
  assert.equal((await post({ provider: 'codex' })).status, 409);
  assert.equal(readFileSync(path, 'utf8'), '[invalid');
  assert.equal((await post({ provider: 'gemini' })).status, 200, 'Other providers do not mutate Codex');
});

test('Codex registration preserves inline and quoted TOML settings and respects writer locks', t => {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-toml-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const engine = new CanvasEngine({ dataDir: dir });
  const settings = connectionBundle(engine).settings;
  mkdirSync(join(dir, '.codex'));
  const path = join(dir, '.codex/config.toml');
  for (const content of ['mcp_servers = { other = { command = "keep" } }\n', '["mcp_servers"."infinite_canvas"]\ncommand = "old"\n["mcp_servers"."other"]\ncommand = "keep"']) {
    writeFileSync(path, content);
    registerCodex(dir, settings);
    const config = parse(readFileSync(path, 'utf8')) as any;
    assert.equal(config.mcp_servers.other.command, 'keep');
    assert.equal(config.mcp_servers.infinite_canvas.command, process.execPath);
  }
  const before = readFileSync(path, 'utf8');
  writeFileSync(`${path}.infinite-canvas.lock`, 'writer');
  assert.throws(() => registerCodex(dir, settings), /正在修改/);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('generated MCP command works outside the project working directory', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-command-'));
  const engine = new CanvasEngine({ dataDir: dir });
  const { settings } = connectionBundle(engine);
  const client = new Client({ name: 'configuration-check', version: '1.0.0' });
  t.after(async () => { await client.close(); rmSync(dir, { recursive: true, force: true }); });
  await client.connect(new StdioClientTransport({ ...settings, cwd: tmpdir(), env: { ...getDefaultEnvironment(), ...settings.env }, stderr: 'pipe' }));
  const result = await client.callTool({ name: 'get_handoff_context', arguments: { canvasId: engine.getCanvas().id } });
  assert.ok(!result.isError);
  assert.ok(JSON.stringify(result).includes(engine.getCanvas().title));
});

test('tracked desktop artifact is a Windows GUI executable with silent startup and app window source', () => {
  const exe = readFileSync(resolve('无限画布.exe'));
  assert.equal(exe.toString('ascii', 0, 2), 'MZ');
  const pe = exe.readUInt32LE(0x3c);
  assert.equal(exe.toString('ascii', pe, pe + 4), 'PE\0\0');
  assert.equal(exe.readUInt16LE(pe + 24 + 68), 2, 'IMAGE_SUBSYSTEM_WINDOWS_GUI');
  const source = readFileSync(resolve('src/desktop/Launcher.cs'), 'utf8');
  for (const text of ['CreateNoWindow = true', '--app=', '--user-data-dir=', '--window-size=1520,940', '/api/canvases', 'desktop_app_profile', 'AssignProcessToJobObject', 'WebBrowser']) assert.ok(source.includes(text));
});
