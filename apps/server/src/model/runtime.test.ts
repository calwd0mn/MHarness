import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { LlmError } from "./adapter.ts";
import type { StreamChunk, ModelAdapter, ModelInput, ModelRequest } from "./adapter.ts";
import { createMockAdapter } from "./providers/mock.ts";
import { LlmRuntime } from "./runtime.ts";

const route = { provider: "mock", model: "test-model" };
const input: ModelInput = {
  systemPrompt: "测试提示词",
  messages: [{ role: "user", text: "你好" }],
  tools: [{ name: "lookup", inputSchema: { type: "object" } }],
};
const textChunk = { type: "text-delta", index: 0, text: "正在查询" } as const;
const stopChunk = { type: "finish", reason: { kind: "stop" } } as const;

async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test("同路由派生请求保留原 Adapter 并独立准备摘要参数", async () => {
  const captured: { adapter: string; request: ModelRequest }[] = [];
  let selected = "original";
  let factories = 0;
  const runtime = new LlmRuntime({ mock: () => {
    factories++;
    const adapter = selected;
    return {
      ...createMockAdapter(request => {
        captured.push({ adapter, request });
        return [{ chunk: stopChunk }];
      }),
      modelInfo: { supportedReasoningEfforts: ["high", "none"] },
    };
  } });
  const config = { ...route, endpointId: "fixed" };
  const business = runtime.prepare({ ...config, params: { reasoningEffort: "high", maxOutputTokens: 2048 } });
  selected = "changed";
  assert.equal(business.disableReasoningEffort, "none");
  assert.throws(() => runtime.prepareForSameRoute(business, { ...config, endpointId: "changed" }), /路由/);
  assert.throws(() => new LlmRuntime({}).prepareForSameRoute(business, config), /路由/);
  const summary = runtime.prepareForSameRoute(business, { ...config, params: { reasoningEffort: business.disableReasoningEffort, maxOutputTokens: 8192 } });
  const signal = new AbortController().signal;
  await collect(business.generate(input, signal));
  await collect(summary.generate({ ...input, tools: [] }, signal));
  assert.equal(factories, 1);
  assert.deepEqual(captured.map(({ adapter, request }) => [adapter, request.route, request.effectiveParams.reasoningEffort, request.effectiveParams.maxOutputTokens, request.tools.length]), [
    ["original", config, "high", 2048, 1], ["original", config, "none", 8192, 0],
  ]);
});

test("按已准备的配置选择 Adapter，并保留文本、工具分片、usage 和正常结束的顺序", async () => {
  const chunks: StreamChunk[] = [
    textChunk,
    { type: "tool-call-delta", index: 1, id: "call-1", name: "lookup", argumentsDelta: '{"q":' },
    { type: "tool-call-delta", index: 1, argumentsDelta: '"MHarness"}' },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 8 } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ];
  const requests: ModelRequest[] = [];
  const defaultParams = { temperature: 0.8, maxOutputTokens: 1024 };
  const adapter = createMockAdapter((request) => {
    requests.push(request);
    return chunks.map((chunk) => ({ chunk }));
  });
  const adapters = {
    mock: { ...adapter, defaultParams },
    alternate: createMockAdapter(() => assert.fail("选中了错误的 Adapter")),
  };
  const runtime = new LlmRuntime(adapters);
  const config = { ...route, endpointId: "local", params: { temperature: 0 }, timeouts: { idleTimeoutMs: 1000 } };
  const prepared = runtime.prepare(config);
  config.params.temperature = 2;
  config.endpointId = "changed";
  config.timeouts.idleTimeoutMs = 1;
  defaultParams.maxOutputTokens = 32;
  adapters.mock = { ...adapters.alternate, defaultParams };

  assert.equal(requests.length, 0);
  assert.deepEqual(prepared.route, { ...route, endpointId: "local" });
  assert.deepEqual(prepared.effectiveParams, { temperature: 0, maxOutputTokens: 1024 });
  assert.ok(Object.isFrozen(prepared.route));
  assert.ok(Object.isFrozen(prepared.effectiveParams));
  assert.deepEqual(await collect(prepared.generate(input, new AbortController().signal)), chunks);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    ...input,
    route: prepared.route,
    effectiveParams: prepared.effectiveParams,
    timeouts: { requestTimeoutMs: 30_000, idleTimeoutMs: 1000 },
  });
});

test("在请求发起前拒绝未知 Provider、空路由、非法生成参数及超时", () => {
  const runtime = new LlmRuntime({ mock: createMockAdapter(() => assert.fail("意外启动生成")) });
  assert.throws(() => runtime.prepare({ ...route, provider: "unknown" }), /not registered/);
  assert.throws(() => runtime.prepare({ ...route, model: " " }), /model/);
  assert.throws(() => runtime.prepare({ ...route, endpointId: "" }), /endpointId/);
  assert.throws(() => runtime.prepare({ ...route, params: { temperature: 3 } }), /temperature/);
  assert.throws(() => runtime.prepare({ ...route, params: { topP: NaN } }), /topP/);
  assert.throws(() => runtime.prepare({ ...route, params: { maxOutputTokens: 0 } }), /maxOutputTokens/);
  assert.throws(() => runtime.prepare({ ...route, timeouts: { requestTimeoutMs: Infinity } }), /timeout/);
});

