import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { chromium, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startHttpServer } from '../src/server/app.js';
import { CATEGORY_ORDER } from '../src/types/schema.js';
import type { connectionBundle, Provider } from '../src/server/mcp-connect.js';

async function fixture(t: TestContext, seedDemo = false) {
  const dataDir = mkdtempSync(join(tmpdir(), 'canvas-stage3-'));
  const runtime = await startHttpServer({ dataDir, seedDemo, port: 0, mcpHomeDir: dataDir, mcpProjectRoot: dataDir });
  t.after(async () => {
    await runtime.stop();
    // Only remove the isolated directory created by this test, never project data.
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    rmSync(dataDir, { recursive: true, force: true });
  });
  const address = runtime.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await browser.close(); assert.deepEqual(errors, [], 'No uncaught browser exceptions'); });
  await page.goto(base);
  await expect(page.locator('#sync-status')).toHaveText('MCP 实时同步已连接');
  return { ...runtime, base, dataDir, browser, context, page };
}

async function submit(page: Page) {
  await page.locator('#form-submit').click();
  await expect(page.locator('#modal')).not.toBeVisible();
}
async function createCanvas(page: Page, title: string, projectKey: string) {
  await page.getByRole('button', { name: '新建画布', exact: true }).first().click();
  await page.getByLabel('画布名称', { exact: true }).fill(title);
  await page.getByLabel('项目唯一标识').fill(projectKey);
  await submit(page);
  await expect(page.locator('#project-title')).toHaveText(title);
}

