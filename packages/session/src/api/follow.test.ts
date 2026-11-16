import { test } from "node:test";
import assert from "node:assert/strict";
import { followFrameSchema } from "./follow.ts";

test("follow 帧接受空快照、原始事件、实时结算和终止错误", () => {
  const frames = [
    { type: "snapshot", sessionId: "s1", inheritedEventCount: 0, cursor: -1, records: [], assistantStream: { revision: 0 } },
    { type: "event", event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } } },
    { type: "assistant-stream", frame: { type: "end", attemptId: "a", revision: 1, turn: 1, step: 1, index: 0, outcome: { kind: "committed", eventType: "assistant/message", seq: 0 } } },
    { type: "assistant-stream", frame: { type: "end", attemptId: "a", revision: 2, turn: 1, step: 1, index: 0, outcome: { kind: "abandoned" } } },
    { type: "error", error: { code: "follow_sync_failed", message: "失败", details: {} } },
  ];
  for (const frame of frames) assert.equal(followFrameSchema.safeParse(frame).success, true);
  assert.equal(followFrameSchema.safeParse({ type: "assistant-stream", frame: { type: "end", attemptId: "a", revision: 1, turn: 1, step: 1, index: 0, outcome: { kind: "abandoned", seq: 0 } } }).success, false);
});
