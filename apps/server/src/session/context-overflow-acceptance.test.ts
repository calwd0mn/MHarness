import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SqliteSessionPersistence } from "@mharness/session/server";
import { followFrameSchema, rawSessionHistorySchema, type RawSessionEventFrame } from "@mharness/session/contracts";
import { createEventSessionApp } from "../app.ts";
import { rebuildRequestContext } from "../agent/request-context.ts";
import { createDeepSeekAdapter } from "../model/providers/deepseek.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { LlmError } from "../model/adapter.ts";
import { AgentManager } from "../agent/manager.ts";
import type { AgentObservation } from "../agent/react-agent.ts";
import { createModelTurnDriver } from "../agent/model-turn.ts";
import { recoverContextOverflow } from "../agent/context-overflow-recovery.ts";
import { injectCompactionSqliteFault } from "./compaction-settlement-sqlite-fixture.ts";

function success(text: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
function overflow(status: 400 | 422): Response {
  return new Response(JSON.stringify({ error: { code: "context_length_exceeded" } }), { status, headers: { "content-type": "application/json" } });
}
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}

async function openFollow(origin: string, sessionId: string, signal: AbortSignal) {
  const response = await fetch(`${origin}/api/sessions/${sessionId}/follow`, { signal });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const next = async () => {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const item = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (item.startsWith("data: ")) return followFrameSchema.parse(JSON.parse(item.slice(6)) as unknown);
      } else {
        const part = await reader.read();
        if (part.done) throw new Error("follow 已关闭");
        buffer += part.value;
      }
    }
  };
  return { reader, next };
}

async function assertReopenedFollow(
  path: string, sessionId: string, events: readonly RawSessionEventFrame["event"][],
  options: Parameters<typeof createEventSessionApp>[3],
) {
  const app = await createEventSessionApp(path, false, undefined, options);
  const controller = new AbortController();
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const { reader, next } = await openFollow(origin, sessionId, controller.signal);
    const snapshot = await next();
    assert.ok(snapshot.type === "snapshot");
    assert.equal(snapshot.cursor, events.length - 1);
    assert.equal(snapshot.assistantStream.activeAttempt, undefined);
    assert.deepEqual(snapshot.records.map(record => record.event), events);
    await reader.cancel();
  } finally {
    controller.abort();
    await app.close();
  }
}