test('production static assets and complete browser workflow connect REST, stdio MCP, SSE, reuse and handoff', { timeout: 90_000 }, async t => {
  const { page, base, engine, dataDir } = await fixture(t);
  for (const [path, type, text] of [['/', 'text/html', '无限画布'], ['/styles.css', 'text/css', '.node'], ['/app.js', 'javascript', 'EventSource']]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type')?.includes(type!));
    assert.ok((await response.text()).includes(text!));
  }
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  await expect(page.locator('#empty-state')).toBeVisible();
  await page.getByRole('button', { name: '新建分组', exact: true }).first().click();
  await page.getByLabel('分组名称').fill('产品研发');
  await page.getByLabel('分组颜色').fill('#88ccaa');
  await submit(page);
  await createCanvas(page, '端到端项目', 'browser-source');
  await expect(page.locator('.cluster')).toHaveCount(5);
  const sourceId = engine.getCanvas().id;
  const cases = [
    ['Coding conventions', 'Always use strict TypeScript. Never commit secrets.', 'convention_practice'],
    ['Layered architecture', 'Define data models and module boundaries.', 'architecture_design'],
    ['Add pagination', 'Implemented cursor pagination for the export endpoint.', 'feature_impl'],
    ['Fix a race condition', 'The root cause was concurrent replacement of the cache.', 'pitfall_fix'],
    ['Proven recovery pattern', 'This best practice was verified during recovery drills.', 'best_practice'],
  ] as const;
  for (const [title, content, category] of cases) {
    await page.locator('[data-action="record"]').click();
    await page.getByLabel('标题', { exact: true }).fill(title);
    await page.getByLabel('内容 / 学习记录').fill(content);
    await page.getByLabel('标签（逗号分隔）').fill('shared, browser');
    await page.getByLabel('重要程度（1–5）').fill('5');
    await page.getByLabel('已经过实践验证').check();
    await submit(page);
    const node = engine.getCanvas().nodes.find(n => n.title === title)!;
    assert.equal(node.category, category, 'Automatic classification reaches the correct cluster');
    await expect(page.locator(`[data-node="${node.id}"]`)).toHaveCSS('left', `${node.bounds.x}px`);
    await expect(page.locator(`[data-node="${node.id}"]`)).toHaveCSS('height', `${node.bounds.height}px`);
  }
  await page.locator('[data-action="consolidate"]').click();
  await page.getByLabel('整理后自动开启下一阶段').check();
  await page.getByLabel('下一阶段名称（可选）').fill('验证与交付');
  await submit(page);
  await expect(page.locator('#project-status')).toContainText('阶段 2');
  assert.equal(engine.getCanvas().stages[0]!.status, 'consolidated');
  for (const category of CATEGORY_ORDER) assert.ok(engine.getCanvas().stages[0]!.clusters[category].summaryNodeId);

  const client = new Client({ name: 'stage3-browser', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ['--import', 'tsx', resolve('src/mcp/server.ts')], env: { ...getDefaultEnvironment(), DATA_DIR: dataDir }, stderr: 'pipe',
  }));
  assert.equal((await client.listTools()).tools.length, 9);
  const external = await client.callTool({ name: 'record_project_learning', arguments: {
    canvasId: sourceId, title: 'Stage 2 agreed convention', content: 'Require review before promotion.', category: 'convention_practice',
  } });
  assert.ok(!external.isError);
  await expect(page.locator('.node h3').filter({ hasText: 'Stage 2 agreed convention' })).toHaveCount(1);
  await page.locator('[data-action="consolidate"]').click();
  await submit(page);
  assert.equal(engine.getCanvas().stages[1]!.status, 'consolidated');
  await expect(page.locator('[data-action="record"]')).toBeDisabled();
  await expect(page.locator('.zone .badge').filter({ hasText: '已整理归档' })).toHaveCount(2);
  assert.ok(engine.getCanvas().edges.some(e => e.type === 'evolution'));
  await page.locator('[data-action="finalize"]').click();
  await page.getByLabel('项目交接总结（可选）').fill('端到端验收完成，知识可交接。');
  await page.getByRole('checkbox', { name: 'Stage 2 agreed convention', exact: false }).check();
  await submit(page);
  await expect(page.locator('#project-status')).toContainText('已结项');
  await expect(page.locator('.zone.final')).toHaveCount(1);
  await expect(page.locator('.pattern')).toHaveCount(6);
  await expect(page.locator('.node.distillation')).toHaveCount(4);
  await expect(page.locator('[data-action="advance"]')).toBeDisabled();
  await expect(page.locator('.edge')).toHaveCount(engine.getCanvas().edges.length);
  assert.ok(engine.getCanvas().edges.some(e => e.type === 'distills'));

  await page.locator('[data-action="handoff"]').click();
  await expect(page.locator('#handoff-markdown')).toContainText('端到端验收完成');
  const markdown = engine.getHandoffContext().markdown;
  assert.equal(readFileSync(join(dataDir, 'handoffs', `HANDOFF-${sourceId}.md`), 'utf8'), markdown);
  await page.getByRole('button', { name: '复制交接文档' }).click();
  // Windows clipboard text uses CRLF even when the source document uses LF.
  assert.equal(String(await page.evaluate('navigator.clipboard.readText()')).replace(/\r\n/g, '\n'), markdown);
  await expect(page.locator('.provider-card')).toHaveCount(4);
  await page.locator('[data-action="copy-provider"][data-provider="codex"]').click();
  assert.match(String(await page.evaluate('navigator.clipboard.readText()')), /我们规定的做法/);
  await page.getByRole('button', { name: '关闭详情' }).click();
  await createCanvas(page, '经验继承项目', 'browser-successor');
  const successorId = engine.getCanvas().id;
  await page.getByLabel('搜索经验', { exact: true }).fill('Layered architecture');
  await page.getByLabel('经验分类').selectOption('architecture_design');
  await expect(page.locator('.experience-card')).toHaveCount(1);
  await page.getByRole('button', { name: '应用到当前画布 ↗' }).click();
  await expect(page.getByRole('button', { name: '✓ 已应用到当前画布' })).toBeDisabled();
  const imported = engine.getCanvas().nodes[0]!;
  assert.equal(imported.kind, 'imported');
  assert.equal(imported.validated, false);
  assert.ok(imported.sourceExperienceId);
  await page.locator('[data-action="handoff"]').click();
  await expect(page.locator('#handoff-markdown')).toContainText(imported.title);
  const result = await client.callTool({ name: 'get_handoff_context', arguments: { canvasId: successorId } });
  assert.ok(!result.isError);
  const resource = await client.readResource({ uri: 'canvas://active/handoff.md' });
  assert.ok(resource.contents[0] && 'text' in resource.contents[0]);
  assert.equal(resource.contents[0].text, engine.getHandoffContext().markdown);
  await page.getByRole('button', { name: '关闭详情' }).click();
  // The explicit Next Stage action also consolidates and opens a fresh zone.
  await page.locator('[data-action="advance"]').click();
  await page.getByLabel('下一阶段名称（可选）').fill('再次验证');
  await submit(page);
  await expect(page.locator('#project-status')).toContainText('阶段 2');
  await page.locator(`[data-canvas="${sourceId}"]`).click();
  await expect(page.locator('#project-title')).toHaveText('端到端项目');
  await page.locator(`[data-canvas="${successorId}"]`).click();
  await expect(page.locator('#project-title')).toHaveText('经验继承项目');
  await page.reload();
  await expect(page.locator('#project-title')).toHaveText('经验继承项目');
});

