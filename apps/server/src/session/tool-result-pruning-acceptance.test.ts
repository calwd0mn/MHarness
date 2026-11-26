import { SessionDirectory } from "./directory.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Session, SqliteSessionPersistence, type SessionAppendInput } from "@mharness/session/server";
import { snapshotSessionEvent } from "../../../../packages/session/src/events.ts";
import { commitCompactionBatch } from "../agent/compaction-lifecycle.ts";
import { commitToolResultPruning } from "../agent/commit-tool-result-pruning.ts";
import { createModelTurnDriver } from "../agent/model-turn.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { createMockAdapter } from "../model/providers/mock.ts";
import { followFrameSchema, rawSessionEventFrameSchema } from "@mharness/session/contracts";
import Fastify from "fastify";
import { registerSessionRoutes } from "./routes.ts";
import { followSession } from "./follow.ts";
import { ReActAgent } from "../agent/react-agent.ts";
import { z } from "zod";
import { ToolRegistry, defineLocalTool } from "../tools/registry.ts";
import { defineLocalToolOutput } from "../tools/result.ts";
import { runToolBatch } from "../tools/batch.ts";
import { ApprovalService } from "../approval/service.ts";
import { injectCompactionSqliteFault } from "./compaction-settlement-sqlite-fixture.ts";

function sessionWithResult() {
  const session = new Session({ sessionId: "s", createdAt: 1 });
  session.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "a", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "tool-call", id: "c", name: "read", arguments: "{}" }] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true } });
  const original = session.append({ type: "tool/result", surfaceOp: "append", sourceEventSeqs: [0], data: { turn: 1, step: 1, message: { id: "r", role: "user", source: { kind: "tool", callId: "c" }, content: [{ type: "tool-result", toolCallId: "c", isError: false, content: [{ type: "text", text: "long" }] }] } } });
  session.bindCheckpoint(async () => {}, async (_events, finish) => { const result = { status: "committed" } as const; finish(result); return result; });
  return { session, original };
}

test("修剪标记必须与当前工具替换紧邻，完整批次可重放", async () => {
  const { session, original } = sessionWithResult();
  const marker = { type: "compaction/prune", data: { shadowedSeq: original.seq, beforeTokens: 10 } } as const;
  const replacement = { type: "tool/result", surfaceOp: { op: "replace", start: original.seq, end: original.seq }, sourceEventSeqs: [original.seq], data: original.data } as const;
  const header = { type: "request/header", data: { header: { config: { provider: "p", model: "m" } }, reason: "initial" } } as const;
  const context = { session, storageOpen: () => true, blockStorage: () => assert.fail() };
  const before = session.snapshot();
  await assert.rejects(commitCompactionBatch(context, () => [marker, header, replacement]));
  await assert.rejects(commitCompactionBatch(context, () => [marker]));
  assert.throws(() => session.append(marker));
  assert.deepEqual(session.snapshot(), before);
  const result = await commitCompactionBatch(context, () => [marker, replacement]);
  assert.equal(result.status, "committed");
  const events = session.snapshot().events;
  const restored = new Session({ sessionId: "s", createdAt: 1 }, { seed: { kind: "restore", events, inheritedEventCount: 0 } });
  assert.deepEqual(restored.deriveMessages(), session.deriveMessages());
  assert.throws(() => new Session({ sessionId: "s", createdAt: 1 }, { seed: { kind: "restore", events: events.slice(0, -1), inheritedEventCount: 0 } }));
  assert.throws(() => new Session({ sessionId: "fork", createdAt: 1, isSeeded: true, parentSession: "s" }, { seed: { kind: "fork", events: events.slice(0, -1) } }));
  const legacy = sessionWithResult().session;
  assert.equal((await commitCompactionBatch({ ...context, session: legacy }, () => [header, replacement])).status, "committed");
});

