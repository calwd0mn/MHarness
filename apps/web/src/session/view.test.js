import { test } from "node:test";
import assert from "node:assert/strict";
import { messages, lastTurn } from "./view.ts";

test("新轮次开始后仍展示此前轮次失败", () => {
  const records = [
    { type: "event", event: { type: "turn/end", seq: 0, data: { turn: 1, reason: { kind: "error", error: { code: "UNKNOWN", message: "失败" } } } } },
    { type: "event", event: { type: "turn/start", seq: 1, data: { turn: 2 } } },
  ];
  assert.equal(messages({ records, settledNodeIds: {} })[0].text, "本轮失败：失败");
  assert.equal(lastTurn(records), "正在处理");
});
