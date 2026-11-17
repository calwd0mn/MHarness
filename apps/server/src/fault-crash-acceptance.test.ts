import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSessionResponseSchema, rawSessionHistorySchema } from "@mharness/session/contracts";
import { startMockMcp } from "../../mock-mcp/src/server.ts";

async function waitFor<T>(check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("等待强制退出验收屏障超时");
}

test("强制终止后仅恢复已派发未知结果与尚未派发声明", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-crash-"));
  const path = join(dir, "events.sqlite");
  const ledgerPath = join(dir, "ledger.sqlite");
  let upstream: Awaited<ReturnType<typeof startMockMcp>> | undefined;
  let proxy: ReturnType<typeof createServer> | undefined;
  const children: ChildProcess[] = [];
  const requests: { name: string; arguments: { text: string; operationId: string } }[] = [];
  const held: ServerResponse[] = [];
  try {
  upstream = await startMockMcp(0, ledgerPath);
  const upstreamUrl = upstream.url;
  proxy = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const request: { method?: string; params?: { name: string; arguments: { text: string; operationId: string } } } = body ? JSON.parse(body) : {};
      if (request.method === "tools/call" && request.params) requests.push(request.params);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value && key !== "host" && key !== "content-length") headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const response = await fetch(upstreamUrl, { method: req.method, headers, ...(body ? { body } : {}) });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (request.method === "tools/call") { held.push(res); return; }
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(bytes);
    } catch { res.destroy(); }
  });
  await new Promise<void>((resolve, reject) => {
    proxy!.once("error", reject);
    proxy!.listen(0, "127.0.0.1", () => { proxy!.off("error", reject); resolve(); });
  });
  const address = proxy.address();
  assert.ok(address && typeof address === "object");
  const moduleUrl = (path: string) => new URL(path, import.meta.url).href;
  const script = `
    const { createEventSessionApp } = await import(${JSON.stringify(moduleUrl("./app.ts"))});
    const { createModelTurnDriver } = await import(${JSON.stringify(moduleUrl("./agent/model-turn.ts"))});
    const { createMockAdapter } = await import(${JSON.stringify(moduleUrl("./model/providers/mock.ts"))});
    const { LlmRuntime } = await import(${JSON.stringify(moduleUrl("./model/runtime.ts"))});
    const { ToolRegistry } = await import(${JSON.stringify(moduleUrl("./tools/registry.ts"))});
    const { connectMcpTools } = await import(${JSON.stringify(moduleUrl("./tools/mcp.ts"))});
    const registry = new ToolRegistry();
    await connectMcpTools(registry, process.argv[2], [
      { name: "mock_write", version: "1", sideEffect: "side-effect", supportsIdempotency: true, approvalPolicy: "allow" },
      { name: "mock_read", version: "1", sideEffect: "read-only", approvalPolicy: "allow" }
    ]);
    const driver = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => {
      process.send({ model: true });
      return [
        { chunk: { type: "tool_call", index: 0, callId: "write", name: "mock_write", argumentsDelta: JSON.stringify({ text: "一次效果" }) } },
        { chunk: { type: "tool_call", index: 1, callId: "read", name: "mock_read", argumentsDelta: JSON.stringify({ text: "未派发" }) } },
        { chunk: { type: "finish", reason: { kind: "tool_calls" } } }
      ];
    }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: registry });
    const app = await createEventSessionApp(process.argv[1], false, driver);
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    process.send({ url });
  `;
  const start = async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path, `http://127.0.0.1:${address.port}/mcp`], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    children.push(child);
    const messages: unknown[] = [];
    child.on("message", message => messages.push(message));
    const origin = await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("测试后端启动前退出");
      const message = messages.find(value => typeof value === "object" && value !== null && "url" in value);
      return typeof message === "object" && message !== null && "url" in message && typeof message.url === "string" ? message.url : undefined;
    });
    return { child, messages, origin };
  };
  const stop = async (child: ChildProcess) => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  };
  const first = await start();
  const { child, messages, origin } = first;
    const post = (url: string, body: object) => fetch(origin + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = createSessionResponseSchema.parse(await (await post("/api/sessions", {})).json());
    const url = `/api/sessions/${created.sessionId}`;
    await post(url + "/messages", { requestId: "crash", content: [{ type: "text", text: "开始" }] });
    await waitFor(async () => held.length === 1 ? true : undefined);
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT operation_id, text FROM mock_effects").get();
      assert.equal(JSON.parse(String(row?.operation_id)), requests[0]?.arguments.operationId);
      assert.equal(JSON.parse(String(row?.text)), "一次效果");
    } finally { db.close(); }
    const prefix = await waitFor(async () => {
      const history = rawSessionHistorySchema.parse(await (await fetch(origin + url)).json());
      return history.records.some(record => record.event.type === "tool/call") ? history.records : undefined;
    });
    const declaration = prefix.find(record => record.event.type === "assistant/message")?.event;
    const call = prefix.find(record => record.event.type === "tool/call")?.event;
    const operation = prefix.find(record => record.event.type === "tool/operation")?.event;
    assert.ok(declaration?.type === "assistant/message" && call?.type === "tool/call" && operation?.type === "tool/operation");
    assert.deepEqual(declaration.data.message.content.filter(part => part.type === "tool-call").map(part => part.id), ["write", "read"]);
    assert.equal(call.data.callId, "write");
    assert.equal(operation.data.operationId, requests[0]?.arguments.operationId);
    assert.equal(prefix.filter(record => record.event.type === "tool/result" || record.event.type === "turn/end").length, 0);
    assert.equal(requests.length, 1);
    assert.equal(messages.filter(value => typeof value === "object" && value !== null && "model" in value).length, 1);
    const exited = once(child, "exit"); child.kill(); await exited;
    const replacement = await start();
    const history = rawSessionHistorySchema.parse(await (await fetch(replacement.origin + url)).json());
    const recovered = history.records;
    assert.deepEqual(recovered.slice(0, prefix.length), prefix);
    const results = recovered.filter(record => record.event.type === "tool/result").map(record => record.event);
    assert.deepEqual(results.map(event => event.type === "tool/result" && [event.data.message.source.callId, event.data.error?.code]), [["write", "TOOL_OUTCOME_UNKNOWN"], ["read", "TOOL_NOT_STARTED"]]);
    assert.ok(results[0]?.type === "tool/result" && results[1]?.type === "tool/result");
    assert.equal(results[0].data.operationId, operation.data.operationId);
    assert.deepEqual(results[0].sourceEventSeqs, [call.seq]);
    assert.deepEqual(results[1].sourceEventSeqs, [declaration.seq]);
    assert.equal(recovered.filter(record => record.event.type === "step/end").length, 1);
    assert.equal(recovered.filter(record => record.event.type === "turn/end").length, 1);
    assert.deepEqual(recovered.at(-1)?.event.data, { turn: 1, reason: { kind: "interrupted" } });
    assert.equal(replacement.messages.filter(value => typeof value === "object" && value !== null && "model" in value).length, 0);
    assert.equal(requests.length, 1);
    assert.deepEqual(upstream.effects(), ["一次效果"]);
    await stop(replacement.child);
    const reopened = await start();
    assert.deepEqual(rawSessionHistorySchema.parse(await (await fetch(reopened.origin + url)).json()).records, recovered);
    assert.equal(reopened.messages.filter(value => typeof value === "object" && value !== null && "model" in value).length, 0);
    await stop(reopened.child);
    assert.equal(requests.length, 1);
    assert.deepEqual(upstream.effects(), ["一次效果"]);
    assert.equal(messages.filter(value => typeof value === "object" && value !== null && "model" in value).length, 1);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
    }
    for (const response of held) response.destroy();
    if (proxy?.listening) { const server = proxy; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await upstream?.close(); await rm(dir, { recursive: true, force: true });
  }
});
