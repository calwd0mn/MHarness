import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { LlmRuntime } from "../runtime.ts";
import { createDeepSeekAdapter } from "./deepseek.ts";
import type { StreamChunk } from "../adapter.ts";

test("HTTP 401 归 AUTH 且每次生成只发送一次", async () => {
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: "private-fake-key" } }), { status: 401 });
  };
  const prepared = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "private-fake-key", fetch: transport }) })
    .prepare({ provider: "deepseek", model: "deepseek-v4-pro" });
  const chunks: StreamChunk[] = [];
  for await (const chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, new AbortController().signal)) chunks.push(chunk);
  assert.deepEqual(chunks, [{ type: "finish", reason: { kind: "error", failure: {
    code: "AUTH", message: "Provider authentication failed", httpStatus: 401,
  } } }]);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(chunks), /private-fake-key/);
});

async function finishFor(response: Response): Promise<StreamChunk[]> {
  let calls = 0;
  const adapter = createDeepSeekAdapter({ apiKey: "secret", fetch: async () => { calls++; return response; } });
  const prepared = new LlmRuntime({ deepseek: adapter }).prepare({ provider: "deepseek", model: "deepseek-v4-pro" });
  const chunks: StreamChunk[] = [];
  for await (const chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, new AbortController().signal)) chunks.push(chunk);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(chunks), /secret/);
  return chunks;
}

test("HTTP 错误和明确输入超限使用稳定类别", async () => {
  for (const [status, body, code, extra] of [
    [403, {}, "AUTH", {}],
    [429, {}, "RATE_LIMIT", { retryAfterMs: 2000 }],
    [500, {}, "TRANSPORT", {}],
    [413, {}, "TRANSPORT", {}],
    [400, { error: { code: "quota_limit_reached", message: "secret" } }, "TRANSPORT", {}],
    [400, { error: { code: "context_length_exceeded" } }, "CONTEXT_WINDOW_EXCEEDED", {}],
    [422, { type: "context_window_exceeded" }, "CONTEXT_WINDOW_EXCEEDED", {}],
    [400, { error: { message: "Input token exceed the limit" } }, "CONTEXT_WINDOW_EXCEEDED", {}],
  ] as const) {
    const chunks = await finishFor(new Response(JSON.stringify(body), { status, headers: status === 429 ? { "retry-after": "2" } : {} }));
    assert.equal(chunks.length, 1);
    const chunk = chunks[0];
    assert.equal(chunk?.type, "finish");
    if (chunk?.type !== "finish" || chunk.reason.kind !== "error") throw new Error("expected error");
    assert.deepEqual({ code: chunk.reason.failure.code, httpStatus: chunk.reason.failure.httpStatus, ...(chunk.reason.failure.retryAfterMs === undefined ? {} : { retryAfterMs: chunk.reason.failure.retryAfterMs }) }, { code, httpStatus: status, ...extra });
  }
});

test("挂起的请求按 request 超时并中止实际信号", async (context) => {
  const realSetTimeout = setTimeout;
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let actualSignal: AbortSignal | null = null;
  let started!: () => void;
  const barrier = new Promise<void>((resolve) => { started = resolve; });
  const adapter = createDeepSeekAdapter({ apiKey: "secret", fetch: async (_url, init) => {
    actualSignal = init?.signal as AbortSignal;
    started();
    return new Promise<Response>(() => {});
  } });
  const prepared = new LlmRuntime({ deepseek: adapter }).prepare({ provider: "deepseek", model: "deepseek-v4-pro", timeouts: { requestTimeoutMs: 100, idleTimeoutMs: 50 } });
  const result = (async () => { const chunks: StreamChunk[] = []; for await (const chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, new AbortController().signal)) chunks.push(chunk); return chunks; })();
  await barrier;
  context.mock.timers.tick(100);
  const chunks = await Promise.race([result, new Promise<never>((_resolve, reject) => realSetTimeout(() => reject(new Error("请求超时未终结")), 200))]);
  assert.deepEqual(chunks, [{ type: "finish", reason: { kind: "error", failure: { code: "TIMEOUT", message: "Provider request timed out", timeoutPhase: "request" } } }]);
  assert.equal((actualSignal as AbortSignal | null)?.aborted, true);
});

