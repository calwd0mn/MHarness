import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "../../../../packages/session/src/session.ts";
import { SessionWriter } from "../../../../packages/session/src/writer.ts";
import type { SessionAppendInput, SessionEvent } from "../../../../packages/session/src/events.ts";

const user = (id: string) => ({ type: "user/message", surfaceOp: "append", data: { id, role: "user", source: { kind: "user" }, turn: 1, requestId: id, content: [{ type: "text", text: id }] } } as const);
const replace = (sources: number[]) => ({ type: "user/message", surfaceOp: { op: "replace", start: 0, end: 1 }, sourceEventSeqs: sources, data: { id: "summary", role: "user", source: { kind: "compact", compactionId: "c" }, content: [{ type: "text", text: "summary" }] } } as const);

test("暂存批次完整校验并在确认后一次安装", async () => {
  const session = new Session({ sessionId: "staged", createdAt: 1 });
  session.append(user("a")); session.append(user("b")); session.append(user("tail"));
  session.append({ type: "compaction/start", data: { compactionId: "c", turn: null } });
  const originalMessages = session.deriveMessages();
  const originalEvents = session.snapshot().events;
  const persisted: SessionEvent[] = [...originalEvents];
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0;
  const writer = new SessionWriter(session, {
    async append(events) { persisted.push(...events); },
    async flush() {},
    async read(offset = 0, length = persisted.length - offset) { if (offset + length > persisted.length) throw new Error("范围不足"); return persisted.slice(offset, offset + length); },
    async commitStaged(events) { attempts++; await gate; persisted.push(...events); return { status: "committed" as const }; },
    async reconcileStaged() { throw new Error("不应核对"); },
  });
  const observed: { seq: number; cursor: number; messages: string[] }[] = [];
  session.on("session/event", (event) => { observed.push({ seq: event.seq, cursor: session.snapshot().cursor, messages: session.deriveMessages().map(({ id }) => id) }); });
  const summary = { type: "compaction/summary", data: { compactionId: "c", summary: "summary", shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1], route: { provider: "mock", model: "m" } } } as const;
  const end = { type: "compaction/end", data: { compactionId: "c", turn: null, status: "succeeded" } } as const;
  await assert.rejects(session.commitStaged((firstSeq) => [summary, replace([0, 1, firstSeq]), { type: "compaction/end", data: { status: "succeeded" } } as unknown as SessionAppendInput]));
  assert.equal(attempts, 0); assert.equal(session.seq, 4); assert.equal(session.replaceGeneration, 0);
  assert.equal(session.deriveMessages()[0], originalMessages[0]);
  assert.equal(session.deriveMessages()[2], originalMessages[2]);
  assert.equal(session.snapshot().events[2], originalEvents[2]);
  const committing = session.commitStaged((firstSeq) => [summary, replace([0, 1, firstSeq]), end]);
  assert.equal(session.seq, 4);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1); assert.deepEqual(observed, []);
  release();
  const result = await committing;
  assert.equal(result.status, "committed"); assert.equal(session.seq, 7); assert.equal(session.replaceGeneration, 1);
  assert.deepEqual(observed, [4, 5, 6].map((seq) => ({ seq, cursor: 6, messages: ["summary", "tail"] })));
  assert.equal(session.deriveMessages()[1], originalMessages[2]);
  assert.equal(session.snapshot().events[2], originalEvents[2]);
  assert.deepEqual(persisted, session.snapshot().events);
  const replay = new Session(session.header, { seed: { kind: "restore", events: persisted, inheritedEventCount: 0 } });
  assert.deepEqual(replay.deriveMessages(), session.deriveMessages());
  await writer.close();
});

test("暂存等待普通尾批且竞争写入拒绝，检查点和关闭等待发布", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = new Session({ sessionId: "queue", createdAt: 1 });
  const persisted: SessionEvent[] = []; const batches: number[][] = [];
  let release = () => {}; const gate = new Promise<void>((resolve) => { release = resolve; });
  let releaseStage = () => {}; const stageGate = new Promise<void>((resolve) => { releaseStage = resolve; });
  const writer = new SessionWriter(session, {
    async append(events) { if (events[0]?.seq === 0) await gate; batches.push(events.map(({ seq }) => seq)); persisted.push(...events); },
    async flush() {},
    async read(offset = 0, length = persisted.length - offset) { if (offset + length > persisted.length) throw new Error("范围不足"); return persisted.slice(offset, offset + length); },
    async commitStaged(events) { await stageGate; batches.push(events.map(({ seq }) => seq)); persisted.push(...events); return { status: "committed" as const }; },
    async reconcileStaged() { throw new Error("不应核对"); },
  });
  session.append({ type: "turn/start", data: { turn: 1 } });
  const first = session.flush(); await new Promise((resolve) => setImmediate(resolve));
  session.append({ type: "step/start", data: { turn: 1, step: 1 } });
  const staged = session.commitStaged(() => [{ type: "step/end", data: { turn: 1, step: 1 } }]);
  assert.throws(() => session.append({ type: "turn/start", data: { turn: 2 } }), /暂存/);
  await assert.rejects(session.commitStaged(() => [{ type: "turn/start", data: { turn: 2 } }]), /占用/);
  const flushing = session.flush(); const closing = writer.close(); assert.equal(writer.close(), closing);
  release(); await first; await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(batches, [[0], [1]]); assert.equal(session.seq, 2);
  t.mock.timers.tick(1_000); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(batches, [[0], [1]]);
  releaseStage(); assert.equal((await staged).status, "committed"); await Promise.all([flushing, closing]);
  assert.deepEqual(batches, [[0], [1], [2]]); assert.deepEqual(persisted, session.snapshot().events);
});

