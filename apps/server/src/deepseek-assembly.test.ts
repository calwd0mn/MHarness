import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createEventSessionApp } from "./app.ts";

test("正式会话装配通过受控 DeepSeek 传输保存请求头与回答", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-deepseek-"));
  const previousProvider = process.env.MHARNESS_MODEL_PROVIDER;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.MHARNESS_MODEL_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "fake-assembly-key";
  const requests: string[] = [];
  const transport: typeof fetch = async (_url, init) => {
    requests.push(new Headers(init?.headers).get("authorization") ?? "");
    return new Response('data: {"choices":[{"delta":{"content":"真实装配"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
  const app = await createEventSessionApp(join(dir, "events.sqlite"), false, undefined, { modelFetch: transport });
  try {
    const created = await app.inject({ method: "POST", url: "/api/sessions" });
    const { sessionId } = created.json() as { sessionId: string };
    await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { requestId: "r", content: [{ type: "text", text: "你好" }] } });
    let history = "";
    for (let i = 0; i < 100; i++) {
      history = (await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` })).body;
      if (history.includes('"type":"turn/end"')) break;
      await setTimeout(10);
    }
    assert.deepEqual(requests, ["Bearer fake-assembly-key"]);
    assert.match(history, /deepseek-v4-pro/);
    assert.match(history, /真实装配/);
    assert.doesNotMatch(history, /fake-assembly-key/);
  } finally {
    await app.close();
    if (previousProvider === undefined) delete process.env.MHARNESS_MODEL_PROVIDER; else process.env.MHARNESS_MODEL_PROVIDER = previousProvider;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previousKey;
    await rm(dir, { recursive: true, force: true });
  }
});

test("正式 DeepSeek 工具续答保留推理及配对结果", async () => {
  const { z } = await import("zod");
  const { ToolRegistry, defineLocalTool } = await import("./tools/registry.ts");
  const { defineLocalToolOutput } = await import("./tools/result.ts");
  const dir = await mkdtemp(join(tmpdir(), "mharness-deepseek-tool-"));
  const old = { provider: process.env.MHARNESS_MODEL_PROVIDER, key: process.env.DEEPSEEK_API_KEY, effort: process.env.MHARNESS_MODEL_REASONING_EFFORT };
  process.env.MHARNESS_MODEL_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "fake-tool-key";
  process.env.MHARNESS_MODEL_REASONING_EFFORT = "high";
  const bodies: unknown[] = [];
  const transport: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(bodies.length === 1
      ? 'data: {"choices":[{"delta":{"reasoning_content":"先查询","tool_calls":[{"index":0,"id":"call-1","function":{"name":"read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'
      : 'data: {"choices":[{"delta":{"content":"查询完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register(defineLocalTool({ name: "read", version: "1", description: "读取", input: z.strictObject({}), timeoutMs: 1000,
    sideEffect: "read-only", output: defineLocalToolOutput({ schema: z.string(), render: (_args, value) => [{ type: "text", text: value }] }),
    handler: () => { executions++; return "结果"; } }));
  const app = await createEventSessionApp(join(dir, "events.sqlite"), false, undefined, { modelFetch: transport, toolRegistry: registry });
  try {
    const created = await app.inject({ method: "POST", url: "/api/sessions" });
    const { sessionId } = created.json() as { sessionId: string };
    await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { requestId: "r", content: [{ type: "text", text: "查" }] } });
    let history = "";
    for (let i = 0; i < 100; i++) {
      history = (await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` })).body;
      if (history.includes('"type":"turn/end"')) break;
      await setTimeout(10);
    }
    assert.equal(executions, 1);
    assert.equal(bodies.length, 2);
    assert.match(JSON.stringify(bodies[1]), /"reasoning_content":"先查询"/);
    assert.match(JSON.stringify(bodies[1]), /"tool_call_id":"call-1"/);
    assert.match(history, /查询完成/);
    assert.doesNotMatch(history, /fake-tool-key/);
    await app.close();
    const { SqliteSessionPersistence, Session } = await import("@mharness/session/server");
    const { rebuildRequestContext } = await import("./agent/request-context.ts");
    const store = new SqliteSessionPersistence(join(dir, "events.sqlite"));
    try {
      const read = await store.open(sessionId, "read");
      assert.ok(read);
      const events = await read.read();
      const settlements = events.filter((event) => event.type === "assistant/message" || event.type === "assistant/attempt");
      assert.equal(settlements.length, 2);
      const replay = settlements.map((event) => rebuildRequestContext(new Session(read.header, {
        seed: { kind: "restore", events: events.slice(0, event.seq), inheritedEventCount: 0 },
      })));
      assert.equal(replay[0]?.header.config.reasoningEffort, "high");
      assert.equal(replay[1]?.header.config.reasoningEffort, "high");
      assert.deepEqual(replay[1]?.input.messages.slice(-2), [
        { role: "assistant", text: "", reasoning: "先查询", toolCalls: [{ callId: "call-1", name: "read", arguments: "{}" }] },
        { role: "tool", callId: "call-1", text: JSON.stringify([{ type: "text", text: "结果" }]) },
      ]);
      assert.doesNotMatch(JSON.stringify(events), /fake-tool-key/);
      await read.close();
    } finally { await store.close(); }
  } finally {
    await app.close();
    if (old.provider === undefined) delete process.env.MHARNESS_MODEL_PROVIDER; else process.env.MHARNESS_MODEL_PROVIDER = old.provider;
    if (old.key === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old.key;
    if (old.effort === undefined) delete process.env.MHARNESS_MODEL_REASONING_EFFORT; else process.env.MHARNESS_MODEL_REASONING_EFFORT = old.effort;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Provider 错误正文中的凭据不进入历史或 follow 快照", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-deepseek-error-"));
  const oldProvider = process.env.MHARNESS_MODEL_PROVIDER;
  const oldKey = process.env.DEEPSEEK_API_KEY;
  process.env.MHARNESS_MODEL_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "fake-error-secret";
  const transport: typeof fetch = async () => new Response('fake-error-secret', { status: 401 });
  const app = await createEventSessionApp(join(dir, "events.sqlite"), false, undefined, { modelFetch: transport });
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
    await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { requestId: "r", content: [{ type: "text", text: "你好" }] } });
    let history = "";
    for (let i = 0; i < 100; i++) {
      history = (await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` })).body;
      if (history.includes('"type":"turn/end"')) break;
      await setTimeout(10);
    }
    assert.match(history, /TRANSPORT/);
    assert.doesNotMatch(history, /fake-error-secret/);
    const response = await fetch(`${origin}/api/sessions/${sessionId}/follow`);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const snapshot = new TextDecoder().decode((await reader.read()).value);
    assert.doesNotMatch(snapshot, /fake-error-secret/);
    await reader.cancel();
  } finally {
    await app.close();
    if (oldProvider === undefined) delete process.env.MHARNESS_MODEL_PROVIDER; else process.env.MHARNESS_MODEL_PROVIDER = oldProvider;
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey;
    await rm(dir, { recursive: true, force: true });
  }
});