test("读流等待期间取消释放 reader 并停止输出", async () => {
  let canceled = 0;
  let started!: () => void;
  const barrier = new Promise<void>((resolve) => { started = resolve; });
  const body = new ReadableStream<Uint8Array>({ pull() { started(); }, cancel() { canceled++; } });
  const controller = new AbortController();
  const adapter = createDeepSeekAdapter({ apiKey: "secret", fetch: async () => new Response(body) });
  const prepared = new LlmRuntime({ deepseek: adapter }).prepare({ provider: "deepseek", model: "deepseek-v4-pro" });
  const result = (async () => { const chunks: StreamChunk[] = []; for await (const chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, controller.signal)) chunks.push(chunk); return chunks; })();
  await barrier;
  controller.abort();
  assert.deepEqual(await result, [{ type: "finish", reason: { kind: "aborted" } }]);
  assert.equal(canceled, 1);
  assert.equal(body.locked, false);
});

test("收到同包 block-start 后取消不再输出缓冲内容", async () => {
  let canceled = 0;
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"secret"}}]}\n\ndata: [DONE]\n\n');
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); }, cancel() { canceled++; } });
  const controller = new AbortController();
  const adapter = createDeepSeekAdapter({ apiKey: "secret", fetch: async () => new Response(body) });
  const prepared = new LlmRuntime({ deepseek: adapter }).prepare({ provider: "deepseek", model: "deepseek-v4-pro" });
  const chunks: StreamChunk[] = [];
  for await (const chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, controller.signal)) { chunks.push(chunk); if (chunk.type === "block-start") controller.abort(); }
  assert.deepEqual(chunks, [{ type: "block-start", index: 0, blockType: "text" }, { type: "finish", reason: { kind: "aborted" } }]);
  assert.equal(canceled, 1);
  assert.equal(body.locked, false);
});

test("提前退出释放流和上游监听器", async () => {
  let canceled = 0;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n')); }, cancel() { canceled++; } });
  const upstream = new AbortController();
  let actualSignal: AbortSignal | null = null;
  const baseline = getEventListeners(upstream.signal, "abort").length;
  const adapter = createDeepSeekAdapter({ apiKey: "secret", fetch: async (_url, init) => { actualSignal = init?.signal as AbortSignal; return new Response(body); } });
  const prepared = new LlmRuntime({ deepseek: adapter }).prepare({ provider: "deepseek", model: "deepseek-v4-pro" });
  for await (const _chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, upstream.signal)) break;
  assert.equal(canceled, 1);
  assert.equal(body.locked, false);
  assert.equal((actualSignal as AbortSignal | null)?.aborted, true);
  assert.equal(getEventListeners(upstream.signal, "abort").length, baseline);
});

test("取消发生在 block-end 后时不再交付后续块", async () => {
  const payload = 'data: {"choices":[{"delta":{"reasoning_content":"r","content":"t"}}]}\n\ndata: [DONE]\n\n';
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(payload)); } });
  const controller = new AbortController();
  const prepared = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "secret", fetch: async () => new Response(body) }) }).prepare({ provider: "deepseek", model: "deepseek-v4-pro" });
  const chunks: StreamChunk[] = [];
  for await (const chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, controller.signal)) { chunks.push(chunk); if (chunk.type === "block-end") controller.abort(); }
  assert.equal(chunks.filter((chunk) => chunk.type === "block-end").length, 1);
  assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "aborted" } });
});

test("Adapter 在 block-end 后取消时不交付下个块", async () => {
  const payload = 'data: {"choices":[{"delta":{"reasoning_content":"r","content":"t"}}]}\n\ndata: [DONE]\n\n';
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(payload)); } });
  const controller = new AbortController();
  const adapter = createDeepSeekAdapter({ apiKey: "secret", fetch: async () => new Response(body) });
  const chunks: StreamChunk[] = [];
  await assert.rejects(async () => {
    for await (const chunk of adapter.generate({ systemPrompt: "", messages: [], tools: [], route: { provider: "deepseek", model: "test" }, effectiveParams: {}, timeouts: { requestTimeoutMs: 100, idleTimeoutMs: 50 } }, controller.signal)) { chunks.push(chunk); if (chunk.type === "block-end") controller.abort(); }
  }, { code: "ABORTED" });
  assert.equal(chunks.filter((chunk) => chunk.type === "block-end").length, 1);
});

