import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSubmission, confirmFromRecords } from "./submission.ts";

test("重发未确认内容沿用编号，修改内容生成新编号", () => {
  const first = makeSubmission(undefined, "hello", () => "one");
  assert.equal(makeSubmission({ ...first, status: "uncertain" }, "hello", () => "two").requestId, "one");
  assert.equal(makeSubmission({ ...first, status: "uncertain" }, "changed", () => "two").requestId, "two");
  assert.equal(makeSubmission({ ...first, status: "accepted" }, "hello", () => "two").requestId, "two");
});

test("只有本会话真实用户追加事件确认发送", () => {
  const pending = makeSubmission(undefined, "hello", () => "id");
  const event = { type: "event", event: { type: "user/message", seq: 0, surfaceOp: "append", data: { source: { kind: "user" }, requestId: "id" } } };
  assert.equal(confirmFromRecords(pending, [event], 1).status, "sending");
  assert.equal(confirmFromRecords(pending, [event], 0).status, "accepted");
});

test("忙碌拒绝后再次提交使用新编号", () => {
  const rejected = { ...makeSubmission(undefined, "hello", () => "one"), status: "busy" };
  assert.equal(makeSubmission(rejected, "hello", () => "two").requestId, "two");
});
