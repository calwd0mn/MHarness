import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { Session } from "@mharness/session/server";
import { createModelTurnDriver } from "./model-turn.ts";
import { createDeepSeekAdapter } from "../model/providers/deepseek.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { ToolRegistry, defineLocalTool } from "../tools/registry.ts";
import { defineLocalToolOutput } from "../tools/result.ts";

const tool = { index: 0, id: "c", function: { name: "read", arguments: "{}" } };
function wire(delta: object, reason?: string, done = true): string {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: reason ?? null }] })}\n\n${done ? "data: [DONE]\n\n" : ""}`;
}

test("DeepSeek 异常结束或截断均不派发工具", async () => {
  const cases = [
    { name: "空 stop", data: wire({}, "stop"), outcome: "failed", code: "EMPTY_RESPONSE" },
    { name: "stop 携带工具", data: wire({ tool_calls: [tool] }, "stop"), outcome: "failed", code: "PROTOCOL" },
    { name: "tool-calls 无工具", data: wire({}, "tool_calls"), outcome: "failed", code: "PROTOCOL" },
    { name: "工具缺少参数", data: wire({ tool_calls: [{ index: 0, id: "c", function: { name: "read" } }] }, "tool_calls"), outcome: "failed", code: "PROTOCOL" },
    { name: "工具截断", data: wire({ tool_calls: [tool], content: "部分" }, "length"), outcome: "truncated", code: "output_limit" },
    ...["content_filter", "insufficient_system_resource", "aborted", "future_reason"].flatMap((reason) => [
      { name: `${reason} 完整工具`, data: wire({ tool_calls: [tool] }, reason), outcome: "failed", code: "PROTOCOL" },
      { name: `${reason} 断流`, data: wire({ tool_calls: [tool] }, reason, false), outcome: "failed", code: "STREAM_CLOSED" },
    ]),
    { name: "结束原因后断流", data: wire({ tool_calls: [tool] }, "tool_calls", false), outcome: "failed", code: "STREAM_CLOSED" },
  ];
  for (const scenario of cases) {
    const session = new Session({ sessionId: scenario.name, createdAt: 0 });
    session.bindCheckpoint(async () => {});
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(defineLocalTool({ name: "read", version: "1", description: "read", input: z.strictObject({}), timeoutMs: 1000,
      sideEffect: "read-only", output: defineLocalToolOutput({ schema: z.string(), render: (_args, value) => [{ type: "text", text: value }] }),
      handler: () => { executions++; return "ok"; } }));
    const transport: typeof fetch = async () => new Response(scenario.data);
    const driver = createModelTurnDriver({ runtime: new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "fake-key", fetch: transport }) }),
      config: () => ({ provider: "deepseek", model: "deepseek-v4-pro" }), systemPrompt: () => "", toolRegistry: registry });
    await driver({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => assert.fail() });
    const events = session.snapshot().events;
    const attempt = events.find((event) => event.type === "assistant/attempt");
    assert.equal(attempt?.data.outcome, scenario.outcome, scenario.name);
    const reason = attempt?.data.reason;
    assert.equal(typeof reason === "string" ? reason : typeof reason === "object" && reason !== null && "code" in reason ? reason.code : undefined, scenario.code, scenario.name);
    assert.equal(executions, 0, scenario.name);
    assert.equal(events.some((event) => event.type === "assistant/message" || event.type === "tool/call" || event.type === "approval/asked"), false, scenario.name);
  }
});

test("DeepSeek 请求失败在 Turn 持久结算且不重发或派发工具", async () => {
  const cases: { name: string; transport: typeof fetch; code: string }[] = [
    { name: "输入超限", transport: async () => new Response(JSON.stringify({ error: { code: "context_length_exceeded" } }), { status: 400 }), code: "CONTEXT_WINDOW_EXCEEDED" },
    { name: "鉴权", transport: async () => new Response(null, { status: 401 }), code: "AUTH" },
    { name: "限流", transport: async () => new Response(null, { status: 429 }), code: "RATE_LIMIT" },
    { name: "读流断网", transport: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(wire({ content: "部分", tool_calls: [tool] }, "tool_calls", false))); }, pull(controller) { controller.error(new Error("private")); } }, { highWaterMark: 0 })), code: "TRANSPORT" },
  ];
  for (const scenario of cases) {
    const session = new Session({ sessionId: scenario.name, createdAt: 0 });
    session.bindCheckpoint(async () => {});
    let calls = 0;
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(defineLocalTool({ name: "read", version: "1", description: "read", input: z.strictObject({}), timeoutMs: 1000,
      sideEffect: "read-only", output: defineLocalToolOutput({ schema: z.string(), render: (_args, value) => [{ type: "text", text: value }] }),
      handler: () => { executions++; return "ok"; } }));
    const transport: typeof fetch = (...args) => { calls++; return scenario.transport(...args); };
    const driver = createModelTurnDriver({ runtime: new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "private", fetch: transport }) }),
      config: () => ({ provider: "deepseek", model: "deepseek-v4-pro" }), systemPrompt: () => "", toolRegistry: registry });
    await driver({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => assert.fail() });
    const events = session.snapshot().events;
    const attempt = events.find((event) => event.type === "assistant/attempt");
    assert.equal(attempt?.data.outcome, "failed", scenario.name);
    assert.equal(typeof attempt?.data.reason === "object" && attempt.data.reason !== null && "code" in attempt.data.reason && attempt.data.reason.code, scenario.code, scenario.name);
    const end = events.findLast((event) => event.type === "turn/end");
    assert.equal(end?.data.reason.kind === "error" && end.data.reason.error.code, scenario.code, scenario.name);
    assert.equal(events.some((event) => event.type === "assistant/message" || event.type === "tool/call" || event.type === "approval/asked"), false, scenario.name);
    assert.equal(executions, 0, scenario.name);
    assert.equal(calls, 1, scenario.name);
    assert.doesNotMatch(JSON.stringify(events), /private/);
  }
});

test("DeepSeek 请求超时或取消在 Turn 保留不同结算", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const mode of ["timeout", "abort"] as const) {
    const session = new Session({ sessionId: mode, createdAt: 0 });
    session.bindCheckpoint(async () => {});
    const upstream = new AbortController();
    let calls = 0;
    let started!: () => void;
    const barrier = new Promise<void>((resolve) => { started = resolve; });
    const transport: typeof fetch = async () => { calls++; started(); return new Promise<Response>(() => {}); };
    const driver = createModelTurnDriver({ runtime: new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "private", fetch: transport }) }),
      config: () => ({ provider: "deepseek", model: "deepseek-v4-pro", timeouts: { requestTimeoutMs: 100, idleTimeoutMs: 50 } }), systemPrompt: () => "" });
    const running = driver({ session, turn: 1, step: 1, signal: upstream.signal, publish: () => {}, blockStorage: () => assert.fail() });
    await barrier;
    if (mode === "timeout") context.mock.timers.tick(100); else upstream.abort();
    await running;
    const events = session.snapshot().events;
    const attempt = events.find((event) => event.type === "assistant/attempt");
    assert.equal(attempt?.data.outcome, mode === "timeout" ? "failed" : "cancelled");
    const end = events.findLast((event) => event.type === "turn/end");
    assert.equal(end?.data.reason.kind, mode === "timeout" ? "error" : "aborted");
    if (mode === "timeout") assert.equal(end?.data.reason.kind === "error" && end.data.reason.error.code, "TIMEOUT");
    assert.equal(events.some((event) => event.type === "assistant/message" || event.type === "tool/call" || event.type === "approval/asked"), false);
    assert.equal(calls, 1);
  }
});

test("DeepSeek 每步固定凭据与路由并保留推理和工具配对", async () => {
  const session = new Session({ sessionId: "credentials", createdAt: 0 }); session.bindCheckpoint(async () => {});
  let key = "fake-old-key"; let model = "deepseek-v4-pro"; let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }); const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const auth: string[] = []; const bodies: { model: string; messages: { role: string; reasoning_content?: string; tool_call_id?: string }[] }[] = [];
  const transport: typeof fetch = async (_url, init) => {
    auth.push(new Headers(init?.headers).get("authorization") ?? "");
    bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]);
    return new Response(bodies.length === 1 ? wire({ reasoning_content: "思考", tool_calls: [tool] }, "tool_calls") : wire({ content: "完成" }, "stop"));
  };
  const registry = new ToolRegistry();
  registry.register(defineLocalTool({ name: "read", version: "1", description: "read", input: z.strictObject({}), timeoutMs: 1000, sideEffect: "read-only", output: defineLocalToolOutput({ schema: z.string(), render: (_args, value) => [{ type: "text", text: value }] }), handler: () => "结果" }));
  const notices: unknown[] = [];
  const running = createModelTurnDriver({ runtime: new LlmRuntime({ deepseek: () => createDeepSeekAdapter({ apiKey: key, fetch: transport }) }),
    config: () => ({ provider: "deepseek", model, params: { reasoningEffort: "high" } }), systemPrompt: () => "系统", toolRegistry: registry,
    preStep: async ({ step }) => { if (step === 1) { entered(); await gate; } },
  })({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: (notice) => notices.push(notice), blockStorage: () => assert.fail() });
  await waiting; key = "fake-new-key"; model = "deepseek-v4-flash"; release(); await running;
  assert.deepEqual(auth, ["Bearer fake-old-key", "Bearer fake-new-key"]);
  assert.deepEqual(bodies.map((body) => body.model), ["deepseek-v4-pro", "deepseek-v4-flash"]);
  assert.ok(bodies[1]?.messages.some((message) => message.role === "assistant" && message.reasoning_content === "思考"));
  assert.ok(bodies[1]?.messages.some((message) => message.role === "tool" && message.tool_call_id === "c"));
  assert.doesNotMatch(JSON.stringify([session.snapshot(), notices]), /fake-(old|new)-key/);
});