test("注释和不完整数据不能延长首事件预算", async (context) => {
  const realSetTimeout = setTimeout;
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let pulls = 0;
  let notify!: () => void;
  const pullBarrier = () => new Promise<void>((resolve) => { notify = resolve; });
  let nextPull = pullBarrier();
  const body = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; }, pull() { pulls++; notify(); } });
  const adapter = createDeepSeekAdapter({ apiKey: "secret", fetch: async () => new Response(body) });
  const prepared = new LlmRuntime({ deepseek: adapter }).prepare({ provider: "deepseek", model: "test", timeouts: { requestTimeoutMs: 100, idleTimeoutMs: 50 } });
  const result = (async () => { const chunks: StreamChunk[] = []; for await (const chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, new AbortController().signal)) chunks.push(chunk); return chunks; })();
  await nextPull;
  context.mock.timers.tick(60);
  nextPull = pullBarrier();
  streamController.enqueue(new TextEncoder().encode(': keepalive\n\ndata: {'));
  await nextPull;
  assert.ok(pulls >= 2);
  context.mock.timers.tick(40);
  const chunks = await Promise.race([result, new Promise<never>((_resolve, reject) => realSetTimeout(() => reject(new Error("首事件超时未终结")), 200))]);
  assert.deepEqual(chunks, [{ type: "finish", reason: { kind: "error", failure: { code: "TIMEOUT", message: "Provider request timed out", timeoutPhase: "request" } } }]);
  assert.equal(body.locked, false);
});

test("有效事件后等待按 idle 预算超时", async (context) => {
  const realSetTimeout = setTimeout;
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let notify!: () => void;
  let pulls = 0;
  const barrier = new Promise<void>((resolve) => { notify = resolve; });
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{}}]}\n\n')); }, pull() { if (++pulls >= 2) notify(); } });
  const adapter = createDeepSeekAdapter({ apiKey: "secret", fetch: async () => new Response(body) });
  const prepared = new LlmRuntime({ deepseek: adapter }).prepare({ provider: "deepseek", model: "test", timeouts: { requestTimeoutMs: 100, idleTimeoutMs: 50 } });
  const result = (async () => { const chunks: StreamChunk[] = []; for await (const chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, new AbortController().signal)) chunks.push(chunk); return chunks; })();
  await barrier;
  context.mock.timers.tick(50);
  const chunks = await Promise.race([result, new Promise<never>((_resolve, reject) => realSetTimeout(() => reject(new Error("idle 超时未终结")), 200))]);
  assert.deepEqual(chunks, [{ type: "finish", reason: { kind: "error", failure: { code: "TIMEOUT", message: "Provider request timed out", timeoutPhase: "idle" } } }]);
});

test("错误响应正文超时时取消底层流并释放锁", async (context) => {
  const realSetTimeout = setTimeout;
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let notify!: () => void;
  const barrier = new Promise<void>((resolve) => { notify = resolve; });
  let canceled = 0;
  const body = new ReadableStream<Uint8Array>({ pull() { notify(); }, cancel() { canceled++; } }, { highWaterMark: 0 });
  const adapter = createDeepSeekAdapter({ apiKey: "secret", fetch: async () => new Response(body, { status: 400 }) });
  const prepared = new LlmRuntime({ deepseek: adapter }).prepare({ provider: "deepseek", model: "test", timeouts: { requestTimeoutMs: 100, idleTimeoutMs: 50 } });
  const result = (async () => { const chunks: StreamChunk[] = []; for await (const chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, new AbortController().signal)) chunks.push(chunk); return chunks; })();
  await barrier;
  context.mock.timers.tick(100);
  const chunks = await Promise.race([result, new Promise<never>((_resolve, reject) => realSetTimeout(() => reject(new Error("错误正文超时未终结")), 200))]);
  assert.deepEqual(chunks, [{ type: "finish", reason: { kind: "error", failure: { code: "TIMEOUT", message: "Provider request timed out", timeoutPhase: "request" } } }]);
  assert.equal(canceled, 1);
  assert.equal(body.locked, false);
});

