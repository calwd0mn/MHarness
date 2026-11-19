import assert from "node:assert/strict";
import { test } from "node:test";
import { LlmRuntime } from "../runtime.ts";
import { createDeepSeekAdapter } from "./deepseek.ts";
import type { ModelInput, StreamChunk } from "../adapter.ts";

const input: ModelInput = { systemPrompt: "系统", messages: [{ role: "user", text: "你好" }], tools: [] };

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test("DeepSeek 单次请求映射正文、用量及 DONE 后的结束边界", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const transport: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response('data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\r\n\r\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\r\n\r\n' +
      'data: [DONE]\r\n\r\n', { headers: { "content-type": "text/event-stream" } });
  };
  const prepared = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "fake-key", fetch: transport }) })
    .prepare({ provider: "deepseek", model: "deepseek-v4-pro" });
  const chunks = await collect(prepared.generate(input, new AbortController().signal));
  assert.deepEqual(chunks, [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "你好" },
    { type: "block-end", index: 0, block: { type: "text", text: "你好" } },
    { type: "usage", usage: { inputTokens: 3, outputTokens: 2 } },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://api.deepseek.com/chat/completions");
  assert.equal(new Headers(requests[0]?.init?.headers).get("authorization"), "Bearer fake-key");
  assert.equal(requests[0]?.init?.redirect, "error");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    model: "deepseek-v4-pro", stream: true, messages: [{ role: "system", content: "系统" }, { role: "user", content: "你好" }],
    thinking: { type: "disabled" },
  });
});

test("交错推理、正文和多工具按开启顺序关闭并在缺少结束原因时推断工具调用", async () => {
  const events = [
    { choices: [{ delta: { reasoning_content: "思" }, finish_reason: null }] },
    { choices: [{ delta: { content: "查" }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 2, id: "c2", function: { name: "lookup", arguments: "{" } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c0", function: { name: "read", arguments: "{}" } }, { index: 2, function: { arguments: "}" } }] }, finish_reason: null }] },
  ];
  const wire = ': keepalive\r\n\r\n' + events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(wire);
  const transport: typeof fetch = async () => new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close();
  } }));
  const stream = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "fake-key", fetch: transport }) })
    .prepare({ provider: "deepseek", model: "deepseek-v4-pro" }).generate(input, new AbortController().signal);
  assert.deepEqual(await collect(stream), [
    { type: "block-start", index: 0, blockType: "reasoning" }, { type: "reasoning-delta", index: 0, text: "思" },
    { type: "block-start", index: 1, blockType: "text" }, { type: "text-delta", index: 1, text: "查" },
    { type: "block-start", index: 2, blockType: "tool-call" }, { type: "tool-call-delta", index: 2, id: "c2", name: "lookup", argumentsDelta: "{" },
    { type: "block-start", index: 3, blockType: "tool-call" }, { type: "tool-call-delta", index: 3, id: "c0", name: "read", argumentsDelta: "{}" },
    { type: "tool-call-delta", index: 2, argumentsDelta: "}" },
    { type: "block-end", index: 0, block: { type: "reasoning", text: "思" } },
    { type: "block-end", index: 1, block: { type: "text", text: "查" } },
    { type: "block-end", index: 2, block: { type: "tool-call", id: "c2", name: "lookup", arguments: "{}" } },
    { type: "block-end", index: 3, block: { type: "tool-call", id: "c0", name: "read", arguments: "{}" } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ]);
});

test("结束原因到达后仍等待 DONE；提前断流只产生 STREAM_CLOSED", async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const transport: typeof fetch = async () => new Response(new ReadableStream({ start(value) { controller = value; } }));
  const prepared = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "fake-key", fetch: transport }) })
    .prepare({ provider: "deepseek", model: "deepseek-v4-pro" });
  let finished = false;
  const pending = collect(prepared.generate(input, new AbortController().signal)).then((chunks) => { finished = true; return chunks; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(controller);
  controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  controller.close();
  const chunks = await pending;
  assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "error", failure: { code: "STREAM_CLOSED", message: "Provider stream ended without a finish event" } } });
  assert.equal(chunks.some((chunk) => chunk.type === "block-end"), false);
});

