import { SessionDirectory } from "./directory.ts";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import Fastify from "fastify";
import { Session, SqliteSessionPersistence } from "@mharness/session/server";
import { followFrameSchema, rawSessionHistorySchema } from "@mharness/session/contracts";
import { commitCompactionBatch } from "../agent/compaction-lifecycle.ts";
import { selectModelCompactionPrefix } from "../agent/compaction-selection.ts";
import { createRequestPreparer } from "../agent/request-context.ts";
import { ReActAgent, type RunTurn } from "../agent/react-agent.ts";
import { LlmRuntime } from "../model/runtime.ts";
import type { ModelInput, ModelTool } from "../model/adapter.ts";
import { registerSessionRoutes } from "./routes.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return await Promise.race([Promise.reject(signal.reason), promise]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => reject(new Error("等待测试事件超时")), 5000);
    })]);
  } finally { if (timer) clearTimeout(timer); signal.removeEventListener("abort", abort); }
}

async function waitForEntry(entered: Promise<void>, work: Promise<unknown>, signal: AbortSignal): Promise<void> {
  await bounded(Promise.race([entered, work.then(() => { throw new Error("摘要在模型进入前完成"); }, (error: unknown) => { throw error; })]), signal);
}

test("模型未进入时提前完成、失败和取消都结束等待", async () => {
  const entry = deferred();
  const controller = new AbortController();
  await assert.rejects(waitForEntry(entry.promise, Promise.resolve(), controller.signal), /模型进入前完成/);
  const fault = new Error("提前失败");
  await assert.rejects(waitForEntry(entry.promise, Promise.reject(fault), controller.signal), (error) => error === fault);
  const waiting = waitForEntry(entry.promise, new Promise(() => {}), controller.signal);
  controller.abort(fault);
  await assert.rejects(waiting, (error) => error === fault);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const active = new AbortController();
  await waitForEntry(Promise.resolve(), new Promise(() => {}), active.signal);
  assert.equal(getEventListeners(active.signal, "abort").length, 0);
});