test("取消挂起 fetch 后迟到响应的正文被取消", async () => {
  let deliver!: (response: Response) => void;
  let started!: () => void;
  const barrier = new Promise<void>((resolve) => { started = resolve; });
  const deferred = new Promise<Response>((resolve) => { deliver = resolve; });
  let canceled = 0;
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled++; } });
  const upstream = new AbortController();
  const adapter = createDeepSeekAdapter({ apiKey: "secret", fetch: async () => { started(); return deferred; } });
  const prepared = new LlmRuntime({ deepseek: adapter }).prepare({ provider: "deepseek", model: "test" });
  const result = (async () => { const chunks: StreamChunk[] = []; for await (const chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, upstream.signal)) chunks.push(chunk); return chunks; })();
  await barrier;
  upstream.abort();
  assert.deepEqual(await result, [{ type: "finish", reason: { kind: "aborted" } }]);
  deliver(new Response(body));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(canceled, 1);
  assert.equal(body.locked, false);
});

test("传输与协议错误不泄露原始信息", async () => {
  const cases: [typeof fetch, string][] = [
    [async () => { throw new Error("secret"); }, "TRANSPORT"],
    [async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("secret")); } })), "TRANSPORT"],
    [async () => new Response('data: {bad}\n\n'), "PROTOCOL"],
    [async () => new Response('data: {"choices":"bad"}\n\n'), "PROTOCOL"],
    [async () => new Response('data: {"choices":[]}\n\n'), "STREAM_CLOSED"],
    [async () => new Response(null), "STREAM_CLOSED"],
  ];
  for (const [transport, expected] of cases) {
    let calls = 0;
    const adapter = createDeepSeekAdapter({ apiKey: "secret", fetch: (...args) => { calls++; return transport(...args); } });
    const prepared = new LlmRuntime({ deepseek: adapter }).prepare({ provider: "deepseek", model: "test" });
    const chunks: StreamChunk[] = [];
    for await (const chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, new AbortController().signal)) chunks.push(chunk);
    assert.equal(calls, 1);
    assert.equal(chunks.length, 1);
    const chunk = chunks[0];
    assert.equal(chunk?.type, "finish");
    if (chunk?.type !== "finish" || chunk.reason.kind !== "error") throw new Error("expected error");
    assert.equal(chunk.reason.failure.code, expected);
    assert.doesNotMatch(JSON.stringify(chunks), /secret/);
  }
});

test("鉴权错误响应的取消回调挂起时调用方取消仍可结束", async () => {
  let notify!: () => void;
  const barrier = new Promise<void>((resolve) => { notify = resolve; });
  const body = new ReadableStream<Uint8Array>({ cancel() { notify(); return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
  const upstream = new AbortController();
  const prepared = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "secret", fetch: async () => new Response(body, { status: 401 }) }) }).prepare({ provider: "deepseek", model: "test" });
  const result = (async () => { const chunks: StreamChunk[] = []; for await (const chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, upstream.signal)) chunks.push(chunk); return chunks; })();
  await barrier;
  upstream.abort();
  const chunks = await Promise.race([result, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("鉴权响应清理挂起")), 200))]);
  assert.deepEqual(chunks, [{ type: "finish", reason: { kind: "aborted" } }]);
});

test("预取消不调用 transport；迟到拒绝不会成为未处理异常", async () => {
  let calls = 0;
  let rejectFetch!: (reason: Error) => void;
  let started!: () => void;
  const barrier = new Promise<void>((resolve) => { started = resolve; });
  const pending = new Promise<Response>((_resolve, reject) => { rejectFetch = reject; });
  const prepared = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "secret", fetch: async () => { calls++; started(); return pending; } }) }).prepare({ provider: "deepseek", model: "test" });
  const before = new AbortController(); before.abort();
  const preChunks: StreamChunk[] = [];
  for await (const chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, before.signal)) preChunks.push(chunk);
  assert.equal(calls, 0);
  assert.deepEqual(preChunks, [{ type: "finish", reason: { kind: "aborted" } }]);
  const upstream = new AbortController();
  const result = (async () => { const chunks: StreamChunk[] = []; for await (const chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, upstream.signal)) chunks.push(chunk); return chunks; })();
  await barrier;
  upstream.abort();
  assert.deepEqual(await result, [{ type: "finish", reason: { kind: "aborted" } }]);
  rejectFetch(new Error("late secret"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

test("下游暂停期间不消耗 idle 预算", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')); } });
  const prepared = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "secret", fetch: async () => new Response(body) }) }).prepare({ provider: "deepseek", model: "test", timeouts: { requestTimeoutMs: 100, idleTimeoutMs: 50 } });
  const iterator = prepared.generate({ systemPrompt: "", messages: [], tools: [] }, new AbortController().signal)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "block-start");
  context.mock.timers.tick(1000);
  assert.equal((await iterator.next()).value?.type, "text-delta");
  streamController.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
  const rest: StreamChunk[] = [];
  for (;;) { const next = await iterator.next(); if (next.done) break; rest.push(next.value); }
  assert.equal(rest.at(-1)?.type, "finish");
  const finish = rest.at(-1);
  assert.ok(finish?.type === "finish" && finish.reason.kind === "stop");
});

