import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "@mharness/session/server";
import { LlmRuntime } from "./runtime.ts";
import { createMockAdapter } from "./providers/mock.ts";
import { estimateSurfaceMessageTokens, measureRequestPressure, checkAutomaticPressure } from "./token-meter.ts";

const runtime = new LlmRuntime({ mock: { ...createMockAdapter(() => []), modelBudgets: { m: { contextWindow: 100000, defaultOutputTokens: 2000 } } } });
const prepared = runtime.prepare({ provider: "mock", model: "m" });
const user = (text: string) => {
  const session = new Session({ sessionId: "s", createdAt: 1 });
  session.append({ type: "user/message", surfaceOp: "append", data: { id: "u", role: "user", source: { kind: "user" }, turn: 1, requestId: "r", content: [{ type: "text", text }] } });
  return session.deriveMessages()[0]!;
};

test("逐块估算使用 UTF-16 长度和固定开销", () => {
  assert.equal(estimateSurfaceMessageTokens(prepared, user("a".repeat(100)), []), 33);
  assert.equal(estimateSurfaceMessageTokens(prepared, user("汉字😀😀"), []), 10);
  assert.equal(estimateSurfaceMessageTokens(prepared, user(""), []), 8);
});

test("请求压力使用系统、工具和输出预留并按阈值判定", () => {
  assert.deepEqual(measureRequestPressure(prepared, { messages: [user("a".repeat(311964))] }), { status: "measured", inputTokens: 77999, outputTokens: 2000, pressure: 79999, contextWindow: 100000, threshold: 80000, tailBudget: 16000, triggered: false });
  const edge = measureRequestPressure(prepared, { messages: [user("a".repeat(311968))] });
  assert.equal(edge.status === "measured" && edge.triggered, true);
  const tools = [{ name: "t", description: "a".repeat(7952), inputSchema: {} }];
  const full = measureRequestPressure(prepared, { systemPrompt: "s".repeat(4000), tools, messages: [user("a".repeat(39968))] });
  assert.equal(full.status === "measured" && full.inputTokens, 13008);
  assert.equal(full.status === "measured" && full.pressure, 15008);
});

test("缺少预算报告稳定原因，安全整数窗口精确取比例", () => {
  const noBudget = new LlmRuntime({ mock: createMockAdapter(() => []) }).prepare({ provider: "mock", model: "m" });
  const warnings: unknown[] = [];
  assert.deepEqual(checkAutomaticPressure(noBudget, { messages: [] }, (route, reason) => warnings.push({ route, reason })), { status: "unavailable", reason: "missing-context-window" });
  assert.deepEqual(warnings, [{ route: { provider: "mock", model: "m" }, reason: "missing-context-window" }]);
  for (const [window, threshold, tailBudget] of [[100003, 80002, 16000], [9007199254740986, 7205759403792788, 1441151880758557], [9007199254740987, 7205759403792789, 1441151880758557]]) {
    const model = new LlmRuntime({ mock: { ...createMockAdapter(() => []), modelBudgets: { m: { contextWindow: window, defaultOutputTokens: 1 } } } }).prepare({ provider: "mock", model: "m" });
    const result = measureRequestPressure(model, { messages: [] });
    assert.equal(result.status === "measured" && result.threshold, threshold);
    assert.equal(result.status === "measured" && result.tailBudget, tailBudget);
  }
});

