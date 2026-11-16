import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interruptedTurnClosers } from "./recovery.ts";
import type { SessionEvent } from "./events.ts";

const start: SessionEvent[] = [
  { seq: 0, time: 1, type: "turn/start", data: { turn: 1 } },
  { seq: 1, time: 2, type: "step/start", data: { turn: 1, step: 1 } },
];

test("只关闭前缀中实际打开的范围", () => {
  assert.deepEqual(interruptedTurnClosers(start, 3).map(e => e.type), ["step/end", "turn/end"]);
  assert.deepEqual(interruptedTurnClosers(start.slice(0, 1), 3).map(e => e.type), ["turn/end"]);
});

test("实库按声明顺序修复已批准和未调度调用，只读推导保留真实前缀", async (t) => {
  const { Session } = await import("./session.ts");
  const { projectInterruptedSession, recoverInterruptedSession } = await import("./recovery.ts");
  const { SqliteSessionPersistence } = await import("./storage/sqlite-persistence.ts");
  const s = new Session({ sessionId: "s", createdAt: 1 });
  s.append({ type: "turn/start", data: { turn: 1 } });
  s.append({ type: "step/start", data: { turn: 1, step: 1 } });
  s.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1,
    message: { id: "m", role: "assistant", source: { provider: "p", model: "m" }, content: [
      { type: "tool-call", id: "a", name: "one", arguments: "{}" },
      { type: "tool-call", id: "b", name: "two", arguments: "{}" },
    ] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true } });
  s.append({ type: "tool/call", data: { turn: 1, step: 1, callId: "a", name: "one", arguments: "{}" } });
  s.append({ type: "tool/operation", data: { turn: 1, step: 1, callId: "a", operationId: "op", toolName: "one", toolVersion: "1", validatedArgs: {} } });
  s.append({ type: "approval/asked", data: { id: "approval", operationId: "op", toolName: "one", reason: "policy" } });
  const dir = await mkdtemp(join(tmpdir(), "mharness-recovery-"));
  const path = join(dir, "events.sqlite");
  const storage = new SqliteSessionPersistence(path);
  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  t.after(async () => {
    await observer.close();
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  });
  const handle = await storage.create(s.header);
  await handle.append(s.snapshot().events);
  const reader = await observer.open("s", "read");
  assert.ok(reader);
  const view = await projectInterruptedSession(reader);
  assert.equal(view.cursor, 5);
  assert.equal(view.session.seq, 10);
  assert.deepEqual(await reader.read(), s.snapshot().events);
  await handle.append([s.append({ type: "approval/decided", data: { id: "approval", outcome: "allowed-once" } })]);
  const closers = await recoverInterruptedSession(handle);
  assert.deepEqual(closers.map(e => e.type), ["tool/result", "tool/result", "step/end", "turn/end"]);
  const [a, b] = closers;
  assert.equal(a?.type, "tool/result"); assert.equal(b?.type, "tool/result");
  if (a?.type !== "tool/result" || b?.type !== "tool/result") throw new Error("missing results");
  assert.deepEqual(a.sourceEventSeqs, [3]); assert.equal(a.data.error?.code, "TOOL_OUTCOME_UNKNOWN");
  assert.equal(a.data.operationId, "op"); assert.deepEqual(b.sourceEventSeqs, [2]);
  assert.equal(b.data.error?.code, "TOOL_NOT_STARTED");
  assert.deepEqual(await reader.read(), [...s.snapshot().events, ...closers]);
  assert.equal((await recoverInterruptedSession(handle)).length, 0);
  assert.equal((await observer.stat("s"))?.eventCount, 11);
});

test("孤立工具结果不能触发任何修复写入", async () => {
  const { recoverInterruptedSession } = await import("./recovery.ts");
  const events: SessionEvent[] = [...start, { seq: 2, time: 3, type: "tool/result", surfaceOp: "append", sourceEventSeqs: [1], data: {
    turn: 1, step: 1, message: { id: "x", role: "user", source: { kind: "tool", callId: "missing" }, content: [{ type: "tool-result", toolCallId: "missing", isError: true, content: [] }] },
  } }];
  let writes = 0;
  const handle: import("./persistence.ts").SessionHandle = {
    id: "s", header: { sessionId: "s", createdAt: 1 }, access: "write", inheritedEventCount: 0,
    async read() { return events; }, async append() { writes++; }, async flush() {}, async close() {},
  };
  await assert.rejects(recoverInterruptedSession(handle)); assert.equal(writes, 0);
});