test("Retry-After 日期及无效值只保留安全诊断", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T00:00:00Z") });
  for (const [header, expected] of [["Thu, 01 Jan 2026 00:00:03 GMT", 3000], ["Thursday, 01-Jan-26 00:00:03 GMT", 3000], ["Saturday, 01-Jan-50 00:00:00 GMT", 757382400000], ["Thu Jan  1 00:00:03 2026", 3000], ["invalid", undefined], ["2027-01-01", undefined], ["-1", undefined], ["999999999999999999999", undefined]] as const) {
    const chunks = await finishFor(new Response(null, { status: 429, headers: { "retry-after": header } }));
    const chunk = chunks[0];
    if (chunk?.type !== "finish" || chunk.reason.kind !== "error") throw new Error("expected error");
    assert.equal(chunk.reason.failure.retryAfterMs, expected);
  }
});

test("余额、含糊 token 文本和输出截断不视为输入超限", async () => {
  for (const body of [{ error: { code: "quota_limit_reached", message: "Insufficient balance" } }, { message: "token length limit" }, { message: "maximum output length exceeded" }]) {
    const chunks = await finishFor(new Response(JSON.stringify(body), { status: 400 }));
    const chunk = chunks[0];
    if (chunk?.type !== "finish" || chunk.reason.kind !== "error") throw new Error("expected error");
    assert.equal(chunk.reason.failure.code, "TRANSPORT");
  }
  const chunks = await finishFor(new Response('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'));
  assert.deepEqual(chunks, [{ type: "finish", reason: { kind: "max-tokens" } }]);
});

test("多行 maximum context length 明确请求超限被识别", async () => {
  const chunks = await finishFor(new Response(JSON.stringify({ error: { message: "This model's maximum context length is 100 tokens.\nHowever, you requested 120 tokens." } }), { status: 400 }));
  const chunk = chunks[0];
  if (chunk?.type !== "finish" || chunk.reason.kind !== "error") throw new Error("expected error");
  assert.equal(chunk.reason.failure.code, "CONTEXT_WINDOW_EXCEEDED");
});

test("idle 阶段的注释和拆包累计同一预算", async (context) => {
  const realSetTimeout = setTimeout;
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let notify!: () => void;
  const nextRead = () => new Promise<void>((resolve) => { notify = resolve; });
  let barrier = nextRead();
  const body = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; }, pull() { notify(); } }, { highWaterMark: 0 });
  const prepared = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "secret", fetch: async () => new Response(body) }) }).prepare({ provider: "deepseek", model: "test", timeouts: { requestTimeoutMs: 100, idleTimeoutMs: 50 } });
  const result = (async () => { const chunks: StreamChunk[] = []; for await (const chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, new AbortController().signal)) chunks.push(chunk); return chunks; })();
  await barrier;
  barrier = nextRead();
  streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{}}]}\n\n'));
  await barrier;
  context.mock.timers.tick(30);
  barrier = nextRead();
  streamController.enqueue(new TextEncoder().encode(': keepalive\n\ndata: {'));
  await barrier;
  context.mock.timers.tick(20);
  const chunks = await Promise.race([result, new Promise<never>((_resolve, reject) => realSetTimeout(() => reject(new Error("idle 累计预算未终结")), 200))]);
  assert.deepEqual(chunks, [{ type: "finish", reason: { kind: "error", failure: { code: "TIMEOUT", message: "Provider request timed out", timeoutPhase: "idle" } } }]);
});

test("transport 同步触发上游取消后返回的响应仍被回收", async () => {
  const upstream = new AbortController();
  let canceled = 0;
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled++; } });
  const prepared = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "secret", fetch: async () => { upstream.abort(); return new Response(body); } }) }).prepare({ provider: "deepseek", model: "test" });
  const chunks: StreamChunk[] = [];
  for await (const chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, upstream.signal)) chunks.push(chunk);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(chunks, [{ type: "finish", reason: { kind: "aborted" } }]);
  assert.equal(canceled, 1);
});

