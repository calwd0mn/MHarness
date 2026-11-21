import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "@mharness/session/server";
import type { PreparedModel } from "../model/runtime.ts";
import { measureRequestPressure } from "../model/token-meter.ts";
import { revalidateCompactionSelection, selectCompactionPrefix, selectModelCompactionPrefix } from "./compaction-selection.ts";

const newSession = () => new Session({ sessionId: "selection", createdAt: 1 });
const prepared: PreparedModel = {
  route: { provider: "p", model: "m" }, effectiveParams: { maxOutputTokens: 2000 }, modelBudget: { contextWindow: 100_000 },
  async *generate() { assert.fail("纯选区不请求模型"); },
};

function appendUser(session: Session, id: string, turn = 1, text = id) {
  return session.append({
    type: "user/message", surfaceOp: "append",
    data: { id, role: "user", source: { kind: "user" }, turn, requestId: id, content: [{ type: "text", text }] },
  });
}

function appendAssistant(session: Session, id: string, turn: number, step: number, callIds: readonly string[]) {
  return session.append({
    type: "assistant/message", surfaceOp: "append",
    data: {
      turn, step, finishReason: { kind: callIds.length ? "tool_calls" : "stop" }, stream: [], includeInModelContext: true,
      message: {
        id, role: "assistant", source: { provider: "p", model: "m" },
        content: callIds.map((callId) => ({ type: "tool-call", id: callId, name: "read", arguments: "{}" })),
      },
    },
  });
}

function appendResult(session: Session, declaration: ReturnType<typeof appendAssistant>, callId: string, isError = false) {
  return session.append({
    type: "tool/result", surfaceOp: "append", sourceEventSeqs: [declaration.seq],
    data: {
      turn: declaration.data.turn, step: declaration.data.step,
      message: { id: callId, role: "user", source: { kind: "tool", callId },
        content: [{ type: "tool-result", toolCallId: callId, isError, content: ["old"] }] },
    },
  });
}

function replaceResult(session: Session, result: ReturnType<typeof appendResult>, text: string) {
  return session.append({
    type: "tool/result", surfaceOp: { op: "replace", start: result.seq, end: result.seq }, sourceEventSeqs: [result.seq],
    data: { ...result.data, message: { ...result.data.message,
      content: [{ ...result.data.message.content[0], content: [text] }] } },
  });
}

function replaceWithCheckpoint(session: Session, start: number, end: number, sourceEventSeqs: number[]) {
  return session.append({
    type: "user/message", surfaceOp: { op: "replace", start, end }, sourceEventSeqs,
    data: { id: "checkpoint", role: "user", source: { kind: "compact", compactionId: "compaction" }, content: [] },
  });
}

test("按整节点保留达到预算的最短尾部，零预算仍保留末尾", () => {
  const session = newSession();
  const weights = new Map([["a", 8000], ["b", 6000], ["c", 7000], ["d", 5000], ["e", 6000]]);
  for (const id of weights.keys()) appendUser(session, id);
  const weight = ({ id }: { id: string }) => weights.get(id) ?? 0;
  const selection = selectCompactionPrefix(session, 16_000, weight);
  assert.deepEqual(selection?.shadowedSeqs, [0, 1]);
  assert.deepEqual(selection?.shadowedRange, { start: 0, end: 1 });
  assert.equal(selection?.shadowedTokens, 14_000);
  assert.deepEqual(selection?.nodes, session.deriveSurfaceNodes().slice(0, 2));
  assert.deepEqual(selectCompactionPrefix(session, 11_000, weight)?.shadowedSeqs, [0, 1, 2]);
  assert.deepEqual(selectCompactionPrefix(session, 0, () => 0)?.shadowedSeqs, [0, 1, 2, 3]);
  assert.equal(selectCompactionPrefix(session, 32_000, weight), undefined);

  const sparse = newSession();
  assert.equal(selectCompactionPrefix(sparse, 0, weight), undefined);
  appendUser(sparse, "a");
  assert.equal(selectCompactionPrefix(sparse, 0, weight), undefined);
});