test('viewport pan, cursor anchored zoom, fit, stage jumps, inspection, filtering and responsive layout', { timeout: 45_000 }, async t => {
  const { page, engine } = await fixture(t, true);
  const canvas = engine.getCanvas();
  await expect(page.locator('.node')).toHaveCount(canvas.nodes.length);
  await expect(page.locator('.cluster')).toHaveCount(15);
  const transform = async () => page.locator('#world').evaluate(el => el.getAttribute('style'));
  const before = await transform();
  const rect = (await page.locator('#viewport').boundingBox())!;
  await page.mouse.move(rect.x + 10, rect.y + 10);
  await page.mouse.down();
  await page.mouse.move(rect.x + 80, rect.y + 60);
  await page.mouse.up();
  assert.notEqual(await transform(), before);
  const readView = async () => JSON.parse((await page.evaluate(id => localStorage.getItem(`canvas-view:${id}`), canvas.id))!);
  const v1 = await readView();
  const cursor = { x: Math.floor(rect.x + 200), y: Math.floor(rect.y + 120) };
  await page.mouse.move(cursor.x, cursor.y);
  await page.mouse.wheel(0, -200);
  await expect.poll(async () => (await readView()).zoom).toBeGreaterThan(v1.zoom);
  const v2 = await readView();
  const anchor = { x: cursor.x - rect.x, y: cursor.y - rect.y };
  assert.ok(Math.abs((anchor.x - v1.x) / v1.zoom - (anchor.x - v2.x) / v2.zoom) < 0.01);
  assert.ok(Math.abs((anchor.y - v1.y) / v1.zoom - (anchor.y - v2.y) / v2.zoom) < 0.01);
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await page.getByRole('button', { name: '缩小', exact: true }).click();
  await page.getByRole('button', { name: '适应全图', exact: true }).click();
  const allView = await transform();
  await page.locator(`[data-stage="${canvas.stages[0]!.id}"]`).click();
  assert.notEqual(await transform(), allView);
  const node = canvas.nodes.find(n => n.stageNumber === 1 && n.kind === 'learning')!;
  await page.locator(`[data-node="${node.id}"]`).click();
  await expect(page.locator('#drawer-title')).toHaveText(node.title);
  await expect(page.locator('.detail-content')).toHaveText(node.content);
  await page.keyboard.press('Escape');
  await expect(page.locator('#drawer')).not.toBeVisible();
  await page.locator('#viewport').focus();
  const keyboardBefore = await transform();
  await page.keyboard.press('ArrowRight');
  assert.notEqual(await transform(), keyboardBefore);
  await page.keyboard.press('f');
  const saved = await transform();
  await page.reload();
  await expect(page.locator('#world')).toHaveAttribute('style', saved!);
  const otherGroup = engine.listGroups().find(g => g.id !== canvas.groupId)!;
  await page.locator(`[data-group="${otherGroup.id}"]`).click();
  await expect(page.locator('#canvases [data-canvas]')).toHaveCount(engine.listCanvases(otherGroup.id).length);
  assert.equal(engine.getCanvas().id, canvas.id, 'Group filtering does not change active project');
  const completed = engine.listCanvases(otherGroup.id).find(c => c.finalZone)!;
  await page.locator(`[data-canvas="${completed.id}"]`).click();
  await page.getByRole('button', { name: '✧ 终局精华区', exact: true }).click();
  await expect(page.locator('.zone.final')).toBeVisible();
  await page.setViewportSize({ width: 800, height: 700 });
  assert.equal(await page.evaluate('document.documentElement.scrollWidth > window.innerWidth'), false);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate('document.documentElement.scrollWidth > window.innerWidth'), false);
  await expect(page.locator('[data-action="handoff"]')).toBeVisible();
  await expect(page.locator('#sidebar')).not.toBeVisible();
  await page.getByRole('button', { name: '☰ 画布导航' }).click();
  await expect(page.locator('#sidebar')).toBeVisible();
  await page.getByRole('button', { name: '关闭项目导航' }).click();
  await expect(page.locator('#sidebar')).not.toBeVisible();
});

