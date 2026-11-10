import {
  createSessionResponseSchema,
  sessionHistoryResponseSchema,
  submitMessageResponseSchema,
} from "@mharness/protocol";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "./app.ts";
import { SessionStore } from "./storage/session-store.ts";

test("创建会话仅持久化空会话，历史游标为零", async (t) => {
  const store = new SessionStore(":memory:");
  const app = createApp(store);
  t.after(() => app.close());

  const created = await app.inject({ method: "POST", url: "/api/sessions" });
  assert.equal(created.statusCode, 201);
  const { sessionId } = createSessionResponseSchema.parse(created.json<unknown>());
  assert.deepEqual(store.readSession(sessionId), { records: [], cursor: 0 });

  const response = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(sessionHistoryResponseSchema.parse(response.json<unknown>()), {
    sessionId,
    records: [],
    cursor: 0,
    latestTurn: null,
  });
});

test("提交返回唯一 Turn 标识，并发冲突不留下额外消息", async (t) => {
  const store = new SessionStore(":memory:");
  const app = createApp(store);
  t.after(() => app.close());

  const [first, second] = await Promise.all(
    [1, 2].map(() => app.inject({ method: "POST", url: "/api/sessions", payload: {} })),
  );
  const { sessionId } = createSessionResponseSchema.parse(first.json<unknown>());
  const { sessionId: otherSessionId } = createSessionResponseSchema.parse(second.json<unknown>());
  const submit = (target: string, text: string) => app.inject({
    method: "POST",
    url: `/api/sessions/${target}/messages`,
    payload: { text },
  });

  const responses = await Promise.all([submit(sessionId, "第一条"), submit(sessionId, "第二条")]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [202, 409]);
  const accepted = responses.find((response) => response.statusCode === 202);
  const rejected = responses.find((response) => response.statusCode === 409);
  assert.ok(accepted);
  assert.deepEqual(rejected?.json<unknown>(), { code: "turn_active" });
  const { turnId } = submitMessageResponseSchema.parse(accepted.json<unknown>());

  const other = await submit(otherSessionId, "另一个会话");
  assert.equal(other.statusCode, 202);
  assert.notEqual(submitMessageResponseSchema.parse(other.json<unknown>()).turnId, turnId);

  store.appendRecords(sessionId, [
    { type: "turn/status", data: { turnId, status: "awaiting_approval" } },
  ]);
  const response = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
  assert.equal(response.statusCode, 200);
  const history = sessionHistoryResponseSchema.parse(response.json<unknown>());
  assert.equal(history.cursor, 3);
  assert.deepEqual(history.records.map(({ type }) => type), [
    "user/message", "turn/status", "turn/status",
  ]);
  assert.deepEqual(history.latestTurn, { turnId, status: "awaiting_approval" });
});

test("校验失败不会写入消息，未知会话返回 404", async (t) => {
  const store = new SessionStore(":memory:");
  const app = createApp(store);
  t.after(() => app.close());

  const invalidCreate = await app.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { unexpected: true },
  });
  assert.equal(invalidCreate.statusCode, 400);

  store.createSession("s1");
  const invalidMessage = await app.inject({
    method: "POST",
    url: "/api/sessions/s1/messages",
    payload: { text: " " },
  });
  assert.equal(invalidMessage.statusCode, 400);
  assert.deepEqual(invalidMessage.json<unknown>(), { code: "invalid_request" });
  assert.deepEqual(store.readSession("s1"), { records: [], cursor: 0 });

  const missing = await app.inject({
    method: "POST",
    url: "/api/sessions/missing/messages",
    payload: { text: "消息" },
  });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json<unknown>(), { code: "session_not_found" });
  const missingHistory = await app.inject({ method: "GET", url: "/api/sessions/missing" });
  assert.equal(missingHistory.statusCode, 404);
});