test("零预算保留 Assistant 与全部工具结果，完整组可以入选", () => {
  const session = newSession();
  appendUser(session, "history");
  const assistant = appendAssistant(session, "a", 1, 1, ["one", "two"]);
  appendResult(session, assistant, "one", true);
  const second = appendResult(session, assistant, "two");
  assert.deepEqual(selectCompactionPrefix(session, 0, () => 1)?.shadowedSeqs, [0]);

  const replacement = replaceResult(session, second, "pruned");
  appendUser(session, "tail");
  const selection = selectCompactionPrefix(session, 0, () => 1);
  assert.deepEqual(selection?.shadowedSeqs, [0, 1, 2, 4]);
  assert.equal(selection?.nodes.at(-1), replacement);

  const onlyPair = newSession();
  appendResult(onlyPair, appendAssistant(onlyPair, "a", 1, 1, ["one"]), "one");
  assert.equal(selectCompactionPrefix(onlyPair, 0, () => 1), undefined);
});

test("交错工具组须链式回退，跨 Step 或 Turn 重用 callId 不串配", () => {
  const session = newSession();
  appendUser(session, "history");
  const first = appendAssistant(session, "a", 1, 1, ["same"]);
  const second = appendAssistant(session, "b", 1, 2, ["same"]);
  const third = appendAssistant(session, "c", 2, 1, ["same"]);
  appendResult(session, first, "same");
  appendResult(session, second, "same");
  appendResult(session, third, "same");
  assert.deepEqual(selectCompactionPrefix(session, 0, () => 1)?.shadowedSeqs, [0]);

  const separate = newSession();
  appendResult(separate, appendAssistant(separate, "a", 1, 1, ["same"]), "same");
  appendResult(separate, appendAssistant(separate, "b", 2, 1, ["same"]), "same");
  assert.deepEqual(selectCompactionPrefix(separate, 0, () => 1)?.shadowedSeqs, [0, 1]);
});

test("有缺失结果的声明不能入选，即使已写结果也在边界之前", () => {
  const session = newSession();
  appendUser(session, "history");
  const assistant = appendAssistant(session, "a", 1, 1, ["one", "missing"]);
  appendResult(session, assistant, "one");
  appendUser(session, "tail");
  assert.deepEqual(selectCompactionPrefix(session, 0, () => 1)?.shadowedSeqs, [0]);
});

test("替换工具组跨度中的无关消息不拆配对", () => {
  const session = newSession();
  const assistant = appendAssistant(session, "a", 1, 1, ["one"]);
  const unrelated = appendUser(session, "unrelated");
  appendResult(session, assistant, "one");
  const checkpoint = replaceWithCheckpoint(session, unrelated.seq, unrelated.seq, [unrelated.seq]);
  assert.deepEqual(session.deriveSurfaceNodes().map(({ seq }) => seq), [0, checkpoint.seq, 2]);
});

test("首步缺工具结果时，step/end 不能放开活动 Turn 的用户节点", () => {
  const session = newSession();
  appendUser(session, "history");
  session.append({ type: "turn/start", data: { turn: 2 } });
  appendUser(session, "active", 2);
  session.append({ type: "step/start", data: { turn: 2, step: 1 } });
  appendResult(session, appendAssistant(session, "a", 2, 1, ["one", "missing"]), "one");
  assert.equal(session.append({ type: "step/end", data: { turn: 2, step: 1 } }).type, "step/end");
  assert.deepEqual(session.deriveSurfaceNodes().filter((node) => node.type === "tool/result")
    .map((node) => node.data.message.source.callId), ["one"]);
  assert.deepEqual(selectCompactionPrefix(session, 0, () => 1)?.shadowedSeqs, [0]);
});