for (const mode of ["retry", "repeat", "cancel"] as const) test(`真实装配：超限摘要的收尾（${{ retry: "同 Step 重试成功", repeat: "再次超限", cancel: "摘要期间取消" }[mode]}）`, { timeout: 10000 }, async t => {
  const repeatOverflow = mode === "repeat";
  const cancelled = mode === "cancel";
  const dir = await mkdtemp(join(tmpdir(), "overflow-acceptance-"));
  const path = join(dir, "sessions.sqlite");
  const envNames = ["MHARNESS_MODEL_PROVIDER", "DEEPSEEK_API_KEY", "MHARNESS_MODEL_CONTEXT_WINDOW", "MHARNESS_MODEL_DEFAULT_OUTPUT_TOKENS", "MHARNESS_MODEL_MAX_TOKENS", "MHARNESS_MODEL_TEMPERATURE", "MHARNESS_MODEL_REASONING_EFFORT", "MHARNESS_MODEL_STOP"] as const;
  const previous = envNames.map(name => process.env[name]);
  t.after(async () => {
    envNames.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    await rm(dir, { recursive: true, force: true });
  });
  for (const name of envNames) delete process.env[name];
  process.env.MHARNESS_MODEL_PROVIDER = "deepseek"; process.env.DEEPSEEK_API_KEY = "first-key";
  process.env.MHARNESS_MODEL_CONTEXT_WINDOW = "100000"; process.env.MHARNESS_MODEL_DEFAULT_OUTPUT_TOKENS = "2000";
  const seed = new Session({ sessionId: "overflow", createdAt: 1 });
  seed.append({ type: "turn/start", data: { turn: 1 } });
  seed.append({ type: "user/message", surfaceOp: "append", data: { id: "old", role: "user", turn: 1, requestId: "old", source: { kind: "user" }, content: [{ type: "text", text: "历史信息".repeat(1000) }] } });
  seed.append({ type: "step/start", data: { turn: 1, step: 1 } });
  seed.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "answer", role: "assistant", source: { provider: "deepseek", model: "deepseek-v4-pro" }, content: [{ type: "text", text: "历史回答" }] }, finishReason: { kind: "stop" }, stream: [], includeInModelContext: true } });
  seed.append({ type: "step/end", data: { turn: 1, step: 1 } });
  seed.append({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  const initialStore = new SqliteSessionPersistence(path);
  try {
    const writer = await initialStore.create(seed.header);
    await writer.append(seed.snapshot().events);
  } finally {
    await initialStore.close();
  }
  const entered = deferred(), release = deferred();
  const requests: { body: unknown; authorization: string | null }[] = [];
  let summarySignal: AbortSignal | null | undefined;
  const transport: typeof fetch = async (_url, init) => {
    requests.push({ body: JSON.parse(String(init?.body)) as unknown, authorization: new Headers(init?.headers).get("authorization") });
    if (requests.length === 1) { process.env.DEEPSEEK_API_KEY = "changed-key"; return overflow(400); }
    if (requests.length === 2) {
      summarySignal = init?.signal;
      entered.resolve();
      await release.promise;
      summarySignal?.throwIfAborted();
      return success("历史摘要".repeat(30));
    }
    if (repeatOverflow && requests.length === 3) return overflow(422);
    if (repeatOverflow && requests.length === 4) return overflow(400);
    if (repeatOverflow && requests.length === 5) return success("更新后的摘要");
    return success("恢复完成");
  };
  const app = await createEventSessionApp(path, false, undefined, { modelFetch: transport });
  const controller = new AbortController();
  let appClosed = false;
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const { reader, next } = await openFollow(origin, "overflow", controller.signal);
    assert.equal((await next()).type, "snapshot");
    assert.equal((await app.inject({ method: "POST", url: "/api/sessions/overflow/messages", payload: { requestId: "new", content: [{ type: "text", text: "新问题" }] } })).statusCode, 202);
    await entered.promise;
    const before = []; for (;;) { const frame = await next(); before.push(frame); if (frame.type === "assistant-stream" && frame.frame.type === "end") break; }
    assert.ok(before.some(frame => frame.type === "event" && frame.event.type === "assistant/attempt"));
    const last = before.at(-1); assert.ok(last?.type === "assistant-stream" && last.frame.type === "end" && last.frame.outcome.kind === "committed");
    const observer = new SqliteSessionPersistence(path, { readOnly: true });
    try { const handle = await observer.open("overflow", "read"); assert.ok(handle); const disk = await handle.read(); assert.ok(disk.some(event => event.type === "assistant/attempt" && event.data.turn === 2)); await handle.close(); } finally { await observer.close(); }
    if (cancelled) {
      const cancel = await app.inject({ method: "POST", url: "/api/sessions/overflow/cancel" });
      assert.equal(cancel.statusCode, 202);
      assert.equal(summarySignal?.aborted, true);
    }
    release.resolve();
    const later = []; for (;;) { const frame = await next(); later.push(frame); if (frame.type === "event" && frame.event.type === "turn/end") break; }
    await reader.cancel();
    let history = rawSessionHistorySchema.parse((await app.inject({ method: "GET", url: "/api/sessions/overflow" })).json());
    for (let n = 0; n < 200 && !history.records.some(record => record.event.type === "turn/end" && record.event.data.turn === 2); n++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      history = rawSessionHistorySchema.parse((await app.inject({ method: "GET", url: "/api/sessions/overflow" })).json());
    }
    const events = history.records.map(record => record.event);
    const current = events.filter(event => "turn" in event.data && event.data.turn === 2);
    assert.equal(current.filter(event => event.type === "step/start").length, 1);
    assert.equal(current.filter(event => event.type === "step/end").length, 1);
    assert.equal(current.filter(event => event.type === "assistant/attempt").length, repeatOverflow ? 2 : 1);
    assert.equal(events.filter(event => event.type === "compaction/start" && event.data.turn === 2).length, 1);
    assert.equal(requests.length, cancelled ? 2 : 3);
    assert.deepEqual(requests.map(request => request.authorization), Array(cancelled ? 2 : 3).fill("Bearer first-key"));
    const summary = requests[1]?.body as { max_tokens?: number; tools?: unknown; thinking?: unknown };
    assert.equal(summary.max_tokens, 8192); assert.equal(summary.tools, undefined); assert.deepEqual(summary.thinking, { type: "disabled" });
    const assistantEnds = [...before, ...later].filter(frame => frame.type === "assistant-stream" && frame.frame.type === "end");
    assert.equal(assistantEnds.length, cancelled ? 1 : 2);
    if (cancelled) {
      const start = current.find(event => event.type === "compaction/start");
      const end = current.find(event => event.type === "compaction/end");
      assert.ok(start?.type === "compaction/start" && end?.type === "compaction/end");
      assert.equal(end.data.compactionId, start.data.compactionId);
      assert.equal(end.data.status, "cancelled");
      assert.deepEqual(current.slice(current.findIndex(event => event === start)).map(event => event.type), [
        "compaction/start", "compaction/end", "step/end", "turn/end",
      ]);
      assert.deepEqual(current.at(-1)?.data, { turn: 2, reason: { kind: "aborted", reason: "user" } });
      assert.equal(events.some(event => event.type === "compaction/summary" || event.type === "user/message" && event.surfaceOp !== "append"), false);
      const delivered = [...before, ...later].flatMap(frame => frame.type === "event" ? [frame.event] : []);
      assert.deepEqual(delivered, events.slice(seed.snapshot().events.length));
      const failed = current.find(event => event.type === "assistant/attempt");
      assert.ok(failed?.type === "assistant/attempt" && failed.data.outcome === "failed");
      assert.equal(last.frame.outcome.seq, failed.seq);
      assert.equal([...before, ...later].filter(frame => frame.type === "assistant-stream" && frame.frame.type === "start").length, 1);
      await app.close(); appClosed = true;
      await assertReopenedFollow(path, "overflow", events, { modelFetch: transport });
      assert.equal(requests.length, 2);
      return;
    }
    const starts = [...before, ...later].flatMap(frame => frame.type === "assistant-stream" && frame.frame.type === "start" ? [frame.frame.attemptId] : []);
    assert.equal(new Set(starts).size, 2);
    const result = current.find(event => event.type === "turn/end");
    if (repeatOverflow) { assert.ok(result?.type === "turn/end" && result.data.reason.kind === "error"); assert.equal(result.data.reason.error.code, "CONTEXT_WINDOW_EXCEEDED"); assert.equal(result.data.reason.error.httpStatus, 422); }
    else assert.ok(result?.type === "turn/end" && result.data.reason.kind === "completed");
    const attempts = events.flatMap((event, index) => event.type === "assistant/attempt" && event.data.turn === 2 ? [index] : event.type === "assistant/message" && event.data.turn === 2 ? [index] : []);
    for (const [index, requestIndex] of [[attempts[0], 0], [attempts.at(-1), 2]] as const) {
      assert.notEqual(index, undefined);
      const replay = new Session(seed.header, { seed: { kind: "restore", events: events.slice(0, index), inheritedEventCount: 0 } });
      const rebuilt = rebuildRequestContext(replay);
      let captured: unknown;
      const runtime = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "replay", fetch: async (_url, init) => { captured = JSON.parse(String(init?.body)) as unknown; return success("ok"); } }) });
      for await (const _chunk of runtime.prepare({ provider: "deepseek", model: "deepseek-v4-pro" }).generate(rebuilt.input, new AbortController().signal)) {}
      assert.deepEqual(captured, requests[requestIndex]?.body);
    }
    if (repeatOverflow) {
      const accepted = await app.inject({ method: "POST", url: "/api/sessions/overflow/messages", payload: { requestId: "next-turn", content: [{ type: "text", text: "另一个问题" }] } });
      assert.equal(accepted.statusCode, 202);
      for (let n = 0; n < 200 && !history.records.some(record => record.event.type === "turn/end" && record.event.data.turn === 3); n++) {
        await new Promise(resolve => setTimeout(resolve, 5));
        history = rawSessionHistorySchema.parse((await app.inject({ method: "GET", url: "/api/sessions/overflow" })).json());
      }
      const next = history.records.map(record => record.event).filter(event => "turn" in event.data && event.data.turn === 3);
      assert.equal(next.filter(event => event.type === "assistant/attempt").length, 1);
      assert.equal(next.filter(event => event.type === "compaction/start").length, 1);
      assert.deepEqual(next.at(-1)?.data, { turn: 3, reason: { kind: "completed" } });
      assert.equal(requests.length, 6);
    }
  } finally {
    release.resolve();
    controller.abort();
    if (!appClosed) await app.close();
  }
});


