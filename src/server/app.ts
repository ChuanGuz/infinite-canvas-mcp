import { watch } from 'node:fs';
import { createServer } from 'node:http';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import type { ErrorRequestHandler, Request, Response } from 'express';
import { z } from 'zod';
import { CanvasEngine } from '../core/engine.js';
import type { EngineOptions } from '../core/engine.js';
import { IdSchema } from '../types/schema.js';
import { invokeTool, invocationError, listTools, parseInput, ToolInvocationError } from '../mcp/tools.js';

export interface AppOptions extends EngineOptions {
  engine?: CanvasEngine;
  webDir?: string;
  onError?: (error: unknown) => void;
}

const bodySchema = z.record(z.string(), z.unknown());
const queryString = z.string().optional();
const body = (req: Request) => parseInput(bodySchema, req.body ?? {});
const target = (req: Request): string | undefined => req.params.canvasId === 'active' ? undefined
  : parseInput(IdSchema.optional(), req.params.canvasId);

/** Creates an embeddable app plus an explicit disposer for its watcher and SSE clients. */
export function createApp(options: AppOptions = {}) {
  const engine = options.engine ?? new CanvasEngine({
    dataDir: options.dataDir ?? process.env.DATA_DIR ?? resolve('data'), seedDemo: options.seedDemo ?? true,
  });
  const onError = options.onError ?? ((error: unknown) => console.error(error));
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  const clients = new Set<Response>();
  let closed = false;
  let revision = 0;
  let lastSnapshot = JSON.stringify(engine.storage.read());
  let pending: NodeJS.Timeout | undefined;
  const send = (client: Response, snapshot: string) => {
    // Bound queued data for disconnected or stalled consumers; reconnect supplies a full snapshot.
    if (client.writableLength > 4 * 1024 * 1024) { clients.delete(client); client.destroy(); return; }
    client.write(`id: ${revision}\nevent: canvas-update\ndata: ${snapshot}\n\n`);
  };
  const publish = () => {
    if (closed) return;
    try {
      const snapshot = JSON.stringify(engine.storage.read());
      if (snapshot === lastSnapshot) return;
      lastSnapshot = snapshot;
      revision += 1;
      for (const client of clients) send(client, snapshot);
    } catch (error) { onError(error); }
  };
  // Watching the directory survives atomic rename-over-store.json on Windows and Unix.
  const watcher = watch(engine.storage.dataDir, (_event, filename) => {
    if (filename !== null && filename.toString() !== basename(engine.storage.storePath)) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(publish, 20);
  });
  watcher.on('error', onError);
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (client.writableLength > 4 * 1024 * 1024) { clients.delete(client); client.destroy(); }
      else client.write(': heartbeat\n\n');
    }
  }, 15_000);
  heartbeat.unref();

  app.get('/api/events', (_req, res) => {
    const snapshot = JSON.stringify(engine.storage.read());
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 1000\n\n');
    clients.add(res);
    send(res, snapshot);
    res.on('close', () => clients.delete(res));
  });

  const call = (name: string, args: unknown) => {
    const result = invokeTool(engine, name, args);
    publish();
    return result;
  };
  app.get('/api/state', (_req, res) => res.json(engine.storage.read()));
  app.get('/api/groups', (_req, res) => res.json(call('manage_canvas_group', { action: 'list' })));
  app.post('/api/groups', (req, res) => res.status(201).json(call('manage_canvas_group', { ...body(req), action: 'create' })));
  app.patch('/api/groups/:groupId', (req, res) => res.json(call('manage_canvas_group', { ...body(req), action: 'update', groupId: req.params.groupId })));
  app.get('/api/canvases', (req, res) => res.json(engine.listCanvases(parseInput(IdSchema.optional(), req.query.groupId))));
  app.get('/api/canvases/:canvasId', (req, res) => res.json(engine.getCanvas(target(req))));
  app.post('/api/canvases', (req, res) => res.status(201).json(call('create_or_switch_canvas', { ...body(req), action: 'create' })));
  app.post('/api/canvases/:canvasId/switch', (req, res) => res.json(call('create_or_switch_canvas', {
    ...body(req), action: 'switch', canvasId: req.params.canvasId,
  })));

  const mutations = [
    ['learnings', 'record_project_learning', 201],
    ['stages/consolidate', 'consolidate_current_stage', 200],
    ['stages/advance', 'advance_project_stage', 200],
    ['distill', 'finalize_project_distillation', 200],
    ['experiences/apply', 'apply_experience_to_canvas', 201],
  ] as const;
  for (const [path, name, status] of mutations) {
    app.post(`/api/${path}`, (req, res) => res.status(status).json(call(name, body(req))));
    app.post(`/api/canvases/:canvasId/${path}`, (req, res) => res.status(status).json(call(name, { ...body(req), canvasId: target(req) })));
  }
  for (const path of ['/api/handoff', '/api/canvases/:canvasId/handoff']) {
    app.get(path, (req, res) => {
      const format = parseInput(z.enum(['json', 'markdown']).default('json'), req.query.format);
      const canvasId = target(req) ?? parseInput(IdSchema.optional(), req.query.canvasId);
      const handoff = engine.getHandoffContext(canvasId);
      if (format === 'markdown') res.type('text/markdown').send(handoff.markdown);
      else res.json(handoff);
    });
    app.get(`${path}.md`, (req, res) => res.type('text/markdown').send(engine.getHandoffContext(
      target(req) ?? parseInput(IdSchema.optional(), req.query.canvasId)).markdown));
  }
  app.get('/api/experiences', (req, res) => {
    const rawTags = parseInput(z.union([z.string(), z.array(z.string())]).optional(), req.query.tags);
    const rawLimit = parseInput(queryString, req.query.limit);
    res.json(call('query_cross_project_experiences', {
      query: parseInput(queryString, req.query.query), category: req.query.category,
      tags: rawTags === undefined ? undefined : (Array.isArray(rawTags) ? rawTags : rawTags.split(',')).map(tag => tag.trim()),
      excludeCanvasId: req.query.excludeCanvasId, limit: rawLimit === undefined ? undefined : Number(rawLimit),
    }));
  });
  app.get('/api/mcp/tools', (_req, res) => res.json({ tools: listTools() }));
  app.post('/api/mcp/call', (req, res) => {
    const input = parseInput(z.object({ name: z.string().min(1), arguments: bodySchema.optional() }).strict(), req.body);
    res.json({ result: call(input.name, input.arguments ?? {}) });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API endpoint' } }));
  // The same source assets work under tsx and dist/src/server/app.js after a build.
  const defaultWebDir = fileURLToPath(new URL(import.meta.url.includes('/dist/src/') ? '../../../src/web/' : '../web/', import.meta.url));
  app.use(express.static(options.webDir ?? defaultWebDir));
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const type = (error as { type?: string } | null)?.type;
    const failure = type === 'entity.parse.failed' ? new ToolInvocationError('INVALID_JSON', 'Request body must be valid JSON.', 400)
      : type === 'entity.too.large' ? new ToolInvocationError('PAYLOAD_TOO_LARGE', 'Request body exceeds 1 MB.', 413)
      : invocationError(error);
    if (failure.status === 500) onError(error);
    if (!res.headersSent) res.status(failure.status).json({ error: { code: failure.code, message: failure.message } });
    else res.end();
  };
  app.use(errorHandler);

  const close = () => {
    if (closed) return;
    closed = true;
    watcher.close();
    if (pending) clearTimeout(pending);
    clearInterval(heartbeat);
    for (const client of clients) client.end();
    clients.clear();
  };
  return { app, engine, close };
}

export async function startHttpServer(options: AppOptions & { port?: number; host?: string } = {}) {
  const port = parseInput(z.number().int().min(0).max(65535), options.port ?? Number(process.env.PORT ?? 3456));
  const runtime = createApp(options);
  const server = createServer(runtime.app);
  server.once('close', runtime.close);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, options.host ?? process.env.HOST ?? '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) { runtime.close(); throw error; }
  let stopping: Promise<void> | undefined;
  return { ...runtime, server, stop() {
    if (!stopping) {
      runtime.close();
      stopping = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    return stopping;
  } };
}

export async function runHttpServer() {
  const runtime = await startHttpServer();
  const address = runtime.server.address();
  console.log(`Infinite Canvas HTTP server: http://${typeof address === 'object' && address ? `${address.address}:${address.port}` : address}`);
  const shutdown = () => { runtime.stop().catch(error => { console.error(error); process.exitCode = 1; }); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return runtime;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runHttpServer().catch(error => { console.error(error); process.exitCode = 1; });
}