test("推理模式请求携带历史推理、工具与生成配置", async () => {
  let body: unknown;
  const transport: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response('data: [DONE]\n\n');
  };
  const runtime = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "fake-key", fetch: transport }) });
  const prepared = runtime.prepare({ provider: "deepseek", model: "deepseek-v4-pro", params: {
    reasoningEffort: "high", maxOutputTokens: 50, stop: ["END"],
  } });
  await collect(prepared.generate({ systemPrompt: "系统", messages: [
    { role: "assistant", text: "查", reasoning: "想", toolCalls: [{ callId: "c", name: "read", arguments: "{}" }] },
    { role: "tool", callId: "c", text: "结果" },
  ], tools: [{ name: "read", description: "查询", inputSchema: { type: "object" } }] }, new AbortController().signal));
  assert.deepEqual(body, { model: "deepseek-v4-pro", stream: true, messages: [
    { role: "system", content: "系统" },
    { role: "assistant", content: "查", reasoning_content: "想", tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c", content: "结果" },
  ], tools: [{ type: "function", function: { name: "read", description: "查询", parameters: { type: "object" } } }],
  thinking: { type: "enabled" }, reasoning_effort: "high", max_tokens: 50, stop: ["END"] });
});

test("发网前拒绝 DeepSeek 不支持的采样、token 与停止序列", () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; throw new Error("不应发网"); };
  const runtime = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "fake-key", fetch: transport }) });
  const route = { provider: "deepseek", model: "deepseek-v4-pro" };
  assert.throws(() => runtime.prepare({ ...route, params: { reasoningEffort: "high", temperature: 1 } }));
  assert.throws(() => runtime.prepare({ ...route, params: { reasoningEffort: "low", topP: 0.9 } }));
  assert.throws(() => runtime.prepare({ ...route, params: { maxOutputTokens: 393217 } }));
  assert.throws(() => runtime.prepare({ ...route, params: { stop: Array.from({ length: 17 }, () => "x") } }));
  assert.throws(() => runtime.prepare({ ...route, params: { stop: ["中".repeat(171)] } }));
  assert.equal(calls, 0);
});

test("准备时绑定凭据和参数，下一次准备读取新配置", async () => {
  const requests: { authorization: string | null; body: unknown }[] = [];
  const transport: typeof fetch = async (_url, init) => {
    requests.push({ authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
    return new Response('data: [DONE]\n\n');
  };
  let key = "fake-first";
  const runtime = new LlmRuntime({ deepseek: () => createDeepSeekAdapter({ apiKey: key, fetch: transport }) });
  const config = { provider: "deepseek", model: "deepseek-v4-pro", params: { maxOutputTokens: 20 } };
  const first = runtime.prepare(config);
  key = "fake-second";
  config.params.maxOutputTokens = 30;
  await collect(first.generate(input, new AbortController().signal));
  await collect(runtime.prepare(config).generate(input, new AbortController().signal));
  assert.deepEqual(requests.map((entry) => entry.authorization), ["Bearer fake-first", "Bearer fake-second"]);
  assert.deepEqual(requests.map((entry) => (entry.body as { max_tokens: number }).max_tokens), [20, 30]);
});

test("显式结束原因优先，尾部用量覆盖此前用量", async () => {
  let body: unknown;
  const transport: typeof fetch = async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response([
    'data: {"choices":[{"delta":{"content":"部分"},"finish_reason":"length"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
    'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":7}}',
    'data: [DONE]', '',
  ].join('\n\n')); };
  const prepared = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "fake-key", fetch: transport }) })
    .prepare({ provider: "deepseek", model: "deepseek-v4-pro", params: { temperature: 0.4, topP: 0.8 } });
  const chunks = await collect(prepared.generate(input, new AbortController().signal));
  assert.equal((body as { top_p: number }).top_p, 0.8);
  assert.equal((body as { temperature: number }).temperature, 0.4);
  assert.deepEqual(chunks.slice(-2), [
    { type: "usage", usage: { inputTokens: 4, outputTokens: 7 } },
    { type: "finish", reason: { kind: "max-tokens" } },
  ]);
});