for (const outcome of ["完成", "失败"] as const) test(`预先取消后仍接管提前${outcome}的工作`, async () => {
  const controller = new AbortController();
  const reason = new Error("预先取消");
  controller.abort(reason);
  const work = outcome === "完成" ? Promise.resolve() : Promise.reject(new Error("工作失败"));
  await assert.rejects(waitForEntry(deferred().promise, work, controller.signal), (error) => error === reason);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

async function fixture(runTurn: RunTurn = async () => {}) {
  const dir = await mkdtemp(join(tmpdir(), "summary-acceptance-"));
  const path = join(dir, "session.sqlite");
  const store = new SqliteSessionPersistence(path);
  const session = new Session({ sessionId: "summary", createdAt: 1 });
  const handle = await store.create(session.header);
  await handle.flush();
  const agent = new ReActAgent(session, runTurn, handle);
  store.bindWriter(handle, session, (error) => agent.blockStorage(error));
  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  const reader = await observer.open("summary", "read");
  assert.ok(reader);
  session.append({ type: "turn/start", data: { turn: 1 } });
  session.append({ type: "user/message", surfaceOp: "append", data: { id: "old-user", role: "user", turn: 1, requestId: "old", source: { kind: "user" }, content: [{ type: "text", text: "旧任务内容".repeat(4000) }] } });
  session.append({ type: "step/start", data: { turn: 1, step: 1 } });
  const declaration = session.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "call-message", role: "assistant", source: { provider: "mock", model: "business" }, content: [{ type: "tool-call", id: "call", name: "read", arguments: "{}" }] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true } });
  const call = session.append({ type: "tool/call", data: { turn: 1, step: 1, callId: "call", name: "read", arguments: "{}" } });
  session.append({ type: "tool/operation", data: { turn: 1, step: 1, callId: "call", operationId: "operation", toolName: "read", toolVersion: "1", validatedArgs: {} } });
  session.append({ type: "approval/asked", data: { id: "approval", operationId: "operation", toolName: "read", callId: "call", reason: "policy" } });
  session.append({ type: "approval/decided", data: { id: "approval", outcome: "allowed-once" } });
  const original = session.append({ type: "tool/result", surfaceOp: "append", sourceEventSeqs: [call.seq], data: { turn: 1, step: 1, operationId: "operation", message: { id: "result", role: "user", source: { kind: "tool", callId: "call" }, content: [{ type: "tool-result", toolCallId: "call", isError: false, content: ["ORIGINAL_PRIVATE_RESULT".repeat(200)] }] } } });
  session.append({ type: "step/end", data: { turn: 1, step: 1 } });
  session.append({ type: "step/start", data: { turn: 1, step: 2 } });
  const assistant = session.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 2, message: { id: "answer", role: "assistant", source: { provider: "mock", model: "business" }, content: [{ type: "text", text: "旧轮次结论" }] }, finishReason: { kind: "stop" }, stream: [], includeInModelContext: true } });
  session.append({ type: "step/end", data: { turn: 1, step: 2 } });
  session.append({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  session.append({ type: "turn/start", data: { turn: 2 } });
  const tail = session.append({ type: "user/message", surfaceOp: "append", data: { id: "tail", role: "user", turn: 2, requestId: "tail", source: { kind: "user" }, content: [{ type: "text", text: "RETAINED_TAIL" }] } });
  session.append({ type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } });
  const context = { session, storageOpen: () => agent.storageOpen, blockStorage: (error: unknown) => agent.blockStorage(error) };
  const prune = await commitCompactionBatch(context, () => [
    { type: "compaction/prune", data: { shadowedSeq: original.seq, beforeTokens: 1000 } },
    { type: "tool/result", surfaceOp: { op: "replace", start: original.seq, end: original.seq }, sourceEventSeqs: [original.seq], data: { ...original.data, message: { ...original.data.message, content: [{ type: "tool-result", toolCallId: "call", isError: false, content: ["PRUNED_RESULT"] }] } } },
  ]);
  assert.equal(prune.status, "committed");
  await session.flush();
  const persisted = await reader.read();
  assert.deepEqual(persisted, session.snapshot().events);
  const replacement = session.deriveSurfaceNodes().find((node) => node.type === "tool/result");
  assert.ok(replacement && replacement.seq > assistant.seq);
  assert.ok(declaration.seq < original.seq);
  return { dir, path, store, observer, reader, session, agent, handle, original, assistant, tail, replacement, context, persisted,
    async close() {
      agent.beginStop();
      try { await bounded(agent.stop(), AbortSignal.timeout(3000)); }
      finally {
        try { await reader.close(); }
        finally {
          try { await handle.close(); }
          finally { await observer.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
        }
      }
    } };
}

async function follow(origin: string, signal: AbortSignal) {
  const response = await fetch(`${origin}/api/sessions/summary/follow`, { signal });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return { reader, async next() {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (frame.startsWith("data: ")) return followFrameSchema.parse(JSON.parse(frame.slice(6)) as unknown);
      } else {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE 提前关闭");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    }
  } };
}

test("真实旧轮次与修剪夹具完整落盘，选区保留 surface 顺序和尾部", async () => {
  const f = await fixture();
  try {
    const runtime = new LlmRuntime({ mock: { async *generate() { yield { type: "finish", reason: { kind: "stop" } }; } } });
    const selection = selectModelCompactionPrefix(f.session, 0, runtime.prepare({ provider: "mock", model: "business" }), []);
    assert.ok(selection);
    assert.ok(selection.shadowedSeqs.includes(f.replacement.seq));
    assert.ok(!selection.shadowedSeqs.includes(f.original.seq));
    assert.ok(selection.shadowedSeqs.indexOf(f.replacement.seq) < selection.shadowedSeqs.indexOf(f.assistant.seq));
    assert.ok(!selection.shadowedSeqs.includes(f.tail.seq));
    assert.match(JSON.stringify(f.persisted), /ORIGINAL_PRIVATE_RESULT/);
    assert.ok(f.persisted.some((event) => event.type === "approval/decided"));
  } finally { await f.close(); }
});

for (const kind of ["manual", "turn"] as const) test(`SQLite 摘要身份与用量贯穿持久化和传输：${kind}`, { timeout: 15000 }, async (t) => {
  const { commitCompactionSummary } = await import("../agent/commit-compaction-summary.ts");
  let resolveDone!: (result: Awaited<ReturnType<typeof commitCompactionSummary>>) => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<Awaited<ReturnType<typeof commitCompactionSummary>>>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  let run: (signal: AbortSignal, turn: number) => Promise<void> = async () => { throw new Error("Turn 未准备"); };
  const f = await fixture(async ({ signal, turn }) => { try { await run(signal, turn); } catch (error) { rejectDone(error); } });
  const controller = new AbortController();
  const reconnectController = new AbortController();
  const app = Fastify();
  registerSessionRoutes(app, "/api/sessions", f.observer, { prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }) }, { get: () => f.agent, onLoaded: () => () => {} }, () => new SessionDirectory());
  try {
    if (kind === "manual") {
      f.session.append({ type: "command/run", data: { commandId: "command-fixed", name: "compact", source: { kind: "user" } } });
      await f.session.flush();
    }
    const runtime = new LlmRuntime({ mock: { async *generate() {
      assert.equal(f.agent.state, kind === "manual" ? "maintenance" : "running");
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "摘要" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "摘要" } };
      yield { type: "usage", usage: { inputTokens: 17, outputTokens: 3 } };
      yield { type: "finish", reason: { kind: "stop" } };
    } } });
    const options = { runtime, businessModel: runtime.prepare({ provider: "mock", model: "business" }), businessTools: [], retainTokens: 0 };
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const stream = await follow(origin, AbortSignal.any([controller.signal, t.signal]));
    const snapshot = await bounded(stream.next(), t.signal);
    assert.ok(snapshot.type === "snapshot");
    let work: Promise<Awaited<ReturnType<typeof commitCompactionSummary>>>;
    if (kind === "manual") {
      work = f.agent.runMaintenance((signal) => commitCompactionSummary({ ...f.context, signal, turn: null, identity: { compactionId: "compact-fixed", sourceCommandId: "command-fixed" } }, options));
    } else {
      run = async (signal, turn) => { resolveDone(await commitCompactionSummary({ ...f.context, signal, turn }, options)); };
      f.agent.prompt({ requestId: "turn-request", content: [{ type: "text", text: "新轮次" }] });
      work = done;
    }
    const result = await bounded(work, t.signal);
    assert.ok(result.status === "succeeded");
    if (kind === "turn") await f.agent.waitForIdle();
    const expected = kind === "manual" ? { compactionId: "compact-fixed", sourceCommandId: "command-fixed", turn: null } : { compactionId: result.attempt.compactionId, turn: 3 };
    assert.deepEqual(result.attempt, expected);
    const persisted = await f.reader.read();
    const start = persisted.find((event) => event.type === "compaction/start");
    const summary = persisted.find((event) => event.type === "compaction/summary");
    const end = persisted.find((event) => event.type === "compaction/end");
    const checkpoint = persisted.find((event) => event.type === "user/message" && event.data.source.kind === "compact");
    assert.ok(start?.type === "compaction/start" && summary?.type === "compaction/summary" && end?.type === "compaction/end" && checkpoint?.type === "user/message");
    if (kind === "manual") assert.deepEqual(persisted.find((event) => event.type === "command/run")?.data, { commandId: "command-fixed", name: "compact", source: { kind: "user" } });
    assert.deepEqual(start.data, expected);
    assert.deepEqual(end.data, { ...expected, status: "succeeded" });
    assert.equal(summary.data.compactionId, expected.compactionId);
    assert.deepEqual(summary.data.usage, { inputTokens: 17, outputTokens: 3 });
    assert.equal(summary.data.sourceCommandId, kind === "manual" ? "command-fixed" : undefined);
    assert.ok(checkpoint.data.source.kind === "compact");
    assert.equal(checkpoint.data.source.compactionId, expected.compactionId);
    assert.equal("sourceCommandId" in checkpoint.data ? checkpoint.data.sourceCommandId : undefined, kind === "manual" ? "command-fixed" : undefined);
    const received = [];
    for (let seq = snapshot.cursor + 1; seq <= end.seq; seq++) {
      const frame = await bounded(stream.next(), t.signal);
      assert.ok(frame.type === "event");
      received.push(frame.event);
    }
    assert.deepEqual(received, persisted.slice(snapshot.cursor + 1, end.seq + 1));
    const response = await fetch(`${origin}/api/sessions/summary`);
    assert.equal(response.status, 200);
    const history = rawSessionHistorySchema.parse(await response.json());
    assert.deepEqual(history.records.map(({ event }) => event), persisted);
    assert.equal(history.cursor, persisted.at(-1)?.seq);
    const reconnect = await follow(origin, AbortSignal.any([reconnectController.signal, t.signal]));
    const again = await bounded(reconnect.next(), t.signal);
    assert.ok(again.type === "snapshot");
    assert.deepEqual(again.records, history.records);
    assert.equal(again.cursor, history.cursor);
  } finally {
    controller.abort(); reconnectController.abort();
    app.server.closeAllConnections();
    try { await app.close(); } finally { await f.close(); }
  }
});