test("非法修剪载荷、目标与来源在暂存前拒绝且不污染当前状态", async () => {
  const { session, original } = sessionWithResult();
  const marker = { type: "compaction/prune", data: { shadowedSeq: original.seq, beforeTokens: 10 } } as const;
  const replacement = { type: "tool/result", surfaceOp: { op: "replace", start: original.seq, end: original.seq }, sourceEventSeqs: [original.seq], data: original.data } as const;
  const extra = { ...marker, data: { ...marker.data, extra: true } };
  const cases: readonly (readonly SessionAppendInput[])[] = [
    [extra, replacement],
    [{ ...marker, data: { ...marker.data, beforeTokens: -1 } }, replacement],
    [{ ...marker, data: { ...marker.data, beforeTokens: 0.5 } }, replacement],
    [{ ...marker, data: { ...marker.data, beforeTokens: Number.MAX_SAFE_INTEGER + 1 } }, replacement],
    [{ ...marker, data: { ...marker.data, shadowedSeq: 0 } }, replacement],
    [{ ...marker, data: { ...marker.data, shadowedSeq: 100 } }, replacement],
    [marker, { ...replacement, surfaceOp: { op: "replace", start: 0, end: original.seq } }],
    [marker, { ...replacement, sourceEventSeqs: [0] }],
    [marker, { ...replacement, data: { ...original.data, step: 2 } }],
    [marker, { ...replacement, data: { ...original.data, message: { ...original.data.message, id: "other" } } }],
    [replacement, marker],
  ];
  const before = session.snapshot(); const nodes = session.deriveSurfaceNodes(); const messages = session.deriveMessages();
  const notifications: number[] = []; session.on("session/event", (event) => notifications.push(event.seq));
  const context = { session, storageOpen: () => true, blockStorage: () => assert.fail() };
  for (const batch of cases) {
    await assert.rejects(commitCompactionBatch(context, () => batch));
    assert.deepEqual(session.snapshot(), before); assert.deepEqual(session.deriveSurfaceNodes(), nodes);
    assert.deepEqual(session.deriveMessages(), messages); assert.equal(session.replaceGeneration, 0); assert.deepEqual(notifications, []);
  }
  assert.equal((await commitCompactionBatch(context, () => [marker, replacement])).status, "committed");
  await assert.rejects(commitCompactionBatch(context, () => [marker, replacement]));
});

test("恢复和分支拒绝中断的标记及插入事件，完整配对可继承", async () => {
  const { session, original } = sessionWithResult();
  const context = { session, storageOpen: () => true, blockStorage: () => assert.fail() };
  const marker = { type: "compaction/prune", data: { shadowedSeq: original.seq, beforeTokens: 10 } } as const;
  const replacement = { type: "tool/result", surfaceOp: { op: "replace", start: original.seq, end: original.seq }, sourceEventSeqs: [original.seq], data: original.data } as const;
  assert.equal((await commitCompactionBatch(context, () => [marker, replacement])).status, "committed");
  const complete = session.snapshot().events;
  const header = snapshotSessionEvent({ type: "request/header", data: { header: { config: { provider: "p", model: "m" } }, reason: "initial" } }, 3, "append");
  const shiftedReplacement = snapshotSessionEvent({ ...replacement, time: 1 }, 4, "append");
  const broken = [...complete.slice(0, 3), header, shiftedReplacement];
  const wrongSource = snapshotSessionEvent({ ...replacement, sourceEventSeqs: [0], time: 1 }, 3, "append");
  const staleMarker = snapshotSessionEvent({ ...marker, time: 1 }, 4, "append");
  const staleReplacement = snapshotSessionEvent({ ...replacement, time: 1 }, 5, "append");
  for (const events of [complete.slice(0, -1), broken, [...complete.slice(0, 3), wrongSource], [...complete, staleMarker, staleReplacement]]) {
    assert.throws(() => new Session({ sessionId: "restore", createdAt: 1 }, { seed: { kind: "restore", events, inheritedEventCount: 0 } }));
    assert.throws(() => new Session({ sessionId: "fork", createdAt: 1, isSeeded: true, parentSession: "s" }, { seed: { kind: "fork", events } }));
  }
  const badPayload = [...complete.slice(0, 2), { ...complete[2], data: { shadowedSeq: original.seq, beforeTokens: 10, extra: true } }, complete[3]];
  assert.throws(() => new Session({ sessionId: "restore", createdAt: 1 }, { seed: { kind: "restore", events: badPayload, inheritedEventCount: 0 } }));
  const fork = new Session({ sessionId: "fork", createdAt: 1, isSeeded: true, parentSession: "s" }, { seed: { kind: "fork", events: complete } });
  assert.equal(fork.inheritedEventCount, complete.length);
  assert.equal(fork.snapshot().events.at(-1)?.type, "session/end-seed");
  assert.deepEqual(fork.deriveMessages(), session.deriveMessages());
  const replay = new Session(fork.header, { seed: { kind: "restore", events: fork.snapshot().events, inheritedEventCount: complete.length } });
  assert.deepEqual(replay.deriveSurfaceNodes(), fork.deriveSurfaceNodes());
});

