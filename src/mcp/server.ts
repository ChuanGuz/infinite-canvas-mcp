import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema,
  ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { CanvasEngine } from '../core/engine.js';
import { invokeTool, invocationError, listTools, MCP_RESOURCES, readResource } from './tools.js';

/** No transport or filesystem side effects until the factory is called. */
export function createMcpServer(engine: CanvasEngine = new CanvasEngine({ dataDir: process.env.DATA_DIR ?? resolve('data') })) {
  // Low-level Server keeps discovery, validation, and execution identical to the HTTP registry.
  const server = new Server({ name: 'infinite-canvas-mcp', version: '0.1.0' }, {
    capabilities: { tools: {}, resources: {} },
    instructions: '新会话先调用 get_handoff_context 接续项目。所有写入画布的标题、内容、标签、阶段总结与好用法必须使用简体中文。推进过程中持续记录，阶段结束时整理，验证成果后再进行项目结尾总整理。',
  });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listTools() }));
  server.setRequestHandler(CallToolRequestSchema, request => {
    try {
      const result = invokeTool(engine, request.params.name, request.params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } };
    } catch (error) {
      const failure = invocationError(error);
      if (failure.status === 500) console.error(failure);
      if (failure.code === 'UNKNOWN_TOOL') throw new McpError(ErrorCode.InvalidParams, failure.message);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: failure.code, message: failure.message } }) }] };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [...MCP_RESOURCES] }));
  server.setRequestHandler(ReadResourceRequestSchema, request => {
    try { return readResource(engine, request.params.uri); }
    catch (error) {
      const failure = invocationError(error);
      if (failure.status === 500) console.error(failure);
      throw new McpError(failure.status === 404 ? ErrorCode.InvalidParams : ErrorCode.InternalError, failure.message);
    }
  });
  return server;
}

export async function startMcpServer() {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startMcpServer().catch(error => { console.error(error); process.exitCode = 1; });
}
