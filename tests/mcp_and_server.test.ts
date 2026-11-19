import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { CanvasEngine } from '../src/core/engine.js';
import { atomicWriteFile } from '../src/core/storage.js';
import { createMcpServer } from '../src/mcp/server.js';
import { invokeTool, listTools, MCP_RESOURCES, readResource, ToolInvocationError } from '../src/mcp/tools.js';
import { startHttpServer } from '../src/server/app.js';
import { CanvasGroupSchema, CanvasSchema, CanvasNodeSchema, CATEGORY_ORDER, CrossProjectExperienceSchema,
  FinalDistillationZoneSchema, HandoffPackageSchema, StageZoneSchema, StoreSchema } from '../src/types/schema.js';
import type { Store } from '../src/types/schema.js';

const expectedTools = ['manage_canvas_group', 'create_or_switch_canvas', 'record_project_learning',
  'consolidate_current_stage', 'advance_project_stage', 'finalize_project_distillation',
  'get_handoff_context', 'query_cross_project_experiences', 'apply_experience_to_canvas'];

function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'canvas-stage2-'));
  const cleanup: (() => void | Promise<void>)[] = [];
  const engine = new CanvasEngine({ dataDir, seedDemo: false });
  t.after(async () => {
    try { for (const close of cleanup.reverse()) await close(); }
    finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
  return { dataDir, engine, cleanup };
}

type Invoke = (name: string, args?: Record<string, unknown>) => unknown | Promise<unknown>;

/** The same complete workflow runs through direct invocation and the real MCP protocol. */
async function lifecycle(call: Invoke, engine: CanvasEngine) {
  assert.deepEqual(await call('manage_canvas_group', { action: 'list' }), []);
  const group = CanvasGroupSchema.parse(await call('manage_canvas_group', {
    action: 'create', name: 'Engineering', description: 'Keep this description', color: '#123456', icon: 'layers',
  }));
  const updated = CanvasGroupSchema.parse(await call('manage_canvas_group', { action: 'update', groupId: group.id, name: 'Platform' }));
  assert.equal(updated.name, 'Platform');
  assert.equal(updated.description, group.description);
  assert.equal(updated.color, group.color);
  assert.equal(updated.icon, group.icon);
  const canvas = CanvasSchema.parse(await call('create_or_switch_canvas', {
    action: 'create', groupId: group.id, title: 'Source project', projectKey: 'source', stageTitle: 'Foundation',
  }));
  const cases = [
    ['Add pagination', 'Implemented cursor pagination for the export endpoint.', 'feature_impl'],
    ['Coding conventions', 'Always use strict TypeScript. Never commit secrets.', 'convention_practice'],
    ['Layered architecture', 'Define data models and module boundaries.', 'architecture_design'],
    ['Fix a race condition', 'The root cause was concurrent replacement of the cache.', 'pitfall_fix'],
    ['Proven recovery pattern', 'This best practice was verified during recovery drills.', 'best_practice'],
  ] as const;
  const originals = [];
  for (const [title, content, category] of cases) {
    const node = CanvasNodeSchema.parse(await call('record_project_learning', {
      title, content, tags: ['shared'], relatedFiles: ['src/service.ts'], importance: 5, validated: true,
    }));
    assert.equal(node.category, category);
    assert.equal(node.stageNumber, 1);
    assert.equal(node.canvasId, canvas.id);
    assert.ok(engine.getCanvas().stages[0]!.clusters[category].nodeIds.includes(node.id));
    originals.push(node);
  }
  const unvalidated = CanvasNodeSchema.parse(await call('record_project_learning', {
    title: 'Candidate practice', content: 'Needs verification', category: 'best_practice',
  }));
  const checkpoint = StageZoneSchema.parse(await call('consolidate_current_stage', {
    advanceToNextStage: true, nextStageTitle: 'Validation',
  }));
  assert.equal(checkpoint.status, 'consolidated');
  for (const category of CATEGORY_ORDER) assert.ok(checkpoint.clusters[category].summaryNodeId);
  assert.equal(engine.getCanvas().currentStageNumber, 2);
  assert.equal(engine.getCanvas().stages[1]!.title, 'Validation');
  const reviewed = CanvasNodeSchema.parse(await call('record_project_learning', {
    title: 'Reviewed convention', content: 'Require review before promotion.', category: 'convention_practice',
  }));
  const advanced = StageZoneSchema.parse(await call('advance_project_stage', { title: 'Release' }));
  assert.equal(advanced.stageNumber, 3);
  assert.equal(advanced.status, 'in_progress');
  const final = FinalDistillationZoneSchema.parse(await call('finalize_project_distillation', {
    validatedNodeIds: [reviewed.id], summary: 'Validated release guidance',
  }));
  assert.ok(final.confirmedPractices.length > 0);
  assert.ok(final.coreImplementations.length > 0);
  assert.equal(final.reusablePatterns.length, 6);
  assert.deepEqual(await call('finalize_project_distillation'), final);
  const handoff = HandoffPackageSchema.parse(await call('get_handoff_context'));
  assert.equal(handoff.project.status, 'completed');
  assert.equal(handoff.stages.length, 3);
  assert.match(handoff.markdown, /Validated release guidance/);
  assert.match(handoff.markdown, /Candidate practice/);
  assert.equal(readFileSync(join(engine.storage.handoffDir, `HANDOFF-${canvas.id}.md`), 'utf8'), handoff.markdown);
  const experiences = z.array(CrossProjectExperienceSchema).parse(await call('query_cross_project_experiences'));
  assert.equal(experiences.length, 6);
  assert.ok(!experiences.some(item => item.sourceNodeIds.includes(unvalidated.id)));
  assert.equal(z.array(CrossProjectExperienceSchema).parse(await call('query_cross_project_experiences', {
    query: 'LAYERED architecture', category: 'architecture_design', tags: ['SHARED'], limit: 1,
  })).length, 1);
  assert.deepEqual(await call('query_cross_project_experiences', { excludeCanvasId: canvas.id }), []);
  const successor = CanvasSchema.parse(await call('create_or_switch_canvas', {
    action: 'create', groupId: group.id, title: 'Successor', projectKey: 'successor',
  }));
  const experience = experiences.find(item => item.category === 'architecture_design')!;
  const imported = CanvasNodeSchema.parse(await call('apply_experience_to_canvas', { experienceId: experience.id }));
  assert.equal(imported.canvasId, successor.id);
  assert.equal(imported.sourceExperienceId, experience.id);
  assert.equal(imported.category, 'architecture_design');
  assert.equal(imported.validated, false);
  assert.deepEqual(await call('apply_experience_to_canvas', { experienceId: experience.id }), imported);
  assert.equal(HandoffPackageSchema.parse(await call('get_handoff_context')).appliedExperiences[0]!.id, experience.id);
  const switched = CanvasSchema.parse(await call('create_or_switch_canvas', { action: 'switch', canvasId: canvas.id }));
  assert.equal(switched.id, canvas.id);
  assert.equal(engine.storage.read().activeCanvasId, canvas.id);
  // Explicit targets work independently of global active selection.
  assert.equal(CanvasNodeSchema.parse(await call('record_project_learning', {
    canvasId: successor.id, title: 'Targeted feature', content: 'Implemented a route.',
  })).canvasId, successor.id);
  assert.equal(originals.length, 5);
  return { canvas, successor, group };
}

test('all nine tools execute a complete project lifecycle via the programmatic helper', async t => {
  const { engine } = fixture(t);
  assert.deepEqual(listTools().map(tool => tool.name), expectedTools);
  for (const tool of listTools()) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 20);
  }
  await lifecycle((name, args) => invokeTool(engine, name, args), engine);
});