test("Adapter 错误只产生一个 finish，保留安全诊断且不重试", async () => {
  let calls = 0;
  const secret = "secret-provider-token";
  const diagnostics = { httpStatus: 429, retryAfterMs: 500, rawBody: secret };
  const error = new LlmError("RATE_LIMIT", diagnostics, { cause: new Error(secret) });
  error.message = secret;
  const adapter = createMockAdapter(() => {
    calls++;
    return [{ chunk: textChunk }, { error }, { chunk: stopChunk }];
  });
  const prepared = new LlmRuntime({ mock: adapter }).prepare(route);

  assert.deepEqual(await collect(prepared.generate(input, new AbortController().signal)), [
    textChunk,
    {
      type: "finish",
      reason: {
        kind: "error",
        failure: { code: "RATE_LIMIT", message: "Provider rate limit exceeded", httpStatus: 429, retryAfterMs: 500 },
      },
    },
  ]);
  assert.equal(calls, 1);
});

test("Adapter 自身抛出 ABORTED 时只交付取消终态", async () => {
  const adapter = createMockAdapter(() => [{ error: new LlmError("ABORTED") }]);
  const prepared = new LlmRuntime({ mock: adapter }).prepare(route);
  assert.deepEqual(await collect(prepared.generate(input, new AbortController().signal)), [
    { type: "finish", reason: { kind: "aborted" } },
  ]);
});

test("流缺少结束事件和未归类异常使用不同的安全错误代码", async () => {
  for (const [adapter, code] of [
    [createMockAdapter(() => [{ chunk: textChunk }]), "STREAM_CLOSED"],
    [createMockAdapter(() => { throw new Error("private transport details"); }), "UNKNOWN"],
  ] as const) {
    const prepared = new LlmRuntime({ mock: adapter }).prepare(route);
    const chunks = await collect(prepared.generate(input, new AbortController().signal));
    const terminal = chunks.at(-1);
    assert.equal(chunks.filter(({ type }) => type === "finish").length, 1);
    assert.ok(terminal?.type === "finish" && terminal.reason.kind === "error");
    assert.equal(terminal.reason.failure.code, code);
    assert.doesNotMatch(terminal.reason.failure.message, /private transport details/);
  }
});

test("请求等待和流空闲超时各自产生 TIMEOUT，并保留发生阶段", async () => {
  for (const timeoutPhase of ["request", "idle"] as const) {
    const prefix = timeoutPhase === "idle" ? [{ chunk: textChunk }] : [];
    const adapter = createMockAdapter(() => [...prefix, { chunk: stopChunk, delayMs: 1000 }]);
    const prepared = new LlmRuntime({ mock: adapter }).prepare({
      ...route,
      timeouts: { requestTimeoutMs: 5, idleTimeoutMs: 5 },
    });
    const signal = new AbortController().signal;
    assert.deepEqual(await collect(prepared.generate(input, signal)), [
      ...prefix.map(({ chunk }) => chunk),
      { type: "finish", reason: { kind: "error", failure: {
        code: "TIMEOUT", message: "Provider request timed out", timeoutPhase,
      } } },
    ]);
    assert.equal(getEventListeners(signal, "abort").length, 0);
  }
});

test("Turn 预算通过上游取消归因，中断模拟等待且不交付迟到输出", async () => {
  let calls = 0;
  const adapter = createMockAdapter(() => {
    calls++;
    return [{ chunk: textChunk, delayMs: 1000 }, { chunk: stopChunk }];
  });
  const prepared = new LlmRuntime({ mock: adapter }).prepare(route);
  const controller = new AbortController();
  const collecting = collect(prepared.generate(input, controller.signal));
  assert.equal(calls, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  const budgetReason = { code: "budget_exhausted" };
  controller.abort(budgetReason);

  const aborted = [{ type: "finish", reason: { kind: "aborted" } }];
  assert.deepEqual(await collecting, aborted);
  assert.equal(controller.signal.reason, budgetReason);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.deepEqual(await collect(prepared.generate(input, controller.signal)), aborted);
  assert.equal(calls, 1);
});

test("提前退出关闭 Adapter，正常 finish 交付前也关闭流且不读取后续分片", async () => {
  let closed = 0;
  const adapter: ModelAdapter = {
    async *generate() {
      try {
        yield textChunk;
        yield stopChunk;
        assert.fail("读取了 finish 后的分片");
      } finally {
        closed++;
      }
    },
  };
  const prepared = new LlmRuntime({ mock: adapter }).prepare(route);
  const signal = new AbortController().signal;
  for await (const chunk of prepared.generate(input, signal)) {
    assert.deepEqual(chunk, textChunk);
    break;
  }
  assert.equal(closed, 1);
  const chunks = [];
  for await (const chunk of prepared.generate(input, signal)) {
    if (chunk.type === "finish") assert.equal(closed, 2);
    chunks.push(chunk);
  }
  assert.deepEqual(chunks, [textChunk, stopChunk]);
});