for (const mode of ["uncommitted", "committed"] as const) test(`SQLite 修剪待核对时区分持久视图和在线视图：${mode}`, async (testContext) => {
  const dir = await mkdtemp(join(tmpdir(), "prune-sqlite-"));
  const path = join(dir, "db.sqlite");
  const store = new SqliteSessionPersistence(path);
  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  const session = new Session({ sessionId: "sql", createdAt: 1 });
  const handle = await store.create(session.header);
  await handle.flush();
  store.bindWriter(handle, session, () => {});
  session.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "a", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "tool-call", id: "c", name: "read", arguments: "{}" }] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true } });
  session.append({ type: "tool/result", surfaceOp: "append", sourceEventSeqs: [0], data: { turn: 1, step: 1, message: { id: "r", role: "user", source: { kind: "tool", callId: "c" }, content: [{ type: "tool-result", toolCallId: "c", isError: false, content: [{ type: "text", text: "x".repeat(8193) }] }] } } });
  await session.flush();
  const reader = await observer.open("sql", "read"); assert.ok(reader);
  let modelCalls = 0;
  let hookCalls = 0;
  const runtime = new LlmRuntime({ mock: createMockAdapter(() => {
    modelCalls++;
    return [{ chunk: { type: "text", delta: "回复" } }, { chunk: { type: "finish", reason: { kind: "stop" } } }];
  }) });
  const driver = createModelTurnDriver({
    runtime, config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "",
    preStep: async () => { hookCalls++; },
  });
  const agent = new ReActAgent(session, driver, handle);
  const agents = { get: () => agent, onLoaded: () => () => {} };
  const app = Fastify();
  registerSessionRoutes(app, "/sessions", observer, { prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }) }, agents, () => new SessionDirectory());
  const signal = new AbortController();
  const stream = followSession(agents, async () => undefined, "sql", signal.signal);
  assert.match((await stream.next()).value ?? "", /"cursor":1/);
  const before = session.snapshot();
  const observed: { eventSeq: number; sessionSeq: number; generation: number; surfaceSeqs: number[] }[] = [];
  session.on("session/event", (event) => observed.push({
    eventSeq: event.seq, sessionSeq: session.seq, generation: session.replaceGeneration,
    surfaceSeqs: session.deriveSurfaceNodes().map((node) => node.seq),
  }));
  let faultEnabled = true; let loseRead = false; let writer: DatabaseSync | undefined;
  const exec = DatabaseSync.prototype.exec;
  const writeFault = testContext.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE") writer = this;
    if (this === writer && faultEnabled && mode === "uncommitted" && (sql === "COMMIT" || sql === "ROLLBACK")) throw new Error("transaction unavailable");
    exec.call(this, sql);
    if (this === writer && faultEnabled && mode === "committed" && sql === "COMMIT") { faultEnabled = false; loseRead = true; throw new Error("response lost"); }
  });
  const prepare = DatabaseSync.prototype.prepare;
  const readFault = testContext.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (loseRead && sql.startsWith("SELECT header_json, inherited_count, event_count")) { loseRead = false; throw new Error("read unavailable"); }
    return prepare.call(this, sql);
  });
  try {
    const prepared = runtime.prepare({ provider: "mock", model: "m" });
    const result = await commitToolResultPruning({ session, storageOpen: () => agent.storageOpen, blockStorage: (error) => agent.blockStorage(error) }, prepared, []);
    assert.equal(result.status, "pending-reconciliation"); assert.equal(agent.storageOpen, false);
    assert.throws(() => agent.prompt({ requestId: "blocked", content: [{ type: "text", text: "新请求" }] }), { code: "storage_blocked" });
    assert.equal(modelCalls, 0);
    assert.deepEqual(session.snapshot(), before); assert.equal(session.replaceGeneration, 0); assert.deepEqual(observed, []);
    const driveProbe = async (storageOpen: () => boolean) => {
      const probe = new Session({ sessionId: "drive-probe", createdAt: 1 });
      probe.bindCheckpoint(async () => {});
      probe.append({ type: "turn/start", data: { turn: 1 } });
      probe.append({ type: "user/message", surfaceOp: "append", data: { id: "u", role: "user", source: { kind: "user" }, turn: 1, requestId: "r", content: [{ type: "text", text: "测试" }] } });
      await driver({ session: probe, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => assert.fail("检查点不应失败"), storageOpen });
      return probe.snapshot().events;
    };
    const blockedEvents = await driveProbe(() => agent.storageOpen);
    assert.equal(hookCalls, 1);
    assert.equal(modelCalls, 0);
    assert.equal(blockedEvents.some((event) => event.type === "step/start"), false);
    const controlEvents = await driveProbe(() => true);
    assert.equal(hookCalls, 2);
    assert.equal(modelCalls, 1);
    assert.ok(controlEvents.some((event) => event.type === "assistant/message"));
    const persisted = await reader.read();
    assert.equal(persisted.length, mode === "committed" ? 4 : 2);
    const response = await app.inject({ method: "GET", url: "/sessions/sql" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().records.map((record: { event: unknown }) => record.event), persisted);
    const reconnectSignal = new AbortController();
    const reconnect = followSession(agents, async () => undefined, "sql", reconnectSignal.signal);
    assert.match((await reconnect.next()).value ?? "", /"cursor":1/);
    reconnectSignal.abort(); await reconnect.return(undefined);
    if (mode === "committed") assert.deepEqual(persisted.slice(2).map((event) => event.type), ["compaction/prune", "tool/result"]);
    faultEnabled = false;
    await session.flush(); await session.flush();
    assert.equal(session.seq, mode === "committed" ? 4 : 2);
    assert.equal(session.replaceGeneration, mode === "committed" ? 1 : 0);
    assert.deepEqual(observed, mode === "committed" ? [
      { eventSeq: 2, sessionSeq: 4, generation: 1, surfaceSeqs: [0, 3] },
      { eventSeq: 3, sessionSeq: 4, generation: 1, surfaceSeqs: [0, 3] },
    ] : []);
    assert.equal(modelCalls, 1);
    if (mode === "committed") {
      assert.match((await stream.next()).value ?? "", /compaction\/prune/);
      assert.match((await stream.next()).value ?? "", /tool\/result/);
    }
    assert.deepEqual(await reader.read(), session.snapshot().events);

  } finally {
    faultEnabled = false; writeFault.mock.restore(); readFault.mock.restore();
    signal.abort(); await stream.return(undefined); await app.close();
    await reader.close(); await handle.close(); await observer.close(); await store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("真实修剪按原节点计量并通过暂存提交，可重复调用", async () => {
  const session = new Session({ sessionId: "long", createdAt: 1 });
  session.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "a", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "tool-call", id: "c", name: "read", arguments: "{}" }] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true } });
  session.append({ type: "tool/result", surfaceOp: "append", sourceEventSeqs: [0], data: { turn: 1, step: 1, message: { id: "r", role: "user", source: { kind: "tool", callId: "c" }, content: [{ type: "tool-result", toolCallId: "c", isError: false, content: [{ type: "text", text: "😀".repeat(8193) }] }] } } });
  session.bindCheckpoint(async () => {}, async (_events, finish) => { const result = { status: "committed" } as const; finish(result); return result; });
  const prepared = new LlmRuntime({ mock: createMockAdapter(() => []) }).prepare({ provider: "mock", model: "m" });
  const context = { session, storageOpen: () => true, blockStorage: () => assert.fail() };
  const result = await commitToolResultPruning(context, prepared, []);
  assert.equal(result.status, "committed");
  const marker = session.snapshot().events[2];
  assert.equal(marker?.type, "compaction/prune");
  if (marker?.type === "compaction/prune") assert.deepEqual(marker.data, { shadowedSeq: 1, beforeTokens: 4109 });
  assert.equal(session.replaceGeneration, 1);
  for (const event of session.snapshot().events) {
    const frame = { type: "event" as const, event };
    assert.deepEqual(followFrameSchema.parse(frame), frame);
    assert.deepEqual(rawSessionEventFrameSchema.parse(frame), frame);
  }
  assert.equal((await commitToolResultPruning(context, prepared, [])).status, "unchanged");
  const pruned = session.deriveMessages();
  session.append({ type: "compaction/start", data: { compactionId: "summary", turn: null } });
  session.append({ type: "compaction/end", data: { compactionId: "summary", turn: null, status: "failed", reason: "fixture" } });
  assert.deepEqual(session.deriveMessages(), pruned);
  const original = session.snapshot().events[1];
  assert.equal(original?.type, "tool/result");
  if (original?.type === "tool/result") assert.deepEqual(original.data.message.content[0].content, [{ type: "text", text: "😀".repeat(8193) }]);
});