test("普通尾批失败时不尝试暂存，显式检查点仍可重试尾批", async () => {
  const session = new Session({ sessionId: "tail-failure", createdAt: 1 });
  const persisted: SessionEvent[] = []; let fail = true; let stagedAttempts = 0;
  const writer = new SessionWriter(session, {
    async append(events) { if (fail) throw new Error("tail failure"); persisted.push(...events); },
    async flush() {},
    async read(offset = 0, length = persisted.length - offset) { if (offset + length > persisted.length) throw new Error("范围不足"); return persisted.slice(offset, offset + length); },
    async commitStaged() { stagedAttempts++; return { status: "committed" as const }; },
    async reconcileStaged() { throw new Error("不应核对"); },
  }, () => {});
  session.append({ type: "turn/start", data: { turn: 1 } });
  await assert.rejects(session.commitStaged(() => [{ type: "step/start", data: { turn: 1, step: 1 } }]), /tail failure/);
  assert.equal(stagedAttempts, 0); assert.equal(session.seq, 1);
  fail = false; await session.flush(); assert.deepEqual(persisted, session.snapshot().events); await writer.close();
});

test("失败草稿不污染工具结果关联，原结果仍可替换", async () => {
  const session = new Session({ sessionId: "tool-draft", createdAt: 1 });
  session.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "a", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "tool-call", id: "call", name: "read", arguments: "{}" }] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true } });
  const call = session.append({ type: "tool/call", data: { turn: 1, step: 1, callId: "call", name: "read", arguments: "{}" } });
  session.append({ type: "tool/operation", data: { turn: 1, step: 1, callId: "call", operationId: "op", toolName: "read", toolVersion: "1", validatedArgs: {} } });
  const result = session.append({ type: "tool/result", surfaceOp: "append", sourceEventSeqs: [call.seq], data: { turn: 1, step: 1, operationId: "op", message: { id: "r", role: "user", source: { kind: "tool", callId: "call" }, content: [{ type: "tool-result", toolCallId: "call", isError: false, content: ["old"] }] } } });
  const replacement = { type: "tool/result", surfaceOp: { op: "replace", start: result.seq, end: result.seq }, sourceEventSeqs: [result.seq], data: { ...result.data, message: { ...result.data.message, content: [{ ...result.data.message.content[0], content: ["new"] }] } } } as const;
  const persisted = [...session.snapshot().events]; let attempts = 0;
  const writer = new SessionWriter(session, {
    async append(events) { persisted.push(...events); }, async flush() {},
    async read(offset = 0, length = persisted.length - offset) { if (offset + length > persisted.length) throw new Error("范围不足"); return persisted.slice(offset, offset + length); },
    async commitStaged(events) { attempts++; persisted.push(...events); return { status: "committed" as const }; },
    async reconcileStaged() { throw new Error("不应核对"); },
  });
  await assert.rejects(session.commitStaged(() => [replacement, { type: "tool/operation", data: { turn: 1, step: 1, callId: "missing", operationId: "x", toolName: "read", toolVersion: "1", validatedArgs: {} } }]));
  assert.equal(attempts, 0); assert.equal(session.seq, 4); assert.equal(session.replaceGeneration, 0);
  const committed = await session.commitStaged(() => [replacement]);
  assert.equal(committed.status, "committed"); assert.equal(attempts, 1); assert.equal(session.replaceGeneration, 1);
  assert.deepEqual(persisted, session.snapshot().events); await writer.close();
});

test("大批暂存完成后先安装全部事件再通知", async () => {
  const session = new Session({ sessionId: "large-staged", createdAt: 1 }); let persisted = 0;
  const writer = new SessionWriter(session, {
    async append(events) { persisted += events.length; }, async flush() {},
    async read(offset = 0, length = persisted - offset) { if (offset + length > persisted) throw new Error("范围不足"); return []; },
    async commitStaged(events) { persisted += events.length; return { status: "committed" as const }; },
    async reconcileStaged() { throw new Error("不应核对"); },
  });
  let firstCursor = -2; let notifications = 0;
  session.on("session/event", () => { if (notifications++ === 0) firstCursor = session.snapshot().cursor; });
  const candidate = { type: "turn/start", time: 1, data: { turn: 1 } } as const;
  const result = await session.commitStaged(() => Array.from({ length: 150_000 }, () => candidate));
  assert.equal(result.status, "committed"); assert.equal(session.seq, 150_000); assert.equal(firstCursor, 149_999); assert.equal(notifications, 150_000);
  await writer.close();
});