for (const mode of ["成功", "回滚", "提交结果未知"] as const) test(`SQLite 摘要批次的原子可见性与传输：${mode}`, { timeout: 15000 }, async (t) => {
  const f = await fixture();
  const firstController = new AbortController();
  const reconnectController = new AbortController();
  const app = Fastify();
  const agents = { get: () => f.agent, onLoaded: () => () => {} };
  registerSessionRoutes(app, "/api/sessions", f.observer, { prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }) }, agents, () => new SessionDirectory());
  const entered = deferred(); const release = deferred();
  let captured: ModelInput | undefined;
  const runtime = new LlmRuntime({ mock: { async *generate(input) {
    captured = input;
    const prefix = await f.reader.read();
    assert.deepEqual(prefix.slice(0, -1), f.persisted);
    assert.equal(prefix.at(-1)?.type, "compaction/start");
    entered.resolve(); await release.promise;
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "简短摘要" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "简短摘要" } };
    yield { type: "finish", reason: { kind: "stop" } };
  } } });
  const businessTools: readonly ModelTool[] = [{ name: "read", inputSchema: {} }];
  const preparer = createRequestPreparer({ runtime, config: () => ({ provider: "mock", model: "business" }), systemPrompt: () => "BUSINESS_SYSTEM", tools: () => businessTools });
  const fixed = preparer.snapshot();
  let writer: DatabaseSync | undefined; let enabled = false; let failRead = false; let hits = 0;
  const failure = new Error("目标摘要提交故障");
  const sqlObserver = new DatabaseSync(f.path, { readOnly: true });
  const execute = DatabaseSync.prototype.exec;
  const prepare = DatabaseSync.prototype.prepare;
  const execMock = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (enabled && sql === "BEGIN IMMEDIATE") writer = this;
    if (enabled && this === writer && this.isTransaction && sql === "COMMIT") {
      const rows = prepare.call(this, "SELECT event_json FROM mh_events WHERE session_id=? ORDER BY seq DESC LIMIT 3").all("summary");
      const events = rows.map((row) => JSON.parse(String(row.event_json)) as { type: string; seq: number; data: { compactionId?: string }; sourceEventSeqs?: number[] }).reverse();
      if (events.map((event) => event.type).join(",") === "compaction/summary,user/message,compaction/end") {
        hits++;
        assert.deepEqual(events.map((event) => event.seq), [f.persisted.length + 1, f.persisted.length + 2, f.persisted.length + 3]);
        assert.equal(events[0]?.data.compactionId, events[2]?.data.compactionId);
        assert.equal(events[1]?.sourceEventSeqs?.[0], events[0]?.seq);
        const visible = prepare.call(sqlObserver, "SELECT event_json FROM mh_events WHERE session_id=? ORDER BY seq").all("summary");
        assert.equal(visible.length, f.persisted.length + 1);
        assert.equal(JSON.parse(String(visible.at(-1)?.event_json)).type, "compaction/start");
        assert.equal(f.session.snapshot().events.at(-1)?.type, "compaction/end");
        assert.equal(f.session.replaceGeneration, generation + 1);
        if (mode === "回滚") throw failure;
        execute.call(this, sql);
        if (mode === "提交结果未知") { failRead = true; throw failure; }
        return;
      }
    }
    execute.call(this, sql);
  });
  const prepareMock = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (failRead && sql.startsWith("SELECT header_json, inherited_count, event_count")) { failRead = false; throw new Error("核对读取故障"); }
    return prepare.call(this, sql);
  });
  const beforeSurface = f.session.deriveSurfaceNodes();
  const generation = f.session.replaceGeneration;
  const notifications: { seq: number; events: ReturnType<Session["snapshot"]>["events"]; surface: ReturnType<Session["deriveSurfaceNodes"]>; generation: number }[] = [];
  f.session.on("session/event", (event) => { if (event.type !== "compaction/start") notifications.push({ seq: event.seq, events: f.session.snapshot().events, surface: f.session.deriveSurfaceNodes(), generation: f.session.replaceGeneration }); });
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const get = async () => { const response = await fetch(`${origin}/api/sessions/summary`); assert.equal(response.status, 200); return rawSessionHistorySchema.parse(await response.json()); };
    const initial = await get();
    assert.deepEqual(initial.records.map(({ event }) => event), f.persisted);
    const first = await follow(origin, AbortSignal.any([firstController.signal, t.signal]));
    const snapshot = await bounded(first.next(), t.signal); assert.equal(snapshot.type, "snapshot");
    assert.ok(snapshot.type === "snapshot"); assert.deepEqual(snapshot.records, initial.records);
    const { commitCompactionSummary } = await import("../agent/commit-compaction-summary.ts");
    const work = f.agent.runMaintenance((signal) => commitCompactionSummary({ ...f.context, turn: null, signal }, { runtime, businessModel: fixed.prepared, businessTools, retainTokens: 0 }));
    await waitForEntry(entered.promise, work, t.signal);
    const start = await bounded(first.next(), t.signal); assert.ok(start.type === "event" && start.event.type === "compaction/start");
    assert.deepEqual(start.event, (await f.reader.read()).at(-1));
    assert.doesNotMatch(JSON.stringify(captured), /ORIGINAL_PRIVATE_RESULT|RETAINED_TAIL|BUSINESS_SYSTEM/);
    assert.match(JSON.stringify(captured), /PRUNED_RESULT/);
    enabled = true; release.resolve();
    const result = await bounded(work, t.signal);
    enabled = false;
    assert.equal(hits, 1);
    const persisted = await f.reader.read();
    if (mode !== "成功") {
      assert.equal(result.status, "commit-checkpoint-failed");
      assert.equal(result.side, "success");
      assert.equal(result.error, failure);
      assert.equal(f.agent.storageOpen, false);
      assert.equal(notifications.length, 3);
      const live = f.session.snapshot().events.slice(-3);
      for (const event of live) assert.deepEqual(await bounded(first.next(), t.signal), { type: "event", event });
      assert.equal(f.session.replaceGeneration, generation + 1);
      assert.equal(persisted.length, f.persisted.length + (mode === "回滚" ? 1 : 4));
      return;
    }
    assert.equal(result.status, "succeeded"); assert.ok(result.status === "succeeded");
    const frames = [await bounded(first.next(), t.signal), await bounded(first.next(), t.signal), await bounded(first.next(), t.signal)];
    assert.ok(frames.every((frame) => frame.type === "event"));
    const batch = persisted.slice(-3);
    assert.deepEqual(frames.map((frame) => frame.type === "event" ? frame.event : undefined), batch);
    assert.deepEqual(batch.map((event) => event.type), ["compaction/summary", "user/message", "compaction/end"]);
    const [summary, checkpoint, end] = batch;
    assert.ok(summary?.type === "compaction/summary" && checkpoint?.type === "user/message" && end?.type === "compaction/end");
    const selected = beforeSurface.slice(0, -1).map((node) => node.seq);
    assert.equal(result.summarySeq, summary.seq);
    assert.deepEqual(summary.data.shadowedSeqs, selected);
    assert.deepEqual(checkpoint.sourceEventSeqs, [summary.seq, ...selected]);
    assert.deepEqual(checkpoint.surfaceOp, { op: "replace", start: selected[0], end: selected.at(-1) });
    assert.equal(summary.data.compactionId, result.attempt.compactionId);
    assert.deepEqual(end.data, { ...result.attempt, status: "succeeded" });
    assert.deepEqual(summary.data.route, fixed.prepared.route);
    assert.equal(notifications.length, 3);
    assert.deepEqual(notifications.map((notice) => notice.seq), batch.map((event) => event.seq));
    assert.deepEqual(notifications[0]?.events, persisted);
    assert.equal(notifications[0]?.generation, generation + 1);
    assert.deepEqual(notifications[0]?.surface, f.session.deriveSurfaceNodes());
    assert.deepEqual(f.session.deriveSurfaceNodes().map((node) => node.seq), [checkpoint.seq, f.tail.seq]);
    const sentinel = f.session.append({ type: "turn/start", data: { turn: 3 } });
    await f.session.flush();
    const sentinelFrame = await bounded(first.next(), t.signal);
    assert.deepEqual(sentinelFrame, { type: "event", event: sentinel });
    const withSentinel = await f.reader.read();
    assert.deepEqual(withSentinel, [...persisted, sentinel]);
    const after = await get(); assert.deepEqual(after.records.map(({ event }) => event), withSentinel);
    assert.equal(after.cursor, sentinel.seq);
    firstController.abort();
    await first.reader.cancel().catch(() => {});
    const reconnect = await follow(origin, AbortSignal.any([reconnectController.signal, t.signal])); const again = await bounded(reconnect.next(), t.signal);
    assert.ok(again.type === "snapshot"); assert.deepEqual(again.records, after.records);
    assert.equal(again.cursor, sentinel.seq);
    assert.equal(again.assistantStream.revision, snapshot.assistantStream.revision);
    assert.equal(again.assistantStream.activeAttempt, undefined);
    reconnectController.abort();
    await reconnect.reader.cancel().catch(() => {});
    const restored = new Session(f.session.header, { seed: { kind: "restore", events: persisted, inheritedEventCount: 0 } });
    assert.deepEqual(restored.deriveSurfaceNodes(), f.session.deriveSurfaceNodes());
    assert.deepEqual(restored.deriveMessages(), f.session.deriveMessages());
    const business = preparer(restored, false, fixed);
    assert.equal(business.input.systemPrompt, "BUSINESS_SYSTEM");
    assert.deepEqual(business.input.tools, businessTools);
    assert.equal(business.prepared, fixed.prepared);
    assert.equal(business.input.messages.length, 2);
    assert.match(JSON.stringify(business.input.messages), /简短摘要/);
    assert.match(JSON.stringify(business.input.messages), /RETAINED_TAIL/);
    assert.doesNotMatch(JSON.stringify(business.input.messages), /ORIGINAL_PRIVATE_RESULT|PRUNED_RESULT/);
  } finally {
    enabled = false; release.resolve(); firstController.abort(); reconnectController.abort(); execMock.mock.restore(); prepareMock.mock.restore(); sqlObserver.close();
    // fetch 取消后仍可能留下本地连接，测试服务器关闭前需主动释放。
    app.server.closeAllConnections();
    try { await app.close(); } finally { await f.close(); }
  }
});