test("块边界、工具调用和工具结果分别计量", () => {
  const s = new Session({ sessionId: "blocks", createdAt: 1 });
  s.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "a", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "text", text: "A" }, { type: "text", text: "B" }, { type: "reasoning", text: "想😀" }, { type: "reasoning", text: "继续🤖" }, { type: "tool-call", id: "c", name: "read", arguments: "{}" }] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true } });
  s.append({ type: "tool/result", surfaceOp: "append", sourceEventSeqs: [0], data: { turn: 1, step: 1, message: { id: "r", role: "user", source: { kind: "tool", callId: "c" }, content: [{ type: "tool-result", toolCallId: "c", isError: false, content: [{ type: "future", value: 1 }] }] } } });
  const [assistant, result] = s.deriveMessages(); assert.ok(assistant); assert.ok(result);
  assert.equal(estimateSurfaceMessageTokens(prepared, assistant, []), 30);
  assert.equal(estimateSurfaceMessageTokens(prepared, result, []), 19);
  const noReasoning = { ...prepared, includesAssistantReasoning: () => false };
  assert.equal(estimateSurfaceMessageTokens(noReasoning, assistant, []), 20);
});

test("预算缺失与显式上限覆盖", () => {
  const adapter = { ...createMockAdapter(() => []), modelBudgets: { m: { contextWindow: 100000 } } };
  const runtime = new LlmRuntime({ mock: adapter });
  const absent = runtime.prepare({ provider: "mock", model: "m" });
  const warnings: string[] = [];
  assert.deepEqual(checkAutomaticPressure(absent, { messages: [] }, (_route, reason) => warnings.push(reason)), { status: "unavailable", reason: "missing-output-budget" });
  assert.deepEqual(warnings, ["missing-output-budget"]);
  const explicit = runtime.prepare({ provider: "mock", model: "m", params: { maxOutputTokens: 123 } });
  const result = checkAutomaticPressure(explicit, { messages: [] }, () => assert.fail("unexpected warning"));
  assert.equal(result.status === "measured" && result.pressure, 123);
});

test("当前模型和 surface 替换重测无需历史请求头", () => {
  const session = new Session({ sessionId: "replace", createdAt: 1 });
  const append = (id: string, text: string) => session.append({ type: "user/message", surfaceOp: "append", data: { id, role: "user", source: { kind: "user" }, turn: 1, requestId: id, content: [{ type: "text", text }] } });
  append("old", "a".repeat(100)); append("tail", "tail");
  const tools = [{ name: "t", description: "", inputSchema: {} }];
  const input = () => ({ systemPrompt: "sys", tools, messages: session.deriveMessages() });
  const first = measureRequestPressure(prepared, input());
  assert.equal(first.status === "measured" && first.inputTokens, 63);
  assert.equal(first.status === "measured" && first.pressure, 2063);
  const before = session.seq;
  session.append({ type: "user/message", surfaceOp: { op: "replace", start: 0, end: 0 }, sourceEventSeqs: [0], data: { id: "summary", role: "user", source: { kind: "compact", compactionId: "c" }, content: [{ type: "text", text: "sum" }] } });
  const second = measureRequestPressure(prepared, input());
  assert.equal(second.status === "measured" && second.inputTokens, 39);
  assert.equal(second.status === "measured" && second.pressure, 2039);
  assert.equal(session.seq, before + 1); assert.equal(session.snapshot().events.length, 3);
  const other = new LlmRuntime({ mock: { ...createMockAdapter(() => []), modelBudgets: { b: { contextWindow: 200, defaultOutputTokens: 10 } } } }).prepare({ provider: "mock", model: "b" });
  const otherResult = measureRequestPressure(other, input());
  assert.equal(otherResult.status === "measured" && otherResult.contextWindow, 200);
  assert.equal(prepared.modelBudget?.contextWindow, 100000);
});

