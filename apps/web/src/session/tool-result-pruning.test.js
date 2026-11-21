import assert from "node:assert/strict";
import { test } from "node:test";
import { followFrameSchema } from "@mharness/session/contracts";
import { projectTools } from "./tools.ts";

test("修剪记录透传且工具卡片保留原结果和审批", () => {
  const original = { turn: 1, step: 1, operationId: "op", message: { id: "r", role: "user", source: { kind: "tool", callId: "c" }, content: [{ type: "tool-result", toolCallId: "c", isError: false, content: [{ type: "text", text: "原始内容" }] }] } };
  const events = [
    { type: "tool/call", data: { turn: 1, step: 1, callId: "c", name: "read", arguments: "{}" } },
    { type: "tool/operation", data: { turn: 1, step: 1, callId: "c", operationId: "op", toolName: "read", toolVersion: "1", validatedArgs: {} } },
    { type: "approval/asked", data: { id: "approval", operationId: "op", toolName: "read", reason: "check" } },
    { type: "approval/decided", data: { id: "approval", outcome: "allowed-once" } },
    { type: "tool/result", surfaceOp: "append", sourceEventSeqs: [0], data: original },
    { type: "compaction/prune", data: { shadowedSeq: 4, beforeTokens: 100 } },
    { type: "tool/result", surfaceOp: { op: "replace", start: 4, end: 4 }, sourceEventSeqs: [4], data: { ...original, message: { ...original.message, content: [{ ...original.message.content[0], content: [{ type: "text", text: "修剪内容" }] }] } } },
  ];
  const frames = events.map((event, seq) => followFrameSchema.parse({ type: "event", event: { ...event, seq, time: 1 } }));
  const tools = projectTools(frames);
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0].result, original);
  assert.equal(tools[0].decision, "allowed-once");
});
