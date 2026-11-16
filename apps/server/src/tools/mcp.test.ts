import assert from "node:assert/strict";
import { createServer } from "node:http";
import Ajv2020 from "ajv/dist/2020.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Session, SqliteSessionPersistence } from "@mharness/session/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../agent/manager.ts";
import { SessionCommandController } from "../commands.ts";
import { createModelTurnDriver } from "../agent/model-turn.ts";
import { createMockAdapter } from "../model/providers/mock.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { test } from "node:test";
import { startMockMcp } from "../../../mock-mcp/src/server.ts";
import { connectMcpTools } from "./mcp.ts";
import { ToolRegistry } from "./registry.ts";

test("真实 MCP 工具隐藏 operationId 并接受绑定标识", async () => {
  const server = await startMockMcp(0);
  const registry = new ToolRegistry();
  const connection = await connectMcpTools(registry, server.url);
  try {
    const definition = registry.definitions().find((item) => item.name === "mock_write");
    assert.ok(definition);
    assert.equal(Object.hasOwn(definition.inputSchema.properties as object, "operationId"), false);
    assert.equal(new Ajv2020({ strict: false }).compile(definition.inputSchema)({ text: "hello", operationId: "forged" }), false);
    assert.deepEqual(registry.prepare("mock_write", '{"text":"hello","operationId":"forged"}'), { ok: false, code: "INVALID_INPUT" });
    const prepared = registry.prepare("mock_write", '{"text":"hello"}');
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.deepEqual(await prepared.call.executeNormalized(new AbortController().signal, "op-1"), { isError: false, value: { text: "hello", operationId: "op-1" }, content: [{ type: "text", text: "hello" }] });
    await assert.rejects(prepared.call.execute());
    assert.deepEqual(await prepared.call.execute(new AbortController().signal, "op-2"), { content: [{ type: "text", text: "hello" }], structuredContent: { text: "hello", operationId: "op-2" } });
    assert.deepEqual(server.effects(), ["hello", "hello"]);
  } finally { await connection.close(); await server.close(); }
});

test("真实 MCP 服务独立拒绝缺少或伪造类型的操作标识", async () => {
  const server = await startMockMcp(0);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  try {
    for (const args of [{ text: "x" }, { text: "x", operationId: 3 }]) {
      const result = await client.callTool({ name: "mock_write", arguments: args });
      assert.equal(result.isError, true);
    }
  } finally { await client.close(); await server.close(); }
});

test("真实 Turn 持久操作标识并投影 content-only 和结构化结果", async () => {
  const server = await startMockMcp(0);
  const registry = new ToolRegistry();
  const connection = await connectMcpTools(registry, server.url, [
    { name: "mock_read", version: "1", sideEffect: "read-only", approvalPolicy: "allow" },
    { name: "mock_write", version: "1", sideEffect: "side-effect", approvalPolicy: "allow" },
  ]);
  const session = new Session({ sessionId: "mcp", createdAt: 0 });
  session.bindCheckpoint(async () => {});
  let requests = 0;
  const drive = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => ++requests === 1 ? [
    { chunk: { type: "tool_call", index: 0, callId: "r", name: "mock_read", argumentsDelta: '{"text":"read"}' } },
    { chunk: { type: "tool_call", index: 1, callId: "w", name: "mock_write", argumentsDelta: '{"text":"write"}' } },
    { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
  ] : [{ chunk: { type: "finish", reason: { kind: "stop" } } }]) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: registry });
  try {
    await drive({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => assert.fail() });
    const operations = session.snapshot().events.filter((event) => event.type === "tool/operation");
    const results = session.snapshot().events.filter((event) => event.type === "tool/result");
    assert.equal(operations.length, 2);
    assert.equal(results.length, 2);
    assert.deepEqual(results.map((event) => event.data.operationId), operations.map((event) => event.data.operationId));
    assert.equal(JSON.stringify(results).includes('"value"'), false);
    assert.match(JSON.stringify(results), /read/);
    assert.match(JSON.stringify(results), /write/);
    assert.equal(requests, 2);
  } finally { await connection.close(); await server.close(); }
});