test('four quick buttons and drawer cards configure and copy the pinned canvas, with clipboard fallback', { timeout: 45_000 }, async t => {
  const { page, base, engine, dataDir } = await fixture(t, true);
  const labels = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini', deepseek: 'DeepSeek' };
  const bundle = await (await fetch(`${base}/api/mcp/connect-bundle`)).json() as ReturnType<typeof connectionBundle>;
  for (const [provider, label] of Object.entries(labels)) {
    await page.locator(`#mcp-quick-bar [data-action="quick-ai"][data-provider="${provider}"]`).click();
    await expect(page.locator('#notice')).toHaveText(`已一键配置并复制【${label}】连接与交接指令！直接粘贴发给 ${label} 即可连接并继续项目。`);
    assert.equal(String(await page.evaluate('navigator.clipboard.readText()')).replace(/\r\n/g, '\n'), bundle.providers[provider as Provider].aiPrompt);
    assert.ok(readFileSync(join(dataDir, 'mcp-configs', `${provider}-mcp-config.${provider === 'codex' ? 'toml' : 'json'}`), 'utf8'));
  }
  await page.locator('[data-action="handoff"]').click();
  await expect(page.locator('.provider-cards-grid .provider-card')).toHaveCount(4);
  for (const provider of Object.keys(labels)) {
    await page.locator(`[data-action="copy-provider"][data-provider="${provider}"]`).click();
    await expect(page.locator('#notice')).toContainText('已复制');
    assert.equal(String(await page.evaluate('navigator.clipboard.readText()')).replace(/\r\n/g, '\n'), bundle.providers[provider as Provider].aiPrompt);
    await page.locator(`[data-action="configure-provider"][data-provider="${provider}"]`).click();
    await expect(page.locator('#notice')).toContainText(provider === 'codex' ? '注册本机 Codex' : '已生成本机连接配置');
  }
  assert.equal(await page.locator('#handoff-markdown').innerText(), engine.getHandoffContext().markdown);
  await page.getByRole('button', { name: '关闭详情' }).click();
  const bullets = await page.locator('.node').evaluateAll(nodes => nodes.map(n => n.querySelectorAll('li').length));
  assert.ok(bullets.every(n => n <= 2));
  await expect(page.locator('.node .tags')).toHaveCount(0);
  // Explicit target must survive an external active-canvas switch while configuration is pending.
  const pinned = engine.getCanvas();
  const other = engine.listCanvases()[1]!;
  await page.route('**/api/mcp/quick-connect', async route => {
    assert.equal(route.request().postDataJSON().canvasId, pinned.id);
    engine.switchCanvas(other.id);
    await route.continue();
  });
  await page.locator('[data-action="quick-ai"][data-provider="claude"]').click();
  await expect(page.locator('#notice')).toContainText('已一键配置并复制【Claude】');
  assert.ok(String(await page.evaluate('navigator.clipboard.readText()')).includes(pinned.title));
  await page.unroute('**/api/mcp/quick-connect');
  await page.evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', { value: async () => { throw new Error('denied'); } }); document.execCommand = () => false;`);
  await page.locator('[data-action="quick-ai"][data-provider="deepseek"]').click();
  await expect(page.getByRole('textbox', { name: '连接与交接指令', exact: true })).toBeVisible();
  assert.ok((await page.getByRole('textbox', { name: '连接与交接指令', exact: true }).inputValue()).includes('DeepSeek'));
  await expect(page.locator('#notice')).toContainText('自动复制未成功');
});

