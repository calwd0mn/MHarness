import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../session.ts";
import { compactRequestSchema, compactResponseSchema, compactErrorSchema, rawSessionEventFrameSchema, followFrameSchema } from "./contracts.ts";

const compactionId = "2dfe7336-a43e-4fcb-9530-1880d94588ce";

test("压缩契约严格区分请求、终态与错误", () => {
  assert.deepEqual(compactRequestSchema.parse({ compactionId }), { compactionId });
  assert.deepEqual(compactRequestSchema.parse({ compactionId, args: "  参数  " }), { compactionId, args: "  参数  " });
  for (const status of ["succeeded", "no_safe_range", "cancelled", "failed"]) {
    assert.deepEqual(compactResponseSchema.parse({ compactionId, commandId: "cmd", status }), { compactionId, commandId: "cmd", status });
  }
  for (const value of [{}, { compactionId: "bad" }, { compactionId, requestId: "x" }, { compactionId, content: [] }, { compactionId, args: null }]) {
    assert.equal(compactRequestSchema.safeParse(value).success, false);
  }
  for (const value of [{ accepted: true }, { accept: true }, { compactionId, status: "unknown" }, { compactionId, status: "failed", extra: true }]) {
    assert.equal(compactResponseSchema.safeParse(value).success, false);
  }
  for (const code of ["invalid_request", "session/not-found", "agent_busy", "compaction_id_conflict", "compaction_unavailable", "storage_blocked", "agent_closed", "compaction_internal_error"]) {
    assert.equal(compactErrorSchema.safeParse({ code }).success, true);
  }
  assert.equal(compactErrorSchema.safeParse({ code: "private error" }).success, false);
});

test("独立维护事件的原始帧和快照保留关联标识", () => {
  for (const status of ["succeeded", "cancelled", "failed", "interrupted"] as const) {
    const events = [
      { type: "user/message", data: { id: "original", role: "user", source: { kind: "user" }, turn: 1, requestId: "original", content: [{ type: "text", text: "原始内容" }] }, surfaceOp: "append" },
      { type: "compaction/start", data: { compactionId, turn: null } },
      ...(status === "succeeded" ? [
        { type: "compaction/summary", data: { compactionId, summary: "摘要", shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], route: { provider: "mock", model: "test" } } },
        { type: "user/message", data: { id: "summary", role: "user", source: { kind: "compact", compactionId }, content: [{ type: "text", text: "摘要" }] }, surfaceOp: { op: "replace", start: 0, end: 0 }, sourceEventSeqs: [0, 2] },
      ] : []),
      { type: "compaction/end", data: { compactionId, turn: null, status, ...(status === "succeeded" ? {} : { reason: "test" }) } },
    ];
    const records = events.map((event, seq) => rawSessionEventFrameSchema.parse({ type: "event", event: { ...event, seq, time: seq + 1 } }));
    assert.equal(followFrameSchema.safeParse({ type: "snapshot", sessionId: "s", inheritedEventCount: 0, cursor: records.length - 1, records, assistantStream: { revision: 0 } }).success, true);
    const session = new Session({ sessionId: "s", createdAt: 0 }, {
      seed: { kind: "restore", inheritedEventCount: 0, events: records.map(({ event }) => event) },
    });
    assert.equal(session.snapshot().cursor, records.length - 1);
    assert.deepEqual(session.deriveMessages().map(({ id }) => id), [status === "succeeded" ? "summary" : "original"]);
  }
});

test("真实 Session 重放交错命令并保持摘要来源与 surface", () => {
  const session = new Session({ sessionId: "fixture", createdAt: 0 });
  session.append({ type: "user/message", data: { id: "original", role: "user", source: { kind: "user" }, turn: 1, requestId: "r", content: [{ type: "text", text: "原文" }] }, surfaceOp: "append" });
  session.append({ type: "command/run", data: { commandId: "c1", name: "compact", args: "  ", source: { kind: "user" } } });
  session.append({ type: "compaction/start", data: { compactionId, sourceCommandId: "c1", turn: null } });
  session.append({ type: "command/run", data: { commandId: "c2", name: "compact", source: { kind: "user" } } });
  const summary = session.append({ type: "compaction/summary", data: { compactionId, sourceCommandId: "c1", summary: "摘要", shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], route: { provider: "p", model: "m" } } });
  session.append({ type: "user/message", data: { id: "summary", role: "user", source: { kind: "compact", compactionId }, sourceCommandId: "c1", content: [{ type: "text", text: "摘要" }] }, surfaceOp: { op: "replace", start: 0, end: 0 }, sourceEventSeqs: [0, summary.seq] });
  session.append({ type: "compaction/end", data: { compactionId, sourceCommandId: "c1", turn: null, status: "succeeded" } });
  session.append({ type: "command/done", data: { commandId: "c2", kind: "error", text: "忙碌" } });
  session.append({ type: "command/done", data: { commandId: "c1", kind: "success", sourceEventSeq: summary.seq } });
  const events = session.snapshot().events;
  const replay = new Session({ sessionId: "fixture", createdAt: 0 }, { seed: { kind: "restore", inheritedEventCount: 0, events } });
  assert.deepEqual(replay.snapshot().events, events);
  assert.deepEqual(replay.deriveMessages().map(({ id }) => id), ["summary"]);
  assert.equal(replay.snapshot().cursor, 8);
});