test("工具缺少参数字段时不推断完整调用", async () => {
  const transport: typeof fetch = async () => new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"read"}}]}}]}\n\ndata: [DONE]\n\n');
  const prepared = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "fake-key", fetch: transport }) })
    .prepare({ provider: "deepseek", model: "deepseek-v4-pro" });
  const chunks = await collect(prepared.generate(input, new AbortController().signal));
  assert.equal(chunks.some((chunk) => chunk.type === "block-end"), false);
  assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "stop" } });
});

test("读取流期间更换凭据与参数仅影响下一次请求", async () => {
  const sent: { auth: string | null; body: unknown }[] = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const transport: typeof fetch = async (_url, init) => {
    sent.push({ auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
    if (sent.length === 1) return new Response(new ReadableStream({ start(controller) { streamController = controller; } }));
    return new Response('data: [DONE]\n\n');
  };
  let key = "fake-old";
  let maxTokens = 10;
  const runtime = new LlmRuntime({ deepseek: () => createDeepSeekAdapter({ apiKey: key, fetch: transport }) });
  const prepare = () => runtime.prepare({ provider: "deepseek", model: "deepseek-v4-pro", params: { maxOutputTokens: maxTokens } });
  const first = collect(prepare().generate(input, new AbortController().signal));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(streamController);
  streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"旧"}}]}\n\n'));
  key = "fake-new"; maxTokens = 20;
  streamController.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
  streamController.close();
  await first;
  await collect(prepare().generate(input, new AbortController().signal));
  assert.deepEqual(sent.map((request) => request.auth), ["Bearer fake-old", "Bearer fake-new"]);
  assert.deepEqual(sent.map((request) => (request.body as { max_tokens: number }).max_tokens), [10, 20]);
});

test("不支持的显式结束原因等待 DONE 后安全失败，缺少 DONE 仍是断流", async () => {
  for (const reason of ["content_filter", "insufficient_system_resource", "aborted", "future_reason"]) {
    for (const done of [true, false]) {
      const response = `data: ${JSON.stringify({ choices: [{ delta: { content: "部分" }, finish_reason: reason }] })}\n\n${done ? "data: [DONE]\n\n" : ""}`;
      const transport: typeof fetch = async () => new Response(response);
      const prepared = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "fake-key", fetch: transport }) })
        .prepare({ provider: "deepseek", model: "deepseek-v4-pro" });
      const chunks = await collect(prepared.generate(input, new AbortController().signal));
      const code = done ? "PROTOCOL" : "STREAM_CLOSED";
      const message = done ? "Provider stream violated the expected protocol" : "Provider stream ended without a finish event";
      assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "error", failure: { code, message } } }, `${reason}, done=${done}`);
    }
  }
});

test("真实请求与计量共享推理可见性和结构化工具结果", async () => {
  const { Session } = await import("@mharness/session/server");
  const { createRequestPreparer, rebuildRequestContext } = await import("../../agent/request-context.ts");
  const { estimateSurfaceMessageTokens } = await import("../token-meter.ts");
  for (const [effort, withTools, expected, reasoning] of [["high", true, 30, true], ["none", true, 20, false], ["high", false, 20, false]] as const) {
    let body = "";
    const transport: typeof fetch = async (_url, init) => { body = String(init?.body); return new Response('data: [DONE]\n\n'); };
    const runtime = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "fake", fetch: transport }) });
    const session = new Session({ sessionId: "projection", createdAt: 1 });
    session.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "a", role: "assistant", source: { provider: "deepseek", model: "m" }, content: [{ type: "text", text: "A" }, { type: "text", text: "B" }, { type: "reasoning", text: "想😀" }, { type: "reasoning", text: "继续🤖" }, { type: "tool-call", id: "c", name: "read", arguments: "{}" }] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true } });
    session.append({ type: "tool/result", surfaceOp: "append", sourceEventSeqs: [0], data: { turn: 1, step: 1, message: { id: "r", role: "user", source: { kind: "tool", callId: "c" }, content: [{ type: "tool-result", toolCallId: "c", isError: false, content: [{ type: "future", value: 1 }, { type: "text", text: "ok" }] }] } } });
    const tools = withTools ? [{ name: "read", inputSchema: {} }] : [];
    const { prepared, input } = createRequestPreparer({ runtime, config: () => ({ provider: "deepseek", model: "m", params: { reasoningEffort: effort } }), systemPrompt: () => "sys", tools: () => tools })(session);
    const first = session.deriveMessages()[0]; assert.ok(first);
    assert.equal(estimateSurfaceMessageTokens(prepared, first, tools), expected);
    assert.deepEqual(rebuildRequestContext(session).input, input);
    await collect(prepared.generate(input, new AbortController().signal));
    const wire = JSON.parse(body) as { messages: { reasoning_content?: string; content: string }[] };
    assert.equal(wire.messages[1]?.reasoning_content, reasoning ? "想😀继续🤖" : undefined);
    assert.equal(wire.messages[2]?.content, JSON.stringify([{ type: "future", value: 1 }, { type: "text", text: "ok" }]));
  }
});

