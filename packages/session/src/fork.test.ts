import assert from "node:assert/strict";
import { test } from "node:test";
import { selectForkCut } from "./fork.ts";
import { Session } from "./session.ts";

test("只在已观察前缀内按锚点选择稳定尾部", () => {
  const source = new Session({ sessionId: "parent", createdAt: 0 });
  const events = () => source.snapshot().events;
  source.append({ type: "request/header", data: { reason: "initial", header: { config: { provider: "mock", model: "m" } } } });
  source.append({ type: "turn/start", data: { turn: 1 } });
  assert.equal(selectForkCut(events()), undefined);
  source.append({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  source.append({ type: "request/header", data: { reason: "series", header: { config: { provider: "mock", model: "m" } } } });
  source.append({ type: "turn/start", data: { turn: 2 } });
  source.append({ type: "step/start", data: { turn: 2, step: 1 } });
  assert.equal(selectForkCut(events(), 0), undefined);
  assert.equal(selectForkCut(events(), 1), 4);
  assert.equal(selectForkCut(events(), 2), 4);
  assert.equal(selectForkCut(events(), 3), 4);
  assert.equal(selectForkCut(events(), 4), undefined);
  assert.equal(selectForkCut(events(), 5), undefined);
  assert.equal(selectForkCut(events(), 6), 4);
  assert.equal(selectForkCut(events()), 4);
  source.append({ type: "step/end", data: { turn: 2, step: 1 } });
  source.append({ type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } });
  assert.equal(selectForkCut(events(), 3), 4);
  assert.equal(selectForkCut(events(), 5), 8);
  assert.equal(selectForkCut(events(), 7), 8);
  assert.equal(selectForkCut(events()), 8);
  for (const value of [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => selectForkCut(events(), value), RangeError);
  }
});

test("轮间锚点按同一快照中匹配的独立压缩终态确定截止位置", () => {
  const source = new Session({ sessionId: "parent", createdAt: 0 });
  source.append({ type: "turn/start", data: { turn: 1 } });
  source.append({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  source.append({ type: "compaction/start", data: { turn: null, compactionId: "first" } });
  source.append({ type: "compaction/end", data: { turn: null, compactionId: "other", status: "succeeded" } });
  assert.equal(selectForkCut(source.snapshot().events, 3), 2);
  source.append({ type: "compaction/end", data: { turn: null, compactionId: "first", status: "succeeded" } });
  assert.equal(selectForkCut(source.snapshot().events, 3), 5);
  source.append({ type: "turn/start", data: { turn: 2 } });
  assert.equal(selectForkCut(source.snapshot().events, 3), 5);
});
