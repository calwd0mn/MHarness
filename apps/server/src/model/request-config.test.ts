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

test("可记录模式拒绝未显式覆盖的旧采样默认值，普通模式保留原行为", () => {
  const runtime = new LlmRuntime({ mock: { ...createMockAdapter(() => []), defaultParams: { temperature: 0.7, stop: ["old"], maxOutputTokens: 128 } } });
  const base = { provider: "mock", model: "m" };
  assert.deepEqual(runtime.prepare(base).effectiveParams, { temperature: 0.7, stop: ["old"], maxOutputTokens: 128 });
  assert.throws(() => runtime.prepare(base, { recordable: true }), /默认/);
  assert.throws(() => runtime.prepare({ ...base, params: { temperature: 0 } }, { recordable: true }), /默认/);
  assert.throws(() => runtime.prepare({ ...base, params: { stop: [] } }, { recordable: true }), /默认/);
  const prepared = runtime.prepare({ ...base, params: { temperature: 0, stop: [] } }, { recordable: true });
  assert.deepEqual(prepared.effectiveParams, { temperature: 0, stop: [], maxOutputTokens: 128 });
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