test("MCP 结果契约、工具失败及协议和传输失败分别结算", async () => {
  const upstream = await startMockMcp(0);
  let response: unknown = {};
  let lastArguments: unknown;
  const proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const request = body ? JSON.parse(body) as { method?: string; id?: number; params?: { arguments?: unknown } } : {};
    if (request.method === "tools/call") {
      lastArguments = request.params?.arguments;
      if (response === "disconnect") { res.writeHead(503).end(); return; }
      const envelope = response === "rpc-error" ? { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "secret" } } : { jsonrpc: "2.0", id: request.id, result: response };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(envelope));
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (value && key !== "host" && key !== "content-length") headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    try {
      const forwarded = await fetch(upstream.url, { method: req.method, headers, ...(body ? { body } : {}) });
      const forwardedBody = await forwarded.text();
      if (request.method === "tools/list") {
        const envelope = JSON.parse(forwardedBody) as { result: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> } };
        const read = envelope.result.tools.find((tool) => tool.name === "mock_read"); assert.ok(read);
        read.inputSchema.additionalProperties = true;
        read.inputSchema.$id = "https://example.test/input";
        envelope.result.tools.push({ name: "plain", inputSchema: { type: "object", properties: { value: { type: "number" } }, additionalProperties: true } });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(envelope));
      } else {
        res.writeHead(forwarded.status, Object.fromEntries(forwarded.headers));
        res.end(forwardedBody);
      }
    } catch { res.destroy(); }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  const registry = new ToolRegistry();
  const connection = await connectMcpTools(registry, `http://127.0.0.1:${address.port}/mcp`, [
    { name: "mock_read", version: "1" }, { name: "mock_write", version: "1" }, { name: "plain", version: "1" }
  ]);
  assert.deepEqual(registry.prepare("mock_read", '{"text":"x","operationId":"forged"}'), { ok: false, code: "INVALID_INPUT" });
  const plain = registry.prepare("plain", '{"value":1,"operationId":"allowed"}'); assert.ok(plain.ok);
  assert.ok(Object.isFrozen(plain.call.args));
  response = { content: [{ type: "text", text: "plain" }] };
  await plain.call.executeNormalized(new AbortController().signal, "unused");
  assert.deepEqual(lastArguments, { value: 1, operationId: "allowed" });
  const prepared = registry.prepare("mock_write", '{"text":"x"}');
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  try {
    for (const candidate of [
      { content: [{ type: "text", text: "ok" }] },
      { content: [{ type: "text", text: "ok" }], structuredContent: { wrong: true } },
      { content: [{ type: "text", text: 1 }] },
      null,
      42,
    ]) {
      response = candidate;
      const result = await prepared.call.executeNormalized(new AbortController().signal, "op");
      assert.equal(result.isError && result.error.info?.code, "INVALID_TOOL_OUTPUT");
    }
    response = { isError: true, content: [{ type: "text", text: "业务失败" }] };
    const toolError = await prepared.call.executeNormalized(new AbortController().signal, "op");
    assert.equal(toolError.isError && toolError.error.info?.code, "MCP_TOOL_ERROR");
    assert.deepEqual(toolError.content, [{ type: "text", text: "业务失败" }]);
    const read = registry.prepare("mock_read", '{"text":"x"}'); assert.ok(read.ok);
    for (const candidate of [{}, { structuredContent: { data: "x" } }]) {
      response = candidate;
      const result = await read.call.executeNormalized(new AbortController().signal, "op");
      assert.equal(result.isError && result.error.info?.code, "INVALID_TOOL_OUTPUT");
    }
    response = { content: [{ type: "text", text: "only" }] };
    assert.deepEqual(await read.call.executeNormalized(new AbortController().signal, "op"), { isError: false, content: [{ type: "text", text: "only" }] });
    response = "rpc-error";
    const rpcError = await prepared.call.executeNormalized(new AbortController().signal, "op");
    assert.equal(rpcError.isError && rpcError.error.info?.code, "MCP_PROTOCOL_ERROR");
    response = "disconnect";
    const transportError = await prepared.call.executeNormalized(new AbortController().signal, "op");
    assert.equal(transportError.isError && transportError.error.info?.code, "MCP_TRANSPORT_ERROR");
  } finally { await connection.close(); proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); await upstream.close(); }
});








test("真实 Agent 与 SQLite 持久化 MCP 操作和结果", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-mcp-"));
  const store = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const initial = await store.create({ sessionId: "s", createdAt: 1 }); await initial.flush(); await initial.close();
  const server = await startMockMcp(0);
  const registry = new ToolRegistry();
  const connection = await connectMcpTools(registry, server.url, [{ name: "mock_write", version: "1", sideEffect: "side-effect", approvalPolicy: "allow" }]);
  let requests = 0;
  const drive = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => ++requests === 1 ? [
    { chunk: { type: "tool_call", index: 0, callId: "w", name: "mock_write", argumentsDelta: '{"text":"stored"}' } },
    { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
  ] : [{ chunk: { type: "finish", reason: { kind: "stop" } } }]) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: registry });
  const manager = new AgentManager(store, drive);
  try {
    await new SessionCommandController(manager).prompt({ sessionId: "s", requestId: "r", content: [{ type: "text", text: "go" }] });
    const agent = manager.get("s"); assert.ok(agent); await agent.waitForIdle(); await agent.session.flush();
    const reader = await store.open("s", "read"); assert.ok(reader);
    const events = await reader.read(); await reader.close();
    const operation = events.find((event) => event.type === "tool/operation");
    const result = events.find((event) => event.type === "tool/result");
    assert.ok(operation && result);
    assert.equal(result.data.operationId, operation.data.operationId);
    assert.equal(JSON.stringify(result).includes('"value"'), false);
    assert.deepEqual(server.effects(), ["stored"]);
  } finally { await manager.close(); await store.close(); await connection.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});