test("transport 同步触发取消后拒绝不会产生未处理拒绝", async () => {
  const { execFile } = await import("node:child_process");
  const script = `
    import { LlmRuntime } from './src/model/runtime.ts';
    import { createDeepSeekAdapter } from './src/model/providers/deepseek.ts';
    let unhandled = false;
    process.on('unhandledRejection', () => { unhandled = true; });
    const upstream = new AbortController();
    const adapter = createDeepSeekAdapter({ apiKey: 'secret', fetch: async () => { upstream.abort(); throw new Error('private'); } });
    const prepared = new LlmRuntime({ deepseek: adapter }).prepare({ provider: 'deepseek', model: 'test' });
    for await (const chunk of prepared.generate({ systemPrompt: '', messages: [], tools: [] }, upstream.signal)) {
      if (chunk.type !== 'finish' || chunk.reason.kind !== 'aborted') process.exitCode = 2;
    }
    await new Promise((resolve) => setImmediate(resolve));
    if (unhandled) process.exitCode = 3;
  `;
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 3000 }, (error, _stdout, stderr) => resolve({ code: error && "code" in error && typeof error.code === "number" ? error.code : error ? -1 : 0, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
});

test("空结构事件不能刷新首事件超时预算", async (context) => {
  const realSetTimeout = setTimeout;
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const payload of ["{}", '{"choices":[]}']) {
    let notify!: () => void;
    const barrier = new Promise<void>((resolve) => { notify = resolve; });
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { if (++pulls === 1) controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`)); else notify(); } }, { highWaterMark: 0 });
    const prepared = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "secret", fetch: async () => new Response(body) }) }).prepare({ provider: "deepseek", model: "test", timeouts: { requestTimeoutMs: 100, idleTimeoutMs: 50 } });
    const result = (async () => { const chunks: StreamChunk[] = []; for await (const chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, new AbortController().signal)) chunks.push(chunk); return chunks; })();
    await barrier;
    context.mock.timers.tick(100);
    const chunks = await Promise.race([result, new Promise<never>((_resolve, reject) => realSetTimeout(() => reject(new Error("空结构超时未终结")), 200))]);
    assert.deepEqual(chunks, [{ type: "finish", reason: { kind: "error", failure: { code: "TIMEOUT", message: "Provider request timed out", timeoutPhase: "request" } } }]);
  }
});
for (const mode of ["request", "idle", "error-body"] as const) {
  test(`超时中止触发同步拒绝保留 TIMEOUT：${mode}`, async (context) => {
    const realSetTimeout = setTimeout;
    context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let started!: () => void;
    const barrier = new Promise<void>((resolve) => { started = resolve; });
    const transport: typeof fetch = (_url, init) => {
      const actualSignal = init?.signal as AbortSignal;
      if (mode === "request") return new Promise<Response>((_resolve, reject) => { actualSignal.addEventListener("abort", () => reject(new Error("private"))); started(); });
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { actualSignal.addEventListener("abort", () => controller.error(new Error("private"))); },
        pull(controller) {
          if (mode === "idle" && ++pulls === 1) controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{}}]}\n\n'));
          else started();
        },
      }, { highWaterMark: 0 });
      return Promise.resolve(new Response(body, { status: mode === "error-body" ? 400 : 200 }));
    };
    const prepared = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "secret", fetch: transport }) }).prepare({ provider: "deepseek", model: "test", timeouts: { requestTimeoutMs: 100, idleTimeoutMs: 50 } });
    const result = (async () => { const chunks: StreamChunk[] = []; for await (const chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, new AbortController().signal)) chunks.push(chunk); return chunks; })();
    await barrier;
    context.mock.timers.tick(mode === "idle" ? 50 : 100);
    const chunks = await Promise.race([result, new Promise<never>((_resolve, reject) => realSetTimeout(() => reject(new Error("同步拒绝未终结")), 200))]);
    assert.deepEqual(chunks, [{ type: "finish", reason: { kind: "error", failure: { code: "TIMEOUT", message: "Provider request timed out", timeoutPhase: mode === "idle" ? "idle" : "request" } } }], mode);
    assert.doesNotMatch(JSON.stringify(chunks), /private/);
  });
}
