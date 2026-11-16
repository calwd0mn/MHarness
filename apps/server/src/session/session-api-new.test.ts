import assert from "node:assert/strict";
import { test } from "node:test";
import { createPersistedSession, readPersistedSessionHistory } from "../../../../packages/session/src/api/use-cases.ts";
import { rawSessionHistorySchema, rawSessionEventFrameSchema, promptRequestSchema, promptResponseSchema } from "../../../../packages/session/src/api/contracts.ts";
import type { SessionHandle, SessionPersistence } from "../../../../packages/session/src/persistence.ts";
import { Session } from "../../../../packages/session/src/session.ts";

test("创建仅提交空头，历史读取已提交前缀且不排空", async () => {
 const session = new Session({ sessionId: "s", createdAt: 1 });
 const first = session.append({ type: "turn/start", time: 123, data: { turn: 1 } });
 session.append({ type: "step/start", time: 124, data: { turn: 1, step: 1 } });
 let flushed = 0; let closed = 0;
 const handle = { id: "s", header: session.header, access: "write", inheritedEventCount: 0,
   read: async () => [first], append: async () => { throw new Error("unexpected append"); },
   flush: async () => { flushed++; }, close: async () => { closed++; } } satisfies SessionHandle;
 const persistence = { create: async () => handle, open: async () => handle } as unknown as SessionPersistence;
 await createPersistedSession(persistence, session.header);
 assert.equal(flushed, 1); assert.equal(closed, 1);
 const history = await readPersistedSessionHistory(persistence, "s");
 assert.deepEqual(history, { sessionId: "s", inheritedEventCount: 0, cursor: 0, records: [{ type: "event", event: first }] });
 assert.equal(flushed, 1); assert.equal(closed, 2);
 assert.deepEqual(rawSessionHistorySchema.parse(history), history);
 assert.deepEqual(rawSessionEventFrameSchema.parse(history?.records[0]), history?.records[0]);
 assert.deepEqual(promptRequestSchema.parse({ requestId: "r", content: [{ type: "text", text: "hello" }] }), { requestId: "r", content: [{ type: "text", text: "hello" }] });
 assert.deepEqual(promptResponseSchema.parse({ accepted: true }), { accepted: true });
});

test("空历史与缺失会话可区分，读取异常仍关闭句柄", async () => {
 let closed = 0;
 const handle = { id: "s", header: { sessionId: "s", createdAt: 1 }, access: "read", inheritedEventCount: 0,
   read: async () => [], append: async () => {}, flush: async () => {}, close: async () => { closed++; } } satisfies SessionHandle;
 const persistence = { open: async (id: string) => id === "s" ? handle : undefined } as unknown as SessionPersistence;
 assert.deepEqual(await readPersistedSessionHistory(persistence, "s"), { sessionId: "s", inheritedEventCount: 0, cursor: -1, records: [] });
 assert.equal(await readPersistedSessionHistory(persistence, "missing"), undefined);
 assert.equal(closed, 1);
 const failed = { ...handle, read: async () => { throw new Error("read failed"); } };
 const failingPersistence = { open: async () => failed } as unknown as SessionPersistence;
 await assert.rejects(readPersistedSessionHistory(failingPersistence, "s"), /read failed/);
 assert.equal(closed, 2);
});

test("原始封装保留请求头、继承标记和替换的引用与时间", () => {
 const parent = new Session({ sessionId: "p", createdAt: 1 });
 parent.append({ type: "request/header", time: 1700000000000, data: { reason: "initial", header: { config: { provider: "p", model: "m" } } } });
 parent.append({ type: "user/message", time: 1700000000001, surfaceOp: "append", data: { id: "u", role: "user", source: { kind: "user" }, turn: 1, requestId: "r", content: [{ type: "text", text: "x" }] } });
 const child = new Session({ sessionId: "c", createdAt: 1700000000002, isSeeded: true, parentSession: "p" }, { seed: { kind: "fork", events: parent.snapshot().events } });
 child.append({ type: "user/message", time: 1700000000003, surfaceOp: { op: "replace", start: 1, end: 1 }, sourceEventSeqs: [1], data: { id: "summary", role: "user", source: { kind: "compact", compactionId: "c" }, content: [{ type: "text", text: "summary" }] } });
 const records = child.snapshot().events.map((event) => ({ type: "event" as const, event }));
 const history = { sessionId: "c", inheritedEventCount: child.inheritedEventCount, cursor: 3, records };
 assert.deepEqual(rawSessionHistorySchema.parse(history), history);
 assert.equal(records[0]?.event.time, 1700000000000);
 assert.equal(records[2]?.event.type, "session/end-seed");
 assert.deepEqual(rawSessionEventFrameSchema.parse(records[3]), records[3]);
 assert.equal(rawSessionHistorySchema.safeParse({ ...history, cursor: 2 }).success, false);
});