test("多节点同批提交并保留调用关联；回滚和预取消不改变 surface", async () => {
  const session = new Session({ sessionId: "many", createdAt: 1 });
  for (const step of [1, 2]) {
    const assistant = session.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step, message: { id: `a${step}`, role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "tool-call", id: "same", name: "read", arguments: "{}" }] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true } });
    session.append({ type: "tool/result", surfaceOp: "append", sourceEventSeqs: [assistant.seq], data: { turn: 1, step, meta: { step }, error: { name: "failure", code: "E" }, message: { id: `r${step}`, role: "user", source: { kind: "tool", callId: "same" }, content: [{ type: "tool-result", toolCallId: "same", isError: true, content: [{ type: "text", text: "😀".repeat(8193) }, { type: "image", id: step }] }] } } });
  }
  let rollback = true; let writes = 0;
  session.bindCheckpoint(async () => {}, async (_events, finish) => {
    writes++;
    const result = rollback ? { status: "rolled-back" as const, error: new Error("rollback") } : { status: "committed" as const };
    finish(result); return result;
  });
  const prepared = new LlmRuntime({ mock: createMockAdapter(() => []) }).prepare({ provider: "mock", model: "m" });
  const context = { session, storageOpen: () => true, blockStorage: () => assert.fail() };
  const before = session.snapshot();
  const cancelled = AbortSignal.abort(new Error("cancelled"));
  await assert.rejects(commitToolResultPruning(context, prepared, [], undefined, cancelled), /cancelled/);
  assert.equal(writes, 0);
  assert.equal((await commitToolResultPruning(context, prepared, [])).status, "rolled-back");
  assert.deepEqual(session.snapshot(), before); assert.equal(session.replaceGeneration, 0);
  rollback = false;
  assert.equal((await commitToolResultPruning(context, prepared, [])).status, "committed");
  assert.deepEqual(session.snapshot().events.slice(4).map((event) => event.type), ["compaction/prune", "tool/result", "compaction/prune", "tool/result"]);
  const results = session.deriveSurfaceNodes().filter((node) => node.type === "tool/result");
  assert.equal(results.length, 2); assert.deepEqual(results.map((node) => node.data.meta), [{ step: 1 }, { step: 2 }]);
  assert.deepEqual(results.map((node) => node.data.error), [{ name: "failure", code: "E" }, { name: "failure", code: "E" }]);
  assert.equal(session.replaceGeneration, 2);
});