test("真实装配：恢复后的工具只执行一次，下一 Step 可再次恢复超限", { timeout: 10000 }, async () => {
  const { ToolRegistry, defineLocalTool } = await import("../tools/registry.ts");
  const { defineLocalToolOutput } = await import("../tools/result.ts");
  const { z } = await import("zod");
  const dir = await mkdtemp(join(tmpdir(), "overflow-next-step-"));
  const path = join(dir, "sessions.sqlite");
  const envNames = ["MHARNESS_MODEL_PROVIDER", "DEEPSEEK_API_KEY", "MHARNESS_MODEL_CONTEXT_WINDOW", "MHARNESS_MODEL_DEFAULT_OUTPUT_TOKENS"] as const;
  const previous = envNames.map(name => process.env[name]);
  process.env.MHARNESS_MODEL_PROVIDER = "deepseek"; process.env.DEEPSEEK_API_KEY = "key";
  process.env.MHARNESS_MODEL_CONTEXT_WINDOW = "100000"; process.env.MHARNESS_MODEL_DEFAULT_OUTPUT_TOKENS = "2000";
  const seed = new Session({ sessionId: "next", createdAt: 1 });
  seed.append({ type: "turn/start", data: { turn: 1 } });
  seed.append({ type: "user/message", surfaceOp: "append", data: { id: "old", role: "user", turn: 1, requestId: "old", source: { kind: "user" }, content: [{ type: "text", text: "历史信息".repeat(1000) }] } });
  seed.append({ type: "step/start", data: { turn: 1, step: 1 } });
  seed.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "answer", role: "assistant", source: { provider: "deepseek", model: "deepseek-v4-pro" }, content: [{ type: "text", text: "历史回答" }] }, finishReason: { kind: "stop" }, stream: [], includeInModelContext: true } });
  seed.append({ type: "step/end", data: { turn: 1, step: 1 } });
  seed.append({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  const store = new SqliteSessionPersistence(path); const handle = await store.create(seed.header);
  await handle.append(seed.snapshot().events); await handle.close(); await store.close();
  let toolCalls = 0; let requests = 0;
  const registry = new ToolRegistry();
  registry.register(defineLocalTool({ name: "read", version: "1", description: "read", input: z.strictObject({}), sideEffect: "read-only",
    handler: () => { toolCalls++; return "结果".repeat(200); }, output: defineLocalToolOutput({ schema: z.string(), render: (_args, value) => [{ type: "text", text: value }] }) }));
  const transport: typeof fetch = async () => {
    requests++;
    if (requests === 1 || requests === 4) return overflow(400);
    if (requests === 2 || requests === 5) return success("摘要");
    if (requests === 3) return new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
    return success("完成");
  };
  const app = await createEventSessionApp(path, false, undefined, { modelFetch: transport, toolRegistry: registry });
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/sessions/next/messages", payload: { requestId: "new", content: [{ type: "text", text: "新问题" }] } })).statusCode, 202);
    let history = rawSessionHistorySchema.parse((await app.inject({ method: "GET", url: "/api/sessions/next" })).json());
    for (let n = 0; n < 500 && !history.records.some(record => record.event.type === "turn/end" && record.event.data.turn === 2); n++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      history = rawSessionHistorySchema.parse((await app.inject({ method: "GET", url: "/api/sessions/next" })).json());
    }
    const events = history.records.map(record => record.event);
    const current = events.filter(event => "turn" in event.data && event.data.turn === 2);
    const result = current.find(event => event.type === "turn/end");
    assert.ok(result?.type === "turn/end" && result.data.reason.kind === "completed");
    assert.equal(toolCalls, 1); assert.equal(requests, 6);
    assert.deepEqual(current.flatMap(event => event.type === "step/start" ? [event.data.step] : []), [1, 2]);
    assert.deepEqual(current.flatMap(event => event.type === "assistant/attempt" ? [event.data.step] : []), [1, 2]);
    assert.equal(current.filter(event => event.type === "compaction/start").length, 2);
    assert.equal(current.filter(event => event.type === "tool/result").length, 1);
  } finally {
    await app.close(); envNames.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    await rm(dir, { recursive: true, force: true });
  }
});