test('MCP protocol discovers and invokes all tools and reads every resource', async t => {
  const { engine, cleanup } = fixture(t);
  const server = createMcpServer(engine);
  const client = new Client({ name: 'stage2-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanup.push(() => server.close(), () => client.close());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), expectedTools);
  assert.ok(client.getServerCapabilities()?.resources);
  await lifecycle(async (name, args) => {
    const response = await client.callTool({ name, arguments: args ?? {} });
    assert.ok(!response.isError, JSON.stringify(response));
    const content = z.array(z.object({ type: z.literal('text'), text: z.string() })).parse(response.content);
    const result: unknown = JSON.parse(content[0]!.text);
    assert.deepEqual(response.structuredContent, { result });
    return result;
  }, engine);
  assert.deepEqual((await client.listResources()).resources, [...MCP_RESOURCES]);
  for (const resource of MCP_RESOURCES) {
    const actual = await client.readResource({ uri: resource.uri });
    assert.deepEqual(actual, readResource(engine, resource.uri));
    const text = z.string().parse(actual.contents[0]!.text);
    if (resource.mimeType === 'text/markdown') assert.equal(text, engine.getHandoffContext().markdown);
    else if (resource.uri.endsWith('.json')) HandoffPackageSchema.parse(JSON.parse(text));
    else assert.equal(z.array(CrossProjectExperienceSchema).parse(JSON.parse(text)).length, 6);
  }
  const invalid = await client.callTool({ name: 'record_project_learning', arguments: { title: '' } });
  assert.equal(invalid.isError, true);
  const conflict = await client.callTool({ name: 'advance_project_stage' });
  assert.equal(conflict.isError, true);
  await assert.rejects(client.callTool({ name: 'missing' }), /Unknown tool/);
  await assert.rejects(client.readResource({ uri: 'canvas://missing' }), /Unknown resource/);
});

test('invalid arguments and domain failures leave store unchanged and return typed errors', t => {
  const { engine } = fixture(t);
  const invalid: [string, unknown][] = [
    ['manage_canvas_group', { action: 'create' }],
    ['manage_canvas_group', { action: 'update', name: 'x' }],
    ['manage_canvas_group', { action: 'destroy' }],
    ['create_or_switch_canvas', { action: 'create', title: 'x' }],
    ['create_or_switch_canvas', { action: 'switch' }],
    ['record_project_learning', { title: 'x', content: 'y', category: 'wrong' }],
    ['record_project_learning', { title: 'x', content: 'y', importance: 6 }],
    ['record_project_learning', { title: 'x', content: 'y', validated: 'true' }],
    ['consolidate_current_stage', { advanceToNextStage: 'true' }],
    ['advance_project_stage', { title: ' ' }],
    ['finalize_project_distillation', { validatedNodeIds: ['../escape'] }],
    ['get_handoff_context', { extra: true }],
    ['query_cross_project_experiences', { limit: 0 }],
    ['apply_experience_to_canvas', {}],
    ['get_handoff_context', null],
  ];
  const before = readFileSync(engine.storage.storePath, 'utf8');
  for (const [name, args] of invalid) assert.throws(() => invokeTool(engine, name, args),
    (error: unknown) => error instanceof ToolInvocationError && error.status === 400, name);
  assert.throws(() => invokeTool(engine, 'missing'), (error: unknown) => error instanceof ToolInvocationError && error.status === 404);
  assert.throws(() => invokeTool(engine, 'get_handoff_context'), /Canvas not found/);
  assert.throws(() => readResource(engine, 'canvas://active/handoff.md'), /Canvas not found/);
  assert.deepEqual(JSON.parse(readResource(engine, 'canvas://global/experiences').contents[0]!.text), []);
  assert.equal(readFileSync(engine.storage.storePath, 'utf8'), before);
});

async function httpFixture(t: TestContext) {
  const setup = fixture(t);
  const webDir = join(setup.dataDir, 'web');
  mkdirSync(webDir);
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Stage 3 fixture</title>', 'utf8');
  writeFileSync(join(webDir, 'app.js'), 'export const ready = true;', 'utf8');
  const errors: unknown[] = [];
  const errorEvents = new EventEmitter();
  const runtime = await startHttpServer({ engine: setup.engine, webDir, port: 0, onError: error => {
    errors.push(error);
    errorEvents.emit('reported', error);
  } });
  setup.cleanup.push(() => runtime.stop());
  const address = runtime.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (method: string, path: string, input?: unknown, status = 200): Promise<unknown> => {
    const response = await fetch(`${base}${path}`, { method,
      ...(input === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
    });
    const value: unknown = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  return { ...setup, runtime, base, request, errors, errorEvents };
}

test('REST endpoints cover groups, canvases, learnings, checkpoints, distillation, handoff, reuse, and direct MCP calls', async t => {
  const { request, base, engine, errors } = await httpFixture(t);
  assert.deepEqual(await request('GET', '/api/groups'), []);
  const group = CanvasGroupSchema.parse(await request('POST', '/api/groups', { name: 'Web group', color: '#ff0000', icon: 'web' }, 201));
  const updated = CanvasGroupSchema.parse(await request('PATCH', `/api/groups/${group.id}`, { name: 'Updated' }));
  assert.equal(updated.icon, 'web');
  assert.equal(updated.color, '#ff0000');
  const canvas = CanvasSchema.parse(await request('POST', '/api/canvases', { groupId: group.id, title: 'Web project', projectKey: 'web' }, 201));
  assert.equal(z.array(CanvasSchema).parse(await request('GET', `/api/canvases?groupId=${group.id}`)).length, 1);
  assert.deepEqual(await request('GET', '/api/canvases?groupId=absent'), []);
  assert.equal(CanvasSchema.parse(await request('GET', `/api/canvases/${canvas.id}`)).id, canvas.id);
  assert.equal(CanvasSchema.parse(await request('GET', '/api/canvases/active')).id, canvas.id);
  const node = CanvasNodeSchema.parse(await request('POST', '/api/learnings', {
    title: 'Proven recovery pattern', content: 'This best practice was verified during recovery drills.',
    validated: true, tags: ['recovery', 'shared'],
  }, 201));
  assert.equal(node.category, 'best_practice');
  const feature = CanvasNodeSchema.parse(await request('POST', `/api/canvases/${canvas.id}/learnings`, {
    title: 'Implemented endpoint', content: 'Implemented recovery endpoint.', category: 'feature_impl', importance: 5,
  }, 201));
  assert.equal(StageZoneSchema.parse(await request('POST', `/api/canvases/${canvas.id}/stages/consolidate`, {
    advanceToNextStage: true, nextStageTitle: 'Checks',
  })).status, 'consolidated');
  assert.equal(StageZoneSchema.parse(await request('POST', '/api/stages/advance', { title: 'Release' })).stageNumber, 3);
  assert.equal(StageZoneSchema.parse(await request('POST', '/api/stages/consolidate', {})).status, 'consolidated');
  assert.equal(StageZoneSchema.parse(await request('POST', `/api/canvases/${canvas.id}/stages/advance`, {})).stageNumber, 4);
  const final = FinalDistillationZoneSchema.parse(await request('POST', `/api/canvases/${canvas.id}/distill`, {
    validatedNodeIds: [feature.id], summary: 'Web release complete',
  }));
  assert.equal(final.reusablePatterns.length, 2);
  assert.deepEqual(await request('POST', '/api/distill', {}), final);
  const handoff = HandoffPackageSchema.parse(await request('GET', '/api/handoff'));
  assert.equal(handoff.project.canvasId, canvas.id);
  assert.deepEqual(await request('GET', `/api/canvases/${canvas.id}/handoff?format=json`), handoff);
  assert.deepEqual(await request('GET', `/api/handoff?canvasId=${canvas.id}`), handoff);
  for (const path of ['/api/handoff.md', '/api/handoff?format=markdown', `/api/canvases/${canvas.id}/handoff.md`, `/api/canvases/${canvas.id}/handoff?format=markdown`]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /text\/markdown/);
    assert.equal(await response.text(), handoff.markdown);
  }
  const experiences = z.array(CrossProjectExperienceSchema).parse(await request('GET', '/api/experiences?query=recovery&category=best_practice&tags=recovery,shared&limit=1'));
  assert.equal(experiences.length, 1);
  assert.equal(z.array(CrossProjectExperienceSchema).parse(await request('GET', '/api/experiences?tags=recovery&tags=shared')).length, 1);
  assert.deepEqual(await request('GET', `/api/experiences?excludeCanvasId=${canvas.id}`), []);
  const successor = CanvasSchema.parse(await request('POST', '/api/canvases', { groupId: group.id, title: 'Next web project', projectKey: 'web-next' }, 201));
  const imported = CanvasNodeSchema.parse(await request('POST', '/api/experiences/apply', { experienceId: experiences[0]!.id }, 201));
  assert.equal(imported.canvasId, successor.id);
  assert.deepEqual(await request('POST', `/api/canvases/${successor.id}/experiences/apply`, { experienceId: experiences[0]!.id }, 201), imported);
  await request('POST', `/api/canvases/${canvas.id}/switch`, {});
  assert.equal(StoreSchema.parse(await request('GET', '/api/state')).activeCanvasId, canvas.id);
  assert.deepEqual(await request('GET', '/api/mcp/tools'), { tools: listTools() });
  assert.deepEqual(await request('POST', '/api/mcp/call', { name: 'get_handoff_context' }), { result: engine.getHandoffContext() });
  const direct = z.object({ result: CanvasNodeSchema }).parse(await request('POST', '/api/mcp/call', {
    name: 'record_project_learning', arguments: { canvasId: successor.id, title: 'Direct MCP route', content: 'Implemented direct invocation.' },
  }));
  assert.equal(direct.result.canvasId, successor.id);
  const staticPage = await fetch(base);
  assert.match(await staticPage.text(), /Stage 3 fixture/);
  assert.match(await (await fetch(`${base}/app.js`)).text(), /export const ready/);
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  assert.deepEqual(errors, []);
});

test('HTTP rejects invalid JSON, input, conflicts, missing resources, and store lock without mutation', async t => {
  const { request, base, engine, dataDir, errors } = await httpFixture(t);
  const cases: [string, string, unknown, number, string][] = [
    ['POST', '/api/groups', {}, 400, 'INVALID_ARGUMENTS'],
    ['POST', '/api/groups', { name: 'x', unexpected: true }, 400, 'INVALID_ARGUMENTS'],
    ['PATCH', '/api/groups/missing', { name: 'x' }, 404, 'NOT_FOUND'],
    ['GET', '/api/canvases/missing', undefined, 404, 'NOT_FOUND'],
    ['POST', '/api/canvases/missing/switch', {}, 404, 'NOT_FOUND'],
    ['POST', '/api/learnings', { title: 'x', content: 'y' }, 404, 'NOT_FOUND'],
    ['POST', '/api/stages/advance', { title: ' ' }, 400, 'INVALID_ARGUMENTS'],
    ['GET', '/api/handoff?format=xml', undefined, 400, 'INVALID_ARGUMENTS'],
    ['GET', '/api/experiences?limit=NaN', undefined, 400, 'INVALID_ARGUMENTS'],
    ['GET', '/api/experiences?category=wrong', undefined, 400, 'INVALID_ARGUMENTS'],
    ['GET', '/api/canvases?groupId=a&groupId=b', undefined, 400, 'INVALID_ARGUMENTS'],
    ['POST', '/api/mcp/call', { name: 'missing' }, 404, 'UNKNOWN_TOOL'],
    ['POST', '/api/mcp/call', { name: 'get_handoff_context', arguments: [] }, 400, 'INVALID_ARGUMENTS'],
    ['GET', '/api/missing', undefined, 404, 'NOT_FOUND'],
  ];
  const before = readFileSync(engine.storage.storePath, 'utf8');
  for (const [method, path, input, status, code] of cases) {
    const failure = z.object({ error: z.object({ code: z.string() }) }).parse(await request(method, path, input, status));
    assert.equal(failure.error.code, code);
  }
  for (const [payload, status] of [['{invalid', 400], [JSON.stringify({ name: 'x'.repeat(1024 * 1024) }), 413]] as const) {
    const response = await fetch(`${base}/api/groups`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
    assert.equal(response.status, status);
    assert.ok((await response.json() as { error: unknown }).error);
  }
  assert.equal(readFileSync(engine.storage.storePath, 'utf8'), before);
  const group = CanvasGroupSchema.parse(await request('POST', '/api/groups', { name: 'x' }, 201));
  await request('POST', '/api/canvases', { groupId: group.id, title: 'x', projectKey: 'x' }, 201);
  await request('POST', '/api/canvases', { groupId: group.id, title: 'duplicate', projectKey: 'x' }, 409);
  await request('POST', '/api/stages/consolidate', {});
  await request('POST', '/api/learnings', { title: 'x', content: 'y' }, 409);
  await request('POST', '/api/distill', { validatedNodeIds: ['missing'] }, 400);
  const lockPath = join(dataDir, 'store.lock');
  writeFileSync(lockPath, '{}');
  try {
    const busy = z.object({ error: z.object({ code: z.string() }) }).parse(await request('POST', '/api/stages/advance', {}, 503));
    assert.equal(busy.error.code, 'STORE_BUSY');
  } finally { rmSync(lockPath); }
  assert.deepEqual(errors, []);
});

async function eventStream(base: string) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const next = async (): Promise<Store> => {
    const timer = setTimeout(() => controller.abort(new Error('Timed out waiting for SSE snapshot')), 8000);
    try {
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (!frame.includes('event: canvas-update')) continue;
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          assert.ok(data);
          return StoreSchema.parse(JSON.parse(data.slice(6)));
        }
        const chunk = await reader.read();
        assert.ok(!chunk.done, 'SSE connection ended before an update');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    } finally { clearTimeout(timer); }
  };
  return { next, async close() { controller.abort(); await reader.cancel().catch(() => {}); } };
}

test('real stdio MCP writes reach every SSE client repeatedly after atomic replacement, and reconnect returns current state', { timeout: 25_000 }, async t => {
  const { base, engine, dataDir, cleanup, request, runtime, errors } = await httpFixture(t);
  const group = engine.createGroup({ name: 'SSE group' });
  const canvas = engine.createCanvas({ groupId: group.id, title: 'Live project', projectKey: 'live' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', 'tsx', resolve('src/mcp/server.ts')],
    env: { ...getDefaultEnvironment(), DATA_DIR: dataDir }, stderr: 'pipe',
  });
  let diagnostics = '';
  transport.stderr?.on('data', chunk => { diagnostics += String(chunk); });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  cleanup.push(() => client.close());
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), expectedTools);
  const streams = await Promise.all([eventStream(base), eventStream(base)]);
  for (const stream of streams) cleanup.push(() => stream.close());
  for (const stream of streams) assert.equal((await stream.next()).activeCanvasId, canvas.id);
  for (let i = 0; i < 3; i++) {
    const title = `External feature ${i}`;
    const result = await client.callTool({ name: 'record_project_learning', arguments: { title, content: 'Implemented external live synchronization.' } });
    assert.ok(!result.isError);
    for (const stream of streams) {
      let snapshot: Store;
      do { snapshot = await stream.next(); } while (!snapshot.canvases[0]!.nodes.some(node => node.title === title));
      assert.equal(snapshot.canvases[0]!.nodes.filter(node => node.kind === 'learning').length, i + 1);
    }
  }
  const resource = await client.readResource({ uri: 'canvas://active/handoff.md' });
  assert.match(z.object({ text: z.string() }).parse(resource.contents[0]).text, /External feature 2/);
  await request('POST', '/api/learnings', { title: 'HTTP feature', content: 'Implemented live HTTP mutation.' }, 201);
  for (const stream of streams) assert.ok((await stream.next()).canvases[0]!.nodes.some(node => node.title === 'HTTP feature'));
  await streams[0]!.close();
  const reconnected = await eventStream(base);
  cleanup.push(() => reconnected.close());
  assert.equal((await reconnected.next()).canvases[0]!.nodes.length, 4);
  await client.close();
  assert.equal(diagnostics, '');
  assert.deepEqual(errors, []);
  // Stop while subscribers remain connected: disposer must end SSE and release the watcher.
  await runtime.stop();
  await runtime.stop();
});

test('watcher preserves the last valid snapshot through an invalid external store and recovers', { timeout: 15_000 }, async t => {
  const { base, engine, cleanup, errors, request, errorEvents } = await httpFixture(t);
  const stream = await eventStream(base);
  cleanup.push(() => stream.close());
  await stream.next();
  const saved = readFileSync(engine.storage.storePath, 'utf8');
  const reported = once(errorEvents, 'reported', { signal: AbortSignal.timeout(3000) });
  atomicWriteFile(engine.storage.storePath, '{broken');
  await reported; // Observe the watcher's failure, independently of HTTP reads.
  await request('GET', '/api/state', undefined, 500);
  atomicWriteFile(engine.storage.storePath, saved);
  const group = engine.createGroup({ name: 'Recovered' });
  assert.equal((await stream.next()).groups[0]!.id, group.id);
  assert.ok(errors.length >= 1);
});