test('SSE reconnect, live drawer, safe text, server errors and in-flight form targets', { timeout: 45_000 }, async t => {
  const { page, base, engine, context } = await fixture(t, true);
  const original = engine.getCanvas();
  const post = async (path: string, data: unknown) => {
    const response = await fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    assert.ok(response.ok, await response.text());
  };
  await page.locator('[data-action="record"]').click();
  await page.getByLabel('标题', { exact: true }).fill('Pinned canvas record');
  await page.getByLabel('内容 / 学习记录').fill('<img src=x onerror="window.bad=true"> & literal text');
  const next = engine.createCanvas({ groupId: original.groupId, title: 'External switch', projectKey: 'external-switch' });
  await expect(page.locator('#project-title')).toHaveText('External switch');
  await submit(page);
  assert.ok(engine.getCanvas(original.id).nodes.some(n => n.title === 'Pinned canvas record'));
  assert.equal(engine.getCanvas(next.id).nodes.length, 0);
  await page.locator(`[data-canvas="${original.id}"]`).click();
  await expect(page.locator('#project-title')).toHaveText(original.title);
  assert.equal(await page.evaluate('window.bad'), undefined);
  await expect(page.locator('#world img')).toHaveCount(0);
  await page.locator('[data-action="handoff"]').click();
  await expect(page.locator('#handoff-markdown')).toContainText('Pinned canvas record');
  await post('mcp/call', { name: 'record_project_learning', arguments: { canvasId: original.id, title: 'Live drawer update', content: 'Implemented REST to MCP synchronization.' } });
  await expect(page.locator('#handoff-markdown')).toContainText('Live drawer update');
  await page.getByRole('button', { name: '关闭详情' }).click();
  // Losing the stream must show an honest connection state and recover the latest snapshot.
  await context.setOffline(true);
  await expect(page.locator('#sync-status')).toContainText('同步中断');
  await post('learnings', { canvasId: original.id, title: 'Offline change', content: 'Implemented while browser was offline.' });
  await context.setOffline(false);
  await expect(page.locator('#sync-status')).toHaveText('MCP 实时同步已连接', { timeout: 10_000 });
  await expect(page.locator('.node h3').filter({ hasText: 'Offline change' })).toHaveCount(1);
  // A conflicting project key preserves form contents and exposes the server error.
  await page.getByRole('button', { name: '新建画布', exact: true }).click();
  await page.getByLabel('画布名称', { exact: true }).fill('Duplicate');
  await page.getByLabel('项目唯一标识').fill(original.projectKey);
  await page.locator('#form-submit').click();
  await expect(page.locator('#form-error')).toContainText('项目标识已存在');
  await expect(page.getByLabel('画布名称', { exact: true })).toHaveValue('Duplicate');
  await page.getByLabel('项目唯一标识').fill('recovered-project');
  await submit(page);
  await expect(page.locator('#project-title')).toHaveText('Duplicate');
});
