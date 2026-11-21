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

test("命令结果空白时显示默认终态，非空结果保留原文", async () => {
  const { commandCards } = await import("./view.ts");
  const records = ["success", "error", "success"].flatMap((kind, index) => [
    { type: "event", event: { seq: index * 2, type: "command/run", data: { commandId: String(index), name: "compact", source: { kind: "user" } } } },
    { type: "event", event: { seq: index * 2 + 1, type: "command/done", data: { commandId: String(index), kind, text: index === 2 ? " 原文 " : " \t " } } },
  ]);
  assert.deepEqual(commandCards({ records, inheritedEventCount: 0, status: "ready" }).map(card => card.result), ["已完成", "执行失败", " 原文 "]);
});

test("共享命令卡保留交错结果与继承缺失终态", async () => {
  const { commandCards } = await import("./view.ts");
  const event = (seq, type, data) => ({ type: "event", event: { seq, time: seq, type, data } });
  const records = [
    event(0, "command/run", { commandId: "a", name: "compact", source: { kind: "user" } }),
    event(1, "command/run", { commandId: "b", name: "compact", source: { kind: "user" } }),
    event(2, "compaction/summary", { sourceCommandId: "a", summary: "摘要" }),
    event(3, "compaction/end", { sourceCommandId: "a", status: "succeeded" }),
    event(4, "command/done", { commandId: "b", kind: "error", text: "忙碌" }),
    event(5, "command/run", { commandId: "c", name: "compact", source: { kind: "user" } }),
  ];
  const cards = commandCards({ records, inheritedEventCount: 6, status: "ready" });
  assert.deepEqual(cards.map(({ id, order, result, summary }) => ({ id, order, result, summary })), [
    { id: "a", order: 0, result: "已压缩", summary: "摘要" },
    { id: "b", order: 1, result: "忙碌", summary: undefined },
    { id: "c", order: 5, result: "结果未记录", summary: undefined },
  ]);
  records.push(event(6, "compaction/end", { sourceCommandId: "b", status: "failed" }));
  assert.equal(commandCards({ records, inheritedEventCount: 6, status: "ready" })[1].result, "忙碌");
});