for (const outcome of ["failed", "cancelled", "rolled-back"] as const) test(`已提交修剪在摘要 ${outcome} 后保留，恢复不重执工具或审批`, async t => {
  const dir = await mkdtemp(join(tmpdir(), "prune-reopen-"));
  const path = join(dir, "db.sqlite");
  let store = new SqliteSessionPersistence(path);
  let executions = 0; let renders = 0; let approvals = 0; let modelCalls = 0;
  const registry = new ToolRegistry();
  registry.register(defineLocalTool({ name: "read", version: "1", description: "read", input: z.strictObject({}), approvalPolicy: "ask", timeoutMs: 1000,
    handler: () => { executions++; return "value"; },
    output: defineLocalToolOutput({ schema: z.string(), render: () => { renders++; return [{ type: "text", text: "a".repeat(4000) }, { type: "image" }, { type: "text", text: "😀".repeat(4193) }]; }, presentationMeta: () => ({ display: "original" }) }),
  }));
  const approval = new ApprovalService(async () => { approvals++; return "allowed-once" as const; });
  const runtime = new LlmRuntime({ mock: createMockAdapter(() => { modelCalls++; throw new Error("修剪不能调用模型"); }) });
  const prepared = runtime.prepare({ provider: "mock", model: "m" });
  const session = new Session({ sessionId: "persisted", createdAt: 1 });
  try {
    const handle = await store.create(session.header); await handle.flush(); store.bindWriter(handle, session);
    session.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "a", role: "assistant", source: { provider: "mock", model: "m" }, content: [{ type: "tool-call", id: "c", name: "read", arguments: "{}" }] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true } });
    const calls = [{ id: "c", name: "read", arguments: "{}" }];
    assert.equal((await runToolBatch(session, registry, approval, { turn: 1, step: 1 }, calls, new AbortController().signal, () => session.flush())).kind, "completed");
    assert.deepEqual([executions, renders, approvals, modelCalls], [1, 1, 1, 0]);
    const before = session.snapshot();
    const original = before.events.find((event) => event.type === "tool/result"); assert.ok(original);
    assert.ok(before.events.some((event) => event.type === "approval/asked"));
    assert.ok(before.events.some((event) => event.type === "approval/decided"));
    const result = await commitToolResultPruning({ session, storageOpen: () => true, blockStorage: () => assert.fail() }, prepared, registry.definitions());
    assert.equal(result.status, "committed");
    assert.deepEqual([executions, renders, approvals, modelCalls], [1, 1, 1, 0]);
    const after = session.snapshot();
    assert.deepEqual(after.events.slice(0, before.events.length), before.events);
    const marker = after.events[before.events.length];
    assert.equal(marker?.type, "compaction/prune");
    if (marker?.type === "compaction/prune") assert.deepEqual(marker.data, { shadowedSeq: original.seq, beforeTokens: 3121 });
    const visible = session.deriveSurfaceNodes().find((node) => node.type === "tool/result"); assert.ok(visible);
    assert.deepEqual({ ...visible.data, message: { ...visible.data.message, content: [{ ...visible.data.message.content[0], content: [] }] } },
      { ...original.data, message: { ...original.data.message, content: [{ ...original.data.message.content[0], content: [] }] } });
    assert.equal(session.replaceGeneration, 1);
    session.append({ type: "user/message", surfaceOp: "append", data: {
      id: "tail", role: "user", source: { kind: "user" }, turn: 1, requestId: "tail",
      content: [{ type: "text", text: "保留尾部" }],
    } });
    session.append({ type: "command/run", data: { commandId: "summary-command", name: "compact", source: { kind: "user" } } });
    await session.flush();
    const pruned = session.snapshot().events;
    const prunedMessages = session.deriveMessages();
    const agent = new ReActAgent(session, async () => assert.fail("恢复不执行 Turn"), handle);
    const summary = new LlmRuntime({ mock: { async *generate() {
      modelCalls++;
      if (outcome === "failed") {
        yield { type: "finish", reason: { kind: "error", failure: { code: "UNKNOWN", message: "模拟摘要失败" } } };
        return;
      }
      if (outcome === "cancelled") {
        agent.cancel();
        yield { type: "finish", reason: { kind: "aborted" } };
        return;
      }
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "工具查询已完成" } };
      yield { type: "finish", reason: { kind: "stop" } };
    } } });
    const fault = outcome === "rolled-back" ? injectCompactionSqliteFault(t, {
      path, sessionId: session.header.sessionId, firstSeq: pruned.length + 1, compactionId: "summary", kind: "success", mode: "rolled-back",
    }) : undefined;
    try {
      const result = await agent.runMaintenance(signal => agent.settleCompaction({
        session, signal, turn: null, identity: { compactionId: "summary", sourceCommandId: "summary-command" },
        storageOpen: () => agent.storageOpen, blockStorage: error => agent.blockStorage(error),
      }, { runtime: summary, businessModel: summary.prepare({ provider: "mock", model: "m" }), businessTools: registry.definitions(), retainTokens: 0 }));
      const observer = new SqliteSessionPersistence(path, { readOnly: true });
      try {
        const reader = await observer.open(session.header.sessionId, "read"); assert.ok(reader);
        const persisted = await reader.read();
        assert.deepEqual(persisted.slice(0, pruned.length), pruned);
        const disk = new Session(session.header, { seed: { kind: "restore", events: persisted, inheritedEventCount: 0 } });
        assert.deepEqual(disk.deriveMessages(), prunedMessages);
        assert.equal(disk.replaceGeneration, 1);
        if (outcome === "rolled-back") {
          assert.equal(result.status, "unsettled");
          assert.equal(result.source.status, "commit-checkpoint-failed");
          assert.equal(agent.storageOpen, false);
          assert.deepEqual(persisted.slice(pruned.length).map(event => event.type), ["compaction/start"]);
          fault?.release();
        } else {
          assert.equal(result.status, "settled");
          assert.equal(result.outcome, outcome);
          assert.deepEqual(persisted.slice(pruned.length).map(event => event.type), ["compaction/start", "compaction/end"]);
        }
        await agent.recoverStorage();
        const recovered = await reader.read();
        assert.deepEqual(recovered.slice(0, pruned.length), pruned);
        await agent.recoverStorage();
        assert.deepEqual(await reader.read(), recovered);
        if (fault) assert.equal(fault.targetCommits, 2);
        await reader.close();
      } finally { await observer.close(); }
    } finally {
      fault?.restore();
      await agent.stop();
    }
    const settled = session.snapshot();
    const messages = session.deriveMessages();
    await handle.close(); await store.close();
    store = new SqliteSessionPersistence(path);
    const reopened = await store.open("persisted", "read"); assert.ok(reopened);
    const records = await reopened.read();
    const restored = new Session(reopened.header, { seed: { kind: "restore", events: records, inheritedEventCount: 0 } });
    assert.deepEqual(records, settled.events);
    assert.deepEqual(restored.deriveMessages(), messages);
    assert.equal(restored.replaceGeneration, outcome === "rolled-back" ? 2 : 1);
    assert.deepEqual(records[original.seq], original);
    assert.deepEqual([executions, renders, approvals, modelCalls], [1, 1, 1, 1]);
    await reopened.close();
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});
