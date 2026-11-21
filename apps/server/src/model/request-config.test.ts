import assert from "node:assert/strict";
import { test } from "node:test";
import { LlmRuntime } from "./runtime.ts";
import { createMockAdapter } from "./providers/mock.ts";

test("模型信息默认值与显式请求归一为独立快照", () => {
  const adapter = { ...createMockAdapter(() => []), modelInfo: { defaultMaxTokens: 512, supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" } };
  const runtime = new LlmRuntime({ mock: adapter });
  const stop = ["end"];
  const prepared = runtime.prepare({ provider: "mock", model: "m", params: { stop } }, { recordable: true });
  stop.push("later");
  assert.deepEqual(prepared.effectiveParams, { maxOutputTokens: 512, reasoningEffort: "low", stop: ["end"] });
  assert.deepEqual(prepared.adapterDefaults, { maxTokens: 512, reasoningEffort: "low" });
  assert.throws(() => runtime.prepare({ provider: "mock", model: "m", params: { reasoningEffort: "invalid" } }), /reasoningEffort/);
});

test("可记录模式要求显式覆盖旧温度默认值，普通模式仍继承温度", () => {
  const runtime = new LlmRuntime({ mock: { ...createMockAdapter(() => []), defaultParams: { temperature: 0.7, maxOutputTokens: 128 } } });
  const base = { provider: "mock", model: "m" };
  assert.deepEqual(runtime.prepare(base).effectiveParams, { temperature: 0.7, maxOutputTokens: 128 });
  assert.throws(() => runtime.prepare(base, { recordable: true }), /默认/);
  assert.throws(() => runtime.prepare({ ...base, params: { stop: [] } }, { recordable: true }), /默认/);
  const prepared = runtime.prepare({ ...base, params: { temperature: 0 } }, { recordable: true });
  assert.deepEqual(prepared.effectiveParams, { temperature: 0, maxOutputTokens: 128 });
  assert.deepEqual(prepared.adapterDefaults, { maxTokens: 128 });
});

test("推理强度按显式值、模型信息和旧默认值依次选择并记录来源", () => {
  const base = { provider: "mock", model: "m" };
  const legacy = new LlmRuntime({ mock: { ...createMockAdapter(() => []), defaultParams: { reasoningEffort: "high" } } });
  assert.deepEqual(legacy.prepare(base).effectiveParams, { reasoningEffort: "high" });
  const recorded = legacy.prepare(base, { recordable: true });
  assert.deepEqual(recorded.effectiveParams, { reasoningEffort: "high" });
  assert.deepEqual(recorded.adapterDefaults, { reasoningEffort: "high" });
  const info = new LlmRuntime({ mock: { ...createMockAdapter(() => []), defaultParams: { reasoningEffort: "high" }, modelInfo: { defaultReasoningEffort: "low", supportedReasoningEfforts: ["low", "high"] } } });
  assert.deepEqual(info.prepare(base).adapterDefaults, { reasoningEffort: "low" });
  const explicit = info.prepare({ ...base, params: { reasoningEffort: "high" } }, { recordable: true });
  assert.deepEqual(explicit.effectiveParams, { reasoningEffort: "high" });
  assert.equal(explicit.adapterDefaults, undefined);
  const unsupported = new LlmRuntime({ mock: { ...createMockAdapter(() => []), defaultParams: { reasoningEffort: "high" }, modelInfo: { supportedReasoningEfforts: ["low"] } } });
  assert.throws(() => unsupported.prepare(base), /reasoningEffort/);
  assert.throws(() => unsupported.prepare(base, { recordable: true }), /reasoningEffort/);
});

test("模型预算按路由隔离并在准备时复制校验", () => {
  const budgets = { a: { contextWindow: 100, defaultOutputTokens: 10 }, b: { contextWindow: 200 } };
  const runtime = new LlmRuntime({ one: { ...createMockAdapter(() => { throw new Error("unexpected generation"); }), modelBudgets: budgets }, two: { ...createMockAdapter(() => []), modelBudgets: { a: { defaultOutputTokens: 20 } } } });
  const a = runtime.prepare({ provider: "one", model: "a" });
  assert.deepEqual(a.modelBudget, { contextWindow: 100, defaultOutputTokens: 10 });
  assert.deepEqual(runtime.prepare({ provider: "one", model: "b" }).modelBudget, { contextWindow: 200 });
  assert.deepEqual(runtime.prepare({ provider: "two", model: "a" }).modelBudget, { defaultOutputTokens: 20 });
  assert.equal(runtime.prepare({ provider: "one", model: "missing" }).modelBudget, undefined);
  budgets.a.contextWindow = 300;
  assert.equal(a.modelBudget?.contextWindow, 100);
  for (const value of [0, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = new LlmRuntime({ one: { ...createMockAdapter(() => []), modelBudgets: { a: { contextWindow: value } } } });
    assert.throws(() => invalid.prepare({ provider: "one", model: "a" }), /budget/i);
    const invalidOutput = new LlmRuntime({ one: { ...createMockAdapter(() => []), modelBudgets: { a: { defaultOutputTokens: value } } } });
    assert.throws(() => invalidOutput.prepare({ provider: "one", model: "a" }), /budget/i);
  }
});

test("模型预算只读取一次并保留原型 getter 的已校验值", () => {
  let windowReads = 0; let outputReads = 0;
  class Budget {
    get contextWindow() { windowReads++; return windowReads === 1 ? 100000 : 0; }
    get defaultOutputTokens() { outputReads++; return outputReads === 1 ? 2000 : 0; }
  }
  const runtime = new LlmRuntime({ mock: { ...createMockAdapter(() => []), modelBudgets: { m: new Budget() } } });
  const prepared = runtime.prepare({ provider: "mock", model: "m" });
  assert.deepEqual(prepared.modelBudget, { contextWindow: 100000, defaultOutputTokens: 2000 });
  assert.equal(Object.isFrozen(prepared.modelBudget), true);
  assert.equal(windowReads, 1); assert.equal(outputReads, 1);
});

test("准备模型时预算注册表 getter 只读取一次", () => {
  let reads = 0;
  const adapter = { ...createMockAdapter(() => []), get modelBudgets() {
    reads++;
    return reads === 1 ? { m: { contextWindow: 100000, defaultOutputTokens: 2000 } } : undefined;
  } };
  const prepared = new LlmRuntime({ mock: adapter }).prepare({ provider: "mock", model: "m" });
  assert.deepEqual(prepared.modelBudget, { contextWindow: 100000, defaultOutputTokens: 2000 });
  assert.equal(reads, 1);
});
