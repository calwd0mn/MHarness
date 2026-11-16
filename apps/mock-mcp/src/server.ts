import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import Ajv2020 from "ajv/dist/2020.js";

const inputSchema = { type: "object", properties: { text: { type: "string", minLength: 1 }, operationId: { type: "string", minLength: 1 } }, required: ["text", "operationId"], additionalProperties: false } as const;
const outputSchema = { type: "object", properties: { text: { type: "string" }, operationId: { type: "string" } }, required: ["text", "operationId"], additionalProperties: false } as const;
const validate = new Ajv2020().compile(inputSchema);

/**
 * 在本机启动独立模拟 MCP 服务；写效果仅保存在当前进程。
 * @param port - 监听端口，0 由系统分配。
 * @returns 服务地址、写效果快照和关闭接口；调用方负责关闭服务。
 * @throws 监听失败时 Promise 拒绝。
 */
export async function startMockMcp(port = 0): Promise<{ url: string; effects(): readonly string[]; close(): Promise<void> }> {
  const writes: string[] = [];
  const http = createServer(async (req, res) => {
    if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
    const server = new Server({ name: "mharness-mock", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [
      { name: "mock_read", description: "返回模拟文本", inputSchema },
      { name: "mock_write", description: "执行模拟写入", inputSchema, outputSchema },
    ] }));
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      const args = request.params.arguments;
      if (!validate(args) || !args || typeof args.text !== "string" || typeof args.operationId !== "string") return { isError: true, content: [{ type: "text", text: "参数校验失败。" }] };
      if (request.params.name === "mock_read") return { content: [{ type: "text", text: args.text }] };
      if (request.params.name === "mock_write") { writes.push(args.text); return { content: [{ type: "text", text: args.text }], structuredContent: { text: args.text, operationId: args.operationId } }; }
      return { isError: true, content: [{ type: "text", text: "工具不存在。" }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res); }
    catch { if (!res.headersSent) res.writeHead(500).end(); }
  });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(port, "127.0.0.1", () => { http.off("error", reject); resolve(); }); });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("模拟服务监听失败");
  return { url: `http://127.0.0.1:${address.port}/mcp`, effects: () => [...writes], close: () => new Promise<void>((resolve, reject) => { http.closeAllConnections(); http.close((error) => error ? reject(error) : resolve()); }) };
}