test("生成默认上限优先于计量预留且与 wire、请求头一致", async () => {
  const { Session } = await import("@mharness/session/server");
  const { createRequestPreparer, foldRequestHeader } = await import("../../agent/request-context.ts");
  const { measureRequestPressure } = await import("../token-meter.ts");
  for (const defaultMaxTokens of [512, undefined]) {
    let body = "";
    const adapter = createDeepSeekAdapter({ apiKey: "fake", fetch: async (_url, init) => { body = String(init?.body); return new Response('data: [DONE]\n\n'); } });
    const runtime = new LlmRuntime({ deepseek: { ...adapter, modelInfo: { ...adapter.modelInfo, ...(defaultMaxTokens === undefined ? {} : { defaultMaxTokens }) }, modelBudgets: { m: { contextWindow: 100000, defaultOutputTokens: 2000 } } } });
    const session = new Session({ sessionId: "defaults", createdAt: 1 });
    session.append({ type: "user/message", surfaceOp: "append", data: { id: "u", role: "user", source: { kind: "user" }, turn: 1, requestId: "r", content: [{ type: "text", text: "abcd" }] } });
    const { prepared, input } = createRequestPreparer({ runtime, config: () => ({ provider: "deepseek", model: "m" }), systemPrompt: () => "sys" })(session);
    const measured = measureRequestPressure(prepared, { systemPrompt: "sys", tools: [], messages: session.deriveMessages() });
    assert.equal(measured.status === "measured" && measured.inputTokens, 14);
    assert.equal(measured.status === "measured" && measured.pressure, defaultMaxTokens === undefined ? 2014 : 526);
    await collect(prepared.generate(input, new AbortController().signal));
    const wire = JSON.parse(body) as { max_tokens?: number };
    const header = foldRequestHeader(session.snapshot().events); assert.ok(header);
    assert.equal(wire.max_tokens, defaultMaxTokens); assert.equal(header.config.maxTokens, defaultMaxTokens);
    assert.equal(header.adapterDefaults?.maxTokens, defaultMaxTokens);
  }
});

test("真实空推理块与缺省推理均发送空串但只为空块计费", async () => {
  const { Session } = await import("@mharness/session/server");
  const { createRequestPreparer } = await import("../../agent/request-context.ts");
  const { estimateSurfaceMessageTokens } = await import("../token-meter.ts");
  const wireMessages: unknown[] = [];
  const runtime = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "fake", fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: unknown[] }; wireMessages.push(body.messages[1]);
    return new Response('data: [DONE]\n\n');
  } }) });
  const tools = [{ name: "read", inputSchema: {} }];
  const costs: number[] = [];
  for (const hasEmptyReasoning of [false, true]) {
    const session = new Session({ sessionId: "empty-reasoning", createdAt: 1 });
    session.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "a", role: "assistant", source: { provider: "deepseek", model: "m" }, content: hasEmptyReasoning ? [{ type: "reasoning", text: "" }] : [] }, finishReason: { kind: "stop" }, stream: [], includeInModelContext: true } });
    const { prepared, input } = createRequestPreparer({ runtime, config: () => ({ provider: "deepseek", model: "m", params: { reasoningEffort: "high" } }), systemPrompt: () => "sys", tools: () => tools })(session);
    costs.push(estimateSurfaceMessageTokens(prepared, session.deriveMessages()[0]!, tools));
    await collect(prepared.generate(input, new AbortController().signal));
  }
  assert.deepEqual(wireMessages, [{ role: "assistant", content: "", reasoning_content: "" }, { role: "assistant", content: "", reasoning_content: "" }]);
  assert.deepEqual(costs, [4, 8]);
});
