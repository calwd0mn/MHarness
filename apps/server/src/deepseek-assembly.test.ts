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
    assert.match(history, /AUTH/);
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

test("正式 DeepSeek 配置非法容量时不发送请求", async () => {
  for (const [name, value] of ["MHARNESS_MODEL_CONTEXT_WINDOW", "MHARNESS_MODEL_DEFAULT_OUTPUT_TOKENS"].flatMap((name) => ["0", "99999.9999999999999999", "1e3", "0x10", "9007199254740992"].map((value) => [name, value] as const))) {
    const dir = await mkdtemp(join(tmpdir(), "mharness-budget-"));
    const names = ["MHARNESS_MODEL_PROVIDER", "DEEPSEEK_API_KEY", "MHARNESS_MODEL_CONTEXT_WINDOW", "MHARNESS_MODEL_DEFAULT_OUTPUT_TOKENS", "MHARNESS_MODEL_MAX_TOKENS", "MHARNESS_MODEL_REASONING_EFFORT", "MHARNESS_MODEL_TEMPERATURE", "MHARNESS_MODEL_STOP"];
    const old = Object.fromEntries(names.map((key) => [key, process.env[key]]));
    process.env.MHARNESS_MODEL_PROVIDER = "deepseek"; process.env.DEEPSEEK_API_KEY = "key";
    for (const key of names.slice(2)) delete process.env[key];
    process.env[name] = value;
    let calls = 0;
    const app = await createEventSessionApp(join(dir, "events.sqlite"), false, undefined, { modelFetch: async () => { calls++; return new Response('data: {"choices":[{"delta":{"content":"wrong"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); } });
    try {
      const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
      const response = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { requestId: "r", content: [{ type: "text", text: "你好" }] } });
      assert.equal(response.statusCode, 202);
      let history = "";
      for (let i = 0; i < 100; i++) { history = (await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` })).body; if (history.includes('"type":"turn/end"')) break; await setTimeout(10); }
      assert.match(history, /"kind":"error"/); assert.doesNotMatch(history, /"type":"request\/header"/); assert.equal(calls, 0);
    } finally {
      await app.close();
      for (const key of names) { const value = old[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("真实配置的容量声明不改变生成上限", async () => {
  for (const [window, output, max] of [[undefined, undefined, undefined], ["100000", "2000", undefined], [" 00100000 ", " 002000 ", undefined], ["100000", "2000", "64"]] as const) {
    const dir = await mkdtemp(join(tmpdir(), "mharness-budget-success-"));
    const names = ["MHARNESS_MODEL_PROVIDER", "DEEPSEEK_API_KEY", "MHARNESS_MODEL_CONTEXT_WINDOW", "MHARNESS_MODEL_DEFAULT_OUTPUT_TOKENS", "MHARNESS_MODEL_MAX_TOKENS", "MHARNESS_MODEL_REASONING_EFFORT", "MHARNESS_MODEL_TEMPERATURE", "MHARNESS_MODEL_STOP"];
    const old = Object.fromEntries(names.map((key) => [key, process.env[key]]));
    process.env.MHARNESS_MODEL_PROVIDER = "deepseek"; process.env.DEEPSEEK_API_KEY = "key";
    for (const [key, value] of [[names[2]!, window], [names[3]!, output], [names[4]!, max], [names[5]!, undefined], [names[6]!, undefined], [names[7]!, undefined]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const bodies: { model: string; max_tokens?: number; messages: unknown[] }[] = [];
    const app = await createEventSessionApp(join(dir, "events.sqlite"), false, undefined, { modelFetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); } });
    try {
      const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
      const response = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { requestId: "r", content: [{ type: "text", text: "你好" }] } });
      assert.equal(response.statusCode, 202);
      let history = "";
      for (let i = 0; i < 100; i++) { history = (await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` })).body; if (history.includes('"type":"turn/end"')) break; await setTimeout(10); }
      assert.match(history, /"kind":"completed"/); assert.equal(bodies.length, 1);
      assert.equal(bodies[0]?.model, "deepseek-v4-pro"); assert.equal(bodies[0]?.max_tokens, max === undefined ? undefined : Number(max));
      assert.deepEqual(bodies[0]?.messages, [{ role: "system", content: "你是一个中文助手。" }, { role: "user", content: "你好" }]);
      if (max === undefined) assert.doesNotMatch(history, /"maxTokens"/); else assert.match(history, /"maxTokens":64/);
    } finally {
      await app.close();
      for (const key of names) { const value = old[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(dir, { recursive: true, force: true });
    }
  }
});
