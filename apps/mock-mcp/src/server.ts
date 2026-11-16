import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import Ajv2020 from "ajv/dist/2020.js";
import { MockLedger } from "./ledger.ts";

const inputSchema = { type: "object", properties: { text: { type: "string", minLength: 1 }, operationId: { type: "string", minLength: 1 } }, required: ["text", "operationId"], additionalProperties: false } as const;
const outputSchema = { type: "object", properties: { text: { type: "string" }, operationId: { type: "string" } }, required: ["text", "operationId"], additionalProperties: false } as const;
const validate = new Ajv2020().compile(inputSchema);

/**
 * 在本机启动模拟 MCP 服务，并持有独立的效果与操作台账数据库。
 * @param port - 监听端口，0 由系统分配。
 * @param databasePath - SQLite 文件路径，默认使用临时内存数据库。
 * @param options - 可选故障注入；指定操作的首次成功写入响应（含已有结果）会在事务提交后丢失；每次传入配置启动都会重新生效。
 * @returns 服务地址、已提交效果快照和关闭接口；调用方负责关闭服务，关闭会等待已接收的请求处理结束。
 * @throws 数据库打开或监听失败时 Promise 拒绝。
 */
export async function startMockMcp(port = 0, databasePath = ":memory:", options: { dropResponseOnceForOperationId?: string } = {}): Promise<{ url: string; effects(): readonly string[]; close(): Promise<void> }> {
  const ledger = new MockLedger(databasePath);
  let dropResponseFor = options.dropResponseOnceForOperationId;
  const active = new Set<Promise<void>>();
  const http = createServer((req, res) => {
    const handling = (async () => {
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
      if (request.params.name === "mock_write") {
        const result = ledger.write(args.operationId, request.params.name, { text: args.text });
        if (!result) return { isError: true, content: [{ type: "text", text: "操作标识与已有工具或参数冲突。" }] };
        if (dropResponseFor === args.operationId) {
          dropResponseFor = undefined;
          res.destroy();
        }
        return result;
      }
      return { isError: true, content: [{ type: "text", text: "工具不存在。" }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res); }
    catch { if (!res.headersSent) res.writeHead(500).end(); }
    })();
    active.add(handling);
    void handling.then(() => active.delete(handling), () => active.delete(handling));
  });
  try {
    await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(port, "127.0.0.1", () => { http.off("error", reject); resolve(); }); });
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("模拟服务监听失败");
    let closing: Promise<void> | undefined;
    return { url: `http://127.0.0.1:${address.port}/mcp`, effects: () => ledger.effects(), close: () => closing ??= new Promise<void>((resolve, reject) => { http.close((error) => { void Promise.allSettled(active).then(() => { try { ledger.close(); } catch (closeError) { reject(closeError); return; } error ? reject(error) : resolve(); }); }); http.closeAllConnections(); }) };
  } catch (error) { ledger.close(); throw error; }
}