test("真实装配：超限恢复的工具续答进入下一 Step 压力修剪", { timeout: 10000 }, async t => {
  const { ToolRegistry, defineLocalTool } = await import("../tools/registry.ts");
  const { defineLocalToolOutput } = await import("../tools/result.ts");
  const { z } = await import("zod");
  const dir = await mkdtemp(join(tmpdir(), "overflow-pressure-cross-"));
  const path = join(dir, "sessions.sqlite");
  const envNames = ["MHARNESS_MODEL_PROVIDER", "DEEPSEEK_API_KEY", "MHARNESS_MODEL_CONTEXT_WINDOW", "MHARNESS_MODEL_DEFAULT_OUTPUT_TOKENS", "MHARNESS_MODEL_MAX_TOKENS", "MHARNESS_MODEL_TEMPERATURE", "MHARNESS_MODEL_REASONING_EFFORT", "MHARNESS_MODEL_STOP"] as const;
  const previous = envNames.map(name => process.env[name]);
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    envNames.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    await rm(dir, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  process.env.MHARNESS_MODEL_PROVIDER = "deepseek"; process.env.DEEPSEEK_API_KEY = "key";
  process.env.MHARNESS_MODEL_CONTEXT_WINDOW = "100000"; process.env.MHARNESS_MODEL_DEFAULT_OUTPUT_TOKENS = "78000";
  process.env.MHARNESS_MODEL_MAX_TOKENS = "78000"; process.env.MHARNESS_MODEL_TEMPERATURE = "0.2";
  process.env.MHARNESS_MODEL_REASONING_EFFORT = "none"; process.env.MHARNESS_MODEL_STOP = '["end"]';
  const seed = new Session({ sessionId: "cross", createdAt: 1 });
  seed.append({ type: "turn/start", data: { turn: 1 } });
  seed.append({ type: "user/message", surfaceOp: "append", data: { id: "old", role: "user", turn: 1, requestId: "old", source: { kind: "user" }, content: [{ type: "text", text: "历史信息".repeat(250) }] } });
  seed.append({ type: "step/start", data: { turn: 1, step: 1 } });
  seed.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "answer", role: "assistant", source: { provider: "deepseek", model: "deepseek-v4-pro" }, content: [{ type: "text", text: "历史回答" }] }, finishReason: { kind: "stop" }, stream: [], includeInModelContext: true } });
  seed.append({ type: "step/end", data: { turn: 1, step: 1 } });
  seed.append({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  const store = new SqliteSessionPersistence(path);
  let storeOpen = true;
  cleanups.push(async () => { if (storeOpen) await store.close(); });
  const handle = await store.create(seed.header);
  let handleOpen = true;
  cleanups.push(async () => { if (handleOpen) await handle.close(); });
  await handle.append(seed.snapshot().events); await handle.close(); handleOpen = false;
  await store.close(); storeOpen = false;
  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  let observerOpen = true;
  cleanups.push(async () => { if (observerOpen) await observer.close(); });
  const reader = await observer.open("cross", "read"); assert.ok(reader);
  let readerOpen = true;
  cleanups.push(async () => { if (readerOpen) await reader.close(); });
  let toolCalls = 0;
  const registry = new ToolRegistry();
  registry.register(defineLocalTool({ name: "read", version: "1", description: "read", input: z.strictObject({}), sideEffect: "read-only",
    handler: () => { toolCalls++; return "HEAD" + "x".repeat(16000) + "TAIL"; }, output: defineLocalToolOutput({ schema: z.string(), render: (_args, value) => [{ type: "text", text: value }] }) }));
  const requests: unknown[] = [];
  const prefixes: (Awaited<ReturnType<typeof reader.read>>)[] = [];
  const transport: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as unknown);
    prefixes.push(await reader.read());
    if (requests.length === 1) return overflow(400);
    if (requests.length === 2) return success("历史摘要");
    if (requests.length === 3) return new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
    return success("完成");
  };
  const app = await createEventSessionApp(path, false, undefined, { modelFetch: transport, toolRegistry: registry });
  let appOpen = true;
  cleanups.push(async () => { if (appOpen) await app.close(); });
  {
    assert.equal((await app.inject({ method: "POST", url: "/api/sessions/cross/messages", payload: { requestId: "new", content: [{ type: "text", text: "新问题" }] } })).statusCode, 202);
    let history = rawSessionHistorySchema.parse((await app.inject({ method: "GET", url: "/api/sessions/cross" })).json());
    for (let n = 0; n < 500 && !history.records.some(record => record.event.type === "turn/end" && record.event.data.turn === 2); n++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      history = rawSessionHistorySchema.parse((await app.inject({ method: "GET", url: "/api/sessions/cross" })).json());
    }
    const events = history.records.map(record => record.event);
    const current = events.filter(event => "turn" in event.data && event.data.turn === 2);
    assert.equal(toolCalls, 1);
    assert.equal(requests.length, 4);
    assert.deepEqual(current.flatMap(event => event.type === "step/start" ? [event.data.step] : []), [1, 2]);
    assert.equal(current.filter(event => event.type === "assistant/attempt").length, 1);
    assert.equal(current.filter(event => event.type === "compaction/start").length, 1);
    assert.equal(events.filter(event => event.type === "compaction/prune").length, 1);
    assert.equal(current.filter(event => event.type === "tool/result").length, 2);
    const sequence = events.slice(seed.snapshot().events.length).filter(event => ["step/start", "assistant/attempt", "compaction/start", "compaction/summary", "compaction/end", "assistant/message", "tool/result", "step/end", "compaction/prune", "turn/end"].includes(event.type)).map(event => event.type);
    assert.deepEqual(sequence, ["step/start", "assistant/attempt", "compaction/start", "compaction/summary", "compaction/end", "assistant/message", "tool/result", "step/end", "compaction/prune", "tool/result", "step/start", "assistant/message", "step/end", "turn/end"]);
    const end = current.at(-1);
    assert.ok(end?.type === "turn/end" && end.data.reason.kind === "completed");
    assert.ok(prefixes[1]?.some(event => event.type === "assistant/attempt" && event.data.turn === 2));
    assert.ok(prefixes[3]?.some(event => event.type === "compaction/prune"));
    for (const index of [0, 2, 3]) {
      const replay = new Session(seed.header, { seed: { kind: "restore", events: prefixes[index]!, inheritedEventCount: 0 } });
      const rebuilt = rebuildRequestContext(replay);
      const config = rebuilt.header.config;
      assert.deepEqual(config, { provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "none", temperature: 0.2, maxTokens: 78000, stop: ["end"] });
      let captured: unknown;
      const runtime = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "replay", fetch: async (_url, init) => { captured = JSON.parse(String(init?.body)) as unknown; return success("ok"); } }) });
      for await (const _chunk of runtime.prepare({ provider: config.provider, model: config.model, params: { reasoningEffort: config.reasoningEffort, temperature: config.temperature, maxOutputTokens: config.maxTokens, stop: config.stop } }).generate(rebuilt.input, new AbortController().signal)) {}
      assert.deepEqual(captured, requests[index]);
    }
    assert.match(JSON.stringify(requests[2]), /历史摘要/);
    assert.match(JSON.stringify(requests[3]), /call/);
    assert.match(JSON.stringify(requests[3]), /HEADx{100}/);
    assert.match(JSON.stringify(requests[3]), /tool result middle pruned/);
    assert.match(JSON.stringify(requests[3]), /x{100}TAIL/);
    assert.doesNotMatch(JSON.stringify(requests[3]), /x{16000}/);
    const summary = requests[1] as { max_tokens?: number; tools?: unknown };
    assert.equal(summary.max_tokens, 8192); assert.equal(summary.tools, undefined);
    await app.close(); appOpen = false;
    await reader.close(); readerOpen = false;
    await observer.close(); observerOpen = false;
    await assertReopenedFollow(path, "cross", events, { modelFetch: transport, toolRegistry: registry });
    assert.equal(requests.length, 4);
    assert.equal(toolCalls, 1);
  }
});