test("开步前和只有失败 Attempt 时均保留活动 Turn 的用户节点", () => {
  const session = newSession();
  appendUser(session, "history");
  session.append({ type: "turn/start", data: { turn: 2 } });
  const user = appendUser(session, "active", 2);
  const tail = appendUser(session, "tail", 3);
  assert.deepEqual(selectCompactionPrefix(session, 0, () => 1)?.shadowedSeqs, [0]);

  session.append({ type: "step/start", data: { turn: 2, step: 1 } });
  const failed = session.append({
    type: "assistant/attempt",
    data: { turn: 2, step: 1, outcome: "failed", reason: "provider", stream: [], includeInModelContext: false },
  });
  session.append({ type: "step/end", data: { turn: 2, step: 1 } });
  assert.deepEqual(session.deriveSurfaceNodes().map(({ seq }) => seq), [0, user.seq, tail.seq]);
  assert.ok(!session.deriveSurfaceNodes().some(({ seq }) => seq === failed.seq));
  assert.deepEqual(selectCompactionPrefix(session, 0, () => 1)?.shadowedSeqs, [0]);
});

test("首步关闭且结果齐全后可选完整旧 Step，开放的新 Step 仍保留", () => {
  const session = newSession();
  appendUser(session, "history");
  session.append({ type: "turn/start", data: { turn: 2 } });
  const user = appendUser(session, "active", 2);
  session.append({ type: "step/start", data: { turn: 2, step: 1 } });
  const assistant = appendAssistant(session, "first", 2, 1, ["one", "two"]);
  const first = appendResult(session, assistant, "one");
  const second = appendResult(session, assistant, "two");
  const oldTail = appendUser(session, "tail-before-close", 3);
  assert.deepEqual(selectCompactionPrefix(session, 0, () => 1)?.shadowedSeqs, [0]);

  session.append({ type: "step/end", data: { turn: 2, step: 1 } });
  assert.deepEqual(selectCompactionPrefix(session, 0, () => 1)?.shadowedSeqs,
    [0, user.seq, assistant.seq, first.seq, second.seq]);
  session.append({ type: "step/start", data: { turn: 2, step: 2 } });
  appendAssistant(session, "open", 2, 2, []);
  appendUser(session, "tail", 3);
  assert.deepEqual(selectCompactionPrefix(session, 0, () => 1)?.shadowedSeqs,
    [0, user.seq, assistant.seq, first.seq, second.seq, oldTail.seq]);
});

test("已结束的开步前取消不会阻挡选区，检查点不属于活动 Turn", () => {
  const session = newSession();
  session.append({ type: "turn/start", data: { turn: 1 } });
  const user = appendUser(session, "cancelled", 1);
  session.append({ type: "turn/end", data: { turn: 1, reason: { kind: "aborted", reason: "cancelled" } } });
  session.append({ type: "turn/start", data: { turn: 2 } });
  appendUser(session, "active", 2);
  assert.deepEqual(selectCompactionPrefix(session, 0, () => 1)?.shadowedSeqs, [user.seq]);
  const checkpoint = replaceWithCheckpoint(session, user.seq, user.seq, [user.seq]);
  assert.deepEqual(selectCompactionPrefix(session, 0, () => 1)?.shadowedSeqs, [checkpoint.seq]);
});

test("固定 Adapter 的实际工具配置和推理投影会改变尾部边界", () => {
  const session = newSession();
  appendUser(session, "a");
  session.append({
    type: "assistant/message", surfaceOp: "append",
    data: {
      turn: 1, step: 1, finishReason: { kind: "stop" }, stream: [], includeInModelContext: true,
      message: { id: "reasoning", role: "assistant", source: { provider: "p", model: "m" },
        content: [{ type: "reasoning", text: "x".repeat(40) }] },
    },
  });
  appendUser(session, "b");

  const model: PreparedModel = { ...prepared, includesAssistantReasoning: (tools) => tools.length > 0 };
  const tools = [{ name: "read", inputSchema: {} }];
  assert.deepEqual(selectModelCompactionPrefix(session, 16, model, tools)?.shadowedSeqs, [0]);
  assert.equal(selectModelCompactionPrefix(session, 16, model, []), undefined);
});

