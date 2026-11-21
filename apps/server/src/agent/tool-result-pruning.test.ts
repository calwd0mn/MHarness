import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "@mharness/session/server";
import { createToolResultPruningConfig, selectToolResultPruning } from "./tool-result-pruning.ts";

function fixture(content: readonly (string | { readonly type: string; readonly text?: string })[]) {
  const session = new Session({ sessionId: "prune", createdAt: 1 });
  session.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "a", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "tool-call", id: "c", name: "read", arguments: "{}" }] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true } });
  session.append({ type: "tool/result", surfaceOp: "append", sourceEventSeqs: [0], data: { turn: 1, step: 1, message: { id: "r", role: "user", source: { kind: "tool", callId: "c" }, content: [{ type: "tool-result", toolCallId: "c", isError: false, content }] }, meta: { value: 1 } } });
  return session;
}

test("自定义预算在第一个被删除的文本块插入标记", () => {
  const session = fixture([{ type: "text", text: "ab" }, { type: "image" }, { type: "text", text: "c".repeat(99) }]);
  const [candidate] = selectToolResultPruning(session.deriveSurfaceNodes(), {
    thresholdChars: 100, headChars: 2, tailChars: 1, marker: "\n\n[... tool result middle pruned ...]\n\n",
  });
  assert.ok(candidate);
  assert.deepEqual(candidate.data.message.content[0].content, [
    { type: "text", text: "ab" }, { type: "image" }, { type: "text", text: "\n\n[... tool result middle pruned ...]\n\nc" },
  ]);
});

test("预算校验按码点计入标记，并拒绝无效范围", () => {
  const session = fixture([{ type: "text", text: "abcd" }]);
  const config = { thresholdChars: 3, headChars: 1, tailChars: 1, marker: "😀" };
  const [candidate] = selectToolResultPruning(session.deriveSurfaceNodes(), config);
  assert.ok(candidate);
  assert.deepEqual(candidate.data.message.content[0].content, [{ type: "text", text: "a😀d" }]);
  for (const invalid of [
    { ...config, thresholdChars: 0 }, { ...config, thresholdChars: 2 },
    { ...config, headChars: -1 }, { ...config, tailChars: 0.5 },
    { ...config, headChars: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.throws(() => selectToolResultPruning([], invalid), RangeError);
});

test("配置初始化时校验预算并固定独立副本", () => {
  const input = { thresholdChars: 3, headChars: 1, tailChars: 1, marker: "😀" };
  const config = createToolResultPruningConfig(input);
  input.headChars = 2;
  assert.equal(config.headChars, 1);
  assert.equal(Object.isFrozen(config), true);
  assert.throws(() => createToolResultPruningConfig({ ...config, thresholdChars: 2 }), RangeError);
});

test("头尾预算为零时仅保留删除区间标记和非文本块", () => {
  const session = fixture([{ type: "image" }, { type: "text", text: "abcd" }, { type: "future" }]);
  const [candidate] = selectToolResultPruning(session.deriveSurfaceNodes(), { thresholdChars: 3, headChars: 0, tailChars: 0, marker: "." });
  assert.ok(candidate);
  assert.deepEqual(candidate.data.message.content[0].content, [{ type: "image" }, { type: "text", text: "." }, { type: "future" }]);
});

test("跨块修剪保留有效文本块的附加字段和未知 JSON", () => {
  const first = { type: "text", text: "ab", style: "head" };
  const middle = { type: "text", text: "cdef", style: "middle" };
  const last = { type: "text", text: "gh", style: "tail" };
  const session = fixture([first, { type: "image" }, middle, "unknown", last]);
  const [candidate] = selectToolResultPruning(session.deriveSurfaceNodes(), { thresholdChars: 7, headChars: 2, tailChars: 2, marker: "..." });
  assert.ok(candidate);
  assert.deepEqual(candidate.data.message.content[0].content, [first, { type: "image" }, { ...middle, text: "..." }, "unknown", last]);
});

test("按 Unicode 码点阈值裁剪且保留原输入", () => {
  const short = fixture([{ type: "text", text: "😀".repeat(8192) }]);
  assert.equal(selectToolResultPruning(short.deriveSurfaceNodes()).length, 0);
  const session = fixture([{ type: "text", text: "😀".repeat(8193) }]);
  const before = session.snapshot();
  const [candidate] = selectToolResultPruning(session.deriveSurfaceNodes());
  assert.ok(candidate);
  assert.deepEqual(candidate.data.message.content[0].content, [{ type: "text", text: "😀".repeat(4096) + "\n\n[... tool result middle pruned ...]\n\n" + "😀".repeat(1024) }]);
  assert.deepEqual(session.snapshot(), before);
  assert.deepEqual(candidate.data.meta, { value: 1 });
});

test("头部恰在块边界时标记位于被删除块，修剪后不重复修剪", () => {
  const session = fixture([{ type: "text", text: "a".repeat(4096) }, { type: "image" }, { type: "text", text: "b".repeat(4097) }]);
  const nodes = session.deriveSurfaceNodes();
  const [candidate] = selectToolResultPruning(nodes);
  assert.ok(candidate);
  assert.deepEqual(candidate.data.message.content[0].content, [{ type: "text", text: "a".repeat(4096) }, { type: "image" }, { type: "text", text: "\n\n[... tool result middle pruned ...]\n\n" + "b".repeat(1024) }]);
  const replacement = { ...candidate.original, data: candidate.data };
  assert.equal(selectToolResultPruning([replacement]).length, 0);
});

test("跨块保留非文本顺序并仅插一次标记", () => {
  const session = fixture([{ type: "text", text: "a".repeat(5000) }, { type: "image" }, { type: "text", text: "b".repeat(4000) }, { type: "future" }, { type: "text", text: "c".repeat(500) }]);
  const nodes = session.deriveSurfaceNodes();
  const [candidate] = selectToolResultPruning(nodes);
  assert.ok(candidate);
  assert.deepEqual(candidate.data.message.content[0].content, [{ type: "text", text: "a".repeat(4096) + "\n\n[... tool result middle pruned ...]\n\n" }, { type: "image" }, { type: "text", text: "b".repeat(524) }, { type: "future" }, { type: "text", text: "c".repeat(500) }]);
});