test("原始块、嵌套工具结果和缺省 envelope 分开计费", async () => {
  const { estimateRequestTokens } = await import("./token-meter.ts");
  const s = new Session({ sessionId: "nested", createdAt: 1 });
  s.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "a", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "tool-call", id: "c", name: "x", arguments: "123" }] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true } });
  s.append({ type: "tool/result", surfaceOp: "append", sourceEventSeqs: [0], data: { turn: 1, step: 1, message: { id: "r", role: "user", source: { kind: "tool", callId: "c" }, content: [{ type: "tool-result", toolCallId: "c", isError: false, content: [{ type: "tool-result", content: [{ type: "text", text: "a".repeat(100) }] }] }] } } });
  const [call, nested] = s.deriveMessages(); assert.ok(call); assert.ok(nested);
  assert.equal(estimateSurfaceMessageTokens(prepared, call, []), 10);
  assert.equal(estimateSurfaceMessageTokens(prepared, nested, []), 41);
  assert.equal(estimateRequestTokens(prepared, { messages: [] }), 0);
  assert.equal(estimateRequestTokens(prepared, { systemPrompt: "", messages: [], tools: [] }), 4);
  const two = new Session({ sessionId: "two", createdAt: 1 });
  two.append({ type: "user/message", surfaceOp: "append", data: { id: "u", role: "user", source: { kind: "user" }, turn: 1, requestId: "r", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } });
  assert.equal(estimateSurfaceMessageTokens(prepared, two.deriveMessages()[0]!, []), 14);
});

test("已有 A 请求头的会话按当前 B 快照计量且不追加事件", async () => {
  const { createRequestPreparer, foldRequestHeader } = await import("../agent/request-context.ts");
  const session = new Session({ sessionId: "model-switch", createdAt: 1 });
  session.append({ type: "user/message", surfaceOp: "append", data: { id: "u", role: "user", source: { kind: "user" }, turn: 1, requestId: "r", content: [{ type: "text", text: "abcd" }] } });
  const runtime = new LlmRuntime({ mock: { ...createMockAdapter(() => []), modelBudgets: {
    a: { contextWindow: 100000, defaultOutputTokens: 2000 },
    b: { contextWindow: 200, defaultOutputTokens: 10 },
  } } });
  let selectedModel = "a";
  const config = () => ({ provider: "mock", model: selectedModel });
  const snapshotA = runtime.prepare(config());
  const input = () => ({ systemPrompt: "sys", tools: [], messages: session.deriveMessages() });
  assert.equal(foldRequestHeader(session.snapshot().events), undefined);
  assert.equal(measureRequestPressure(snapshotA, input()).status, "measured");
  const { prepared: headerA } = createRequestPreparer({ runtime, config, systemPrompt: () => "sys" })(session);
  assert.equal(foldRequestHeader(session.snapshot().events)?.config.model, "a");
  selectedModel = "b";
  const snapshotB = runtime.prepare(config());
  const before = session.snapshot();
  const expectedB = { status: "measured", inputTokens: 14, outputTokens: 10, pressure: 24, contextWindow: 200, threshold: 160, tailBudget: 32, triggered: false };
  assert.deepEqual(measureRequestPressure(snapshotB, input()), expectedB);
  assert.deepEqual(measureRequestPressure(headerA, input()), { status: "measured", inputTokens: 14, outputTokens: 2000, pressure: 2014, contextWindow: 100000, threshold: 80000, tailBudget: 16000, triggered: false });
  assert.deepEqual(snapshotA.modelBudget, { contextWindow: 100000, defaultOutputTokens: 2000 });
  assert.deepEqual(session.snapshot(), before);
});

test("压力超过安全整数时保留精确值和阈值判断", () => {
  const runtime = new LlmRuntime({ mock: { ...createMockAdapter(() => []), modelBudgets: { m: { contextWindow: Number.MAX_SAFE_INTEGER } } } });
  for (const [output, expected] of [[Number.MAX_SAFE_INTEGER - 4, Number.MAX_SAFE_INTEGER], [Number.MAX_SAFE_INTEGER, 9007199254740995n]] as const) {
    const model = runtime.prepare({ provider: "mock", model: "m", params: { maxOutputTokens: output } });
    const result = measureRequestPressure(model, { systemPrompt: "", messages: [] });
    assert.equal(result.status, "measured");
    if (result.status === "measured") { assert.equal(result.pressure, expected); assert.equal(result.triggered, true); }
  }
});