test("窗口 16% 与超限及手动的零预算使用同一选区，空范围不调用替身", () => {
  const session = newSession();
  for (const [index, weight] of [8000, 6000, 7000, 5000, 6000].entries()) {
    appendUser(session, String(index), 1, "x".repeat(4 * (weight - 8)));
  }
  let requests = 0;
  const exercise = (source: Session, budget: number) => {
    const selection = selectModelCompactionPrefix(source, budget, prepared, []);
    if (selection) requests++;
    return selection?.shadowedSeqs;
  };
  const pressure = measureRequestPressure(prepared, { messages: session.deriveMessages() });
  assert.equal(pressure.status, "measured");
  assert.equal(pressure.tailBudget, 16_000);
  assert.deepEqual(exercise(session, pressure.tailBudget), [0, 1]);
  assert.deepEqual(exercise(session, 0), [0, 1, 2, 3]);
  assert.deepEqual(exercise(session, 0), [0, 1, 2, 3]);
  assert.equal(requests, 3);

  const sparse = newSession();
  assert.equal(exercise(sparse, 0), undefined);
  const assistant = appendAssistant(sparse, "a", 1, 1, ["one"]);
  assert.equal(exercise(sparse, 0), undefined);
  appendResult(sparse, assistant, "one");
  assert.equal(exercise(sparse, 0), undefined);
  assert.equal(requests, 3);
});

test("复验按完整节点身份与 surface 顺序，原 Session 的尾部变动不构成冲突", () => {
  const session = newSession();
  const original = appendUser(session, "original");
  const assistant = appendAssistant(session, "a", 1, 1, ["one"]);
  const result = appendResult(session, assistant, "one");
  const lastSelected = appendUser(session, "last-selected");
  const tail = appendUser(session, "tail");
  const checkpoint = replaceWithCheckpoint(session, original.seq, original.seq, [original.seq]);
  const selection = selectCompactionPrefix(session, 0, () => 1);
  assert.ok(selection);
  assert.deepEqual(selection.shadowedRange, { start: checkpoint.seq, end: lastSelected.seq });
  assert.deepEqual(selection.shadowedSeqs, [checkpoint.seq, assistant.seq, result.seq, lastSelected.seq]);
  assert.equal(revalidateCompactionSelection(session, selection), true);

  const replay = new Session(session.header, { seed: { kind: "restore", events: session.snapshot().events, inheritedEventCount: 0 } });
  assert.equal(revalidateCompactionSelection(replay, selection), false);
  assert.equal(revalidateCompactionSelection(session, { ...selection, nodes: [...selection.nodes].reverse() }), false);
  assert.equal(revalidateCompactionSelection(session, {
    ...selection, nodes: selection.nodes.slice(0, 2),
    shadowedRange: { start: checkpoint.seq, end: assistant.seq }, shadowedSeqs: [checkpoint.seq, assistant.seq],
  }), false);

  appendUser(session, "new-tail");
  assert.equal(revalidateCompactionSelection(session, selection), true);
  replaceWithCheckpoint(session, tail.seq, tail.seq, [tail.seq]);
  assert.equal(revalidateCompactionSelection(session, selection), true);

  replaceResult(session, result, "different");
  assert.equal(revalidateCompactionSelection(session, selection), false);
  const current = selectCompactionPrefix(session, 1, () => 1);
  assert.ok(current);
  replaceWithCheckpoint(session, checkpoint.seq, checkpoint.seq, [checkpoint.seq]);
  assert.equal(revalidateCompactionSelection(session, current), false);
});