for (const mode of ["attempt-flush", "summary-pending", "retry-flush"] as const) test(`真实 SQLite 超限路径的写入边界 ${mode}`, async t => {
  const dir = await mkdtemp(join(tmpdir(), "overflow-checkpoint-"));
  const path = join(dir, "session.sqlite");
  const store = new SqliteSessionPersistence(path);
  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  const inject = new DatabaseSync(path);
  const seed = new Session({ sessionId: "overflow-fault", createdAt: 1 });
  seed.append({ type: "turn/start", data: { turn: 1 } });
  seed.append({ type: "user/message", surfaceOp: "append", data: {
    turn: 1, id: "old", requestId: "old", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "旧历史".repeat(4000) }],
  } });
  seed.append({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  const initial = await store.create(seed.header);
  await initial.append(seed.snapshot().events);
  await initial.close();
  const reader = await observer.open(seed.header.sessionId, "read"); assert.ok(reader);
  if (mode !== "summary-pending") {
    const predicate = mode === "attempt-flush" ? "json_extract(NEW.event_json,'$.type') = 'assistant/attempt'" :
      "json_extract(NEW.event_json,'$.type') = 'request/header' AND json_extract(NEW.event_json,'$.data.reason') = 'series'";
    inject.exec(`CREATE TRIGGER reject_checkpoint BEFORE INSERT ON mh_events
      WHEN ${predicate} BEGIN SELECT RAISE(ABORT, 'private write failure'); END`);
  }
  let fault: ReturnType<typeof injectCompactionSqliteFault> | undefined;
  let businessCalls = 0;
  let summaryCalls = 0;
  let recoveryCalls = 0;
  const runtime = new LlmRuntime({ mock: {
    async *generate(request) {
      if (request.effectiveParams.maxOutputTokens !== 8192) { businessCalls++; throw new LlmError("CONTEXT_WINDOW_EXCEEDED"); }
      summaryCalls++;
      const start = (await reader.read()).at(-1);
      if (mode === "summary-pending" && start?.type === "compaction/start") {
        fault = injectCompactionSqliteFault(t, {
          path, sessionId: seed.header.sessionId, compactionId: start.data.compactionId, kind: "success", firstSeq: start.seq + 1, mode: "committed",
        });
      }
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "待持久化的摘要" } };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  } });
  const driver = createModelTurnDriver({
    runtime, config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "system",
    recoverOverflow: (context, operations) => {
      recoveryCalls++;
      return recoverContextOverflow(context, operations, () => {});
    },
  });
  const agents = new AgentManager(store, driver);
  try {
    const agent = await agents.load(seed.header.sessionId);
    const observed: AgentObservation[] = [];
    agent.onObservation(notice => observed.push(notice));
    agent.prompt({ requestId: "new", content: [{ type: "text", text: "当前问题" }] });
    await agent.waitForIdle();
    assert.deepEqual([businessCalls, summaryCalls, recoveryCalls], mode === "attempt-flush" ? [1, 0, 0] : [1, 1, 1]);
    assert.equal(agent.storageOpen, false);
    const events = agent.session.snapshot().events;
    const durable = await reader.read();
    const end = events.find(event => event.type === "turn/end" && event.data.turn === 2);
    const attempt = events.find(event => event.type === "assistant/attempt" && event.data.turn === 2);
    assert.ok(attempt);
    assert.ok(observed.some(notice => notice.type === "assistant-stream" && notice.frame.type === "end" &&
      notice.frame.outcome.kind === "committed" && notice.frame.outcome.seq === attempt.seq));
    if (mode === "summary-pending") {
      assert.ok(fault);
      assert.equal(fault.targetCommits, 1);
      assert.equal(end, undefined);
      assert.equal(observed.some(notice => notice.type === "agent/error"), false);
    } else {
      assert.ok(end?.type === "turn/end" && end.data.reason.kind === "error");
      assert.deepEqual(observed.find(notice => notice.type === "agent/error"), { type: "agent/error", turn: 2, message: "本轮执行失败" });
    }
    assert.equal(durable.some(event => event.seq === attempt.seq), mode !== "attempt-flush");
    assert.equal(durable.some(event => event.type === "compaction/summary"), mode !== "attempt-flush");
    assert.equal(durable.some(event => event.type === "request/header" && event.data.reason === "series"), false);

    if (mode === "summary-pending") fault?.release();
    else inject.exec("DROP TRIGGER reject_checkpoint");
    await agent.recoverStorage();
    assert.equal(agent.storageOpen, true);
    const recovered = await reader.read();
    assert.equal(recovered.filter(event => event.type === "assistant/attempt" && event.data.turn === 2).length, 1);
    assert.equal(recovered.filter(event => event.type === "turn/end" && event.data.turn === 2).length, 1);
    assert.equal(businessCalls, 1);
  } finally {
    fault?.restore();
    inject.exec("DROP TRIGGER IF EXISTS reject_checkpoint");
    inject.close();
    try { await agents.close(); } finally {
      await reader.close(); await observer.close(); await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});
