import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "@mharness/session/server";
import { createMockAdapter } from "../model/providers/mock.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { createRequestPreparer, foldRequestHeader, rebuildRequestContext } from "./request-context.ts";

function session() { return new Session({ sessionId: "s", createdAt: 1 }); }
function user(s: Session, text: string) {
  s.append({ type: "user/message", surfaceOp: "append", data: { id: text, role: "user", source: { kind: "user" }, content: [{ type: "text", text }], turn: 1, requestId: text } });
}

test("请求头记录默认来源，输入隔离可变工具并可从前缀重建", () => {
  const s = session(); user(s, "hello");
  const tools = [{ name: "lookup", inputSchema: { properties: { value: { type: "string" } } } }];
  const runtime = new LlmRuntime({ mock: { ...createMockAdapter(() => []), modelInfo: { defaultMaxTokens: 200, defaultReasoningEffort: "low", supportedReasoningEfforts: ["low"] } } });
  const prepare = createRequestPreparer({ runtime, config: () => ({ provider: "mock", model: "m", params: { stop: ["end"] } }), systemPrompt: () => "sys", tools: () => tools });
  const first = prepare(s);
  tools[0]!.inputSchema.properties.value.type = "number";
  const header = foldRequestHeader(s.snapshot().events);
  assert.deepEqual(header?.config, { provider: "mock", model: "m", reasoningEffort: "low", maxTokens: 200, stop: ["end"] });
  assert.deepEqual(header?.adapterDefaults, { maxTokens: 200, reasoningEffort: "low" });
  assert.deepEqual(first.prepared.effectiveParams, { reasoningEffort: "low", stop: ["end"], maxOutputTokens: 200 });
  assert.deepEqual(rebuildRequestContext(s).input, first.input);
  assert.equal(Object.isFrozen(first.input.tools[0]?.inputSchema), true);
  const second = prepare(s);
  assert.notEqual(first.input.messages, second.input.messages);
  const reasons = s.snapshot().events.filter((e) => e.type === "request/header").map((e) => e.data.reason);
  assert.deepEqual(reasons, ["initial", "change"]);
});

test("相同配置复用头，显式系列与组合变化及恢复各有标记", () => {
  const s = session(); let prompt = "one";
  const opts = { runtime: new LlmRuntime({ mock: createMockAdapter(() => []) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => prompt };
  const prepare = createRequestPreparer(opts);
  prepare(s); prepare(s); prepare(s, true); prompt = "two"; prepare(s, true);
  const headers = s.snapshot().events.filter((e) => e.type === "request/header");
  assert.deepEqual(headers.map((e) => [e.data.reason, e.data.startsSeries]), [["initial", undefined], ["series", undefined], ["change", true]]);
  const restored = new Session(s.header, { seed: { kind: "restore", events: s.snapshot().events, inheritedEventCount: 0 } });
  createRequestPreparer(opts)(restored);
  assert.equal(restored.snapshot().events.at(-1)?.type, "request/header");
  const last = restored.snapshot().events.at(-1);
  assert.ok(last?.type === "request/header"); assert.equal(last.data.reason, "resume");
});

test("不可记录参数在写入头之前拒绝", () => {
  const s = session();
  const runtime = new LlmRuntime({ mock: { ...createMockAdapter(() => []), defaultParams: { topP: 0.9 } } });
  assert.throws(() => createRequestPreparer({ runtime, config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "" })(s), /不能记录/);
  assert.equal(s.seq, 0);
});

test("多个准备器交替使用同一会话时重建最近实际请求", () => {
  const s = session();
  const runtime = new LlmRuntime({ mock: createMockAdapter(() => []) });
  const config = () => ({ provider: "mock", model: "m" });
  const a = createRequestPreparer({ runtime, config, systemPrompt: () => "A" });
  const b = createRequestPreparer({ runtime, config, systemPrompt: () => "B" });
  a(s); b(s);
  const last = a(s);
  assert.equal(last.input.systemPrompt, "A");
  assert.deepEqual(rebuildRequestContext(s).input, last.input);
  assert.deepEqual(s.snapshot().events.filter((e) => e.type === "request/header").map((e) => e.data.reason), ["initial", "resume", "change"]);
});

test("工具描述无效时不追加事件或改变准备器状态", () => {
  const s = session();
  let invalid = true;
  const prepare = createRequestPreparer({
    runtime: new LlmRuntime({ mock: createMockAdapter(() => []) }),
    config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "sys",
    tools: () => invalid ? [{ name: "x", inputSchema: null as unknown as Record<string, unknown> }] : [],
  });
  assert.throws(() => prepare(s), /工具定义无效/);
  assert.equal(s.seq, 0);
  invalid = false;
  prepare(s);
  const event = s.snapshot().events[0];
  assert.ok(event?.type === "request/header");
  assert.equal(event.data.reason, "initial");
});

test("Turn 未覆盖旧采样默认值时拒绝且不追加头", () => {
  const s = session();
  const runtime = new LlmRuntime({ mock: { ...createMockAdapter(() => []), defaultParams: { temperature: 0.5, stop: ["end"] } } });
  const prepare = createRequestPreparer({ runtime, config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "" });
  assert.throws(() => prepare(s), /默认/);
  assert.equal(s.seq, 0);
});

test("没有请求头的闭合 seed 在分支首次生成仍写 resume", () => {
  const parent = session();
  parent.append({ type: "turn/start", data: { turn: 1 } });
  user(parent, "inherited");
  parent.append({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  const child = new Session({ sessionId: "child", parentSession: parent.header.sessionId, isSeeded: true, createdAt: 2 },
    { seed: { kind: "fork", events: parent.snapshot().events } });
  const prepare = createRequestPreparer({ runtime: new LlmRuntime({ mock: createMockAdapter(() => []) }),
    config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "sys" });
  assert.deepEqual(prepare(child).input.messages, [{ role: "user", text: "inherited" }]);
  const header = child.snapshot().events.at(-1);
  assert.ok(header?.type === "request/header");
  assert.equal(header.data.reason, "resume");
});