test("已有操作的持久结果缺少 operationId 时拒绝恢复且保留原前缀", async (t) => {
  const { recoverInterruptedSession } = await import("./recovery.ts");
  const { SqliteSessionPersistence } = await import("./storage/sqlite-persistence.ts");
  const dir = await mkdtemp(join(tmpdir(), "mharness-invalid-operation-"));
  const storage = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  t.after(async () => {
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  });
  const events: SessionEvent[] = [
    ...start,
    { seq: 2, time: 3, type: "assistant/message", surfaceOp: "append", data: {
      turn: 1, step: 1, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true,
      message: { id: "assistant", role: "assistant", source: { provider: "p", model: "m" }, content: [
        { type: "tool-call", id: "a", name: "one", arguments: "{}" },
      ] },
    } },
    { seq: 3, time: 4, type: "tool/call", data: { turn: 1, step: 1, callId: "a", name: "one", arguments: "{}" } },
    { seq: 4, time: 5, type: "tool/operation", data: {
      turn: 1, step: 1, callId: "a", operationId: "op", toolName: "one", toolVersion: "1", validatedArgs: {},
    } },
    { seq: 5, time: 6, type: "tool/result", surfaceOp: "append", sourceEventSeqs: [3], data: {
      turn: 1, step: 1, message: {
        id: "result", role: "user", source: { kind: "tool", callId: "a" }, content: [
          { type: "tool-result", toolCallId: "a", isError: false, content: [] },
        ],
      },
    } },
  ];
  const handle = await storage.create({ sessionId: "s", createdAt: 0 });
  await handle.append(events);
  await assert.rejects(recoverInterruptedSession(handle));
  assert.deepEqual(await handle.read(), events);
});

test("工具结果替换按被替换记录关联，恢复不会重复补结果", () => {
  const result = {
    turn: 1, step: 1,
    message: { id: "result", role: "user", source: { kind: "tool", callId: "a" }, content: [
      { type: "tool-result", toolCallId: "a", isError: false, content: [{ type: "text", text: "内容" }] },
    ] },
  } as const;
  const events: SessionEvent[] = [
    ...start,
    { seq: 2, time: 3, type: "assistant/message", surfaceOp: "append", data: {
      turn: 1, step: 1,
      message: { id: "assistant", role: "assistant", source: { provider: "p", model: "m" }, content: [
        { type: "tool-call", id: "a", name: "one", arguments: "{}" },
      ] },
      finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true,
    } },
    { seq: 3, time: 4, type: "tool/call", data: { turn: 1, step: 1, callId: "a", name: "one", arguments: "{}" } },
    { seq: 4, time: 5, type: "tool/result", surfaceOp: "append", sourceEventSeqs: [3], data: result },
    { seq: 5, time: 6, type: "tool/result", surfaceOp: { op: "replace", start: 4, end: 4 }, sourceEventSeqs: [4], data: result },
  ];
  assert.deepEqual(interruptedTurnClosers(events, 7).map((event) => event.type), ["step/end", "turn/end"]);
});

test("追加失败向调用方传播且不发布修复", async () => {
  const { recoverInterruptedSession } = await import("./recovery.ts");
  const failure = new Error("disk failure");
  let attempts = 0;
  const handle: import("./persistence.ts").SessionHandle = {
    id: "s", header: { sessionId: "s", createdAt: 1 }, access: "write", inheritedEventCount: 0,
    async read() { return start; }, async append() { attempts++; throw failure; }, async flush() {}, async close() {},
  };
  await assert.rejects(recoverInterruptedSession(handle), error => error === failure);
  assert.equal(attempts, 1); assert.equal((await handle.read()).length, 2);
});
