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
