import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { Session } from "@mharness/session/server";
import { createModelTurnDriver } from "./model-turn.ts";
import { createMockAdapter } from "../model/providers/mock.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { defineLocalTool, ToolRegistry } from "../tools/registry.ts";
import { defineLocalToolOutput } from "../tools/result.ts";

const input = z.strictObject({ n: z.number() });
const output = defineLocalToolOutput({ schema: z.number(), render: (_args: { n: number }, value: number) => [{ type: "text" as const, text: String(value) }] });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const sideEffect of ["side-effect", "unknown"] as const) {
  test(`${sideEffect} 超时优先于结束意向且不重试`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const session = new Session({ sessionId: sideEffect, createdAt: 0 }); session.bindCheckpoint(async () => {});
    const entered = deferred(); const release = deferred(); const ran: number[] = [];
    const registry = new ToolRegistry();
    registry.register(defineLocalTool<typeof input, Promise<number>>({ name: "write", version: "1", description: "write", input, output, sideEffect, approvalPolicy: "allow", supportsIdempotency: true, supportsResultQuery: true, timeoutMs: 10, concludeTurn: true, handler: async ({ n }) => { ran.push(n); if (n === 2) { entered.resolve(); await release.promise; } return n; } }));
    let requests = 0;
    const drive = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { requests++; return [
      ...[1, 2, 3].map((n, index) => ({ chunk: { type: "tool_call" as const, index, callId: String(n), name: "write", argumentsDelta: JSON.stringify({ n }) } })),
      { chunk: { type: "finish" as const, reason: { kind: "tool_calls" as const } } },
    ]; }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: registry });
    const task = drive({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => assert.fail() });
    await entered.promise; t.mock.timers.tick(10); release.resolve(); await task;
    assert.deepEqual(ran, [1, 2]); assert.equal(requests, 1);
    assert.deepEqual(session.snapshot().events.filter((e) => e.type === "tool/result").map((e) => e.data.error?.code), [undefined, "TOOL_TIMEOUT", "TOOL_NOT_STARTED"]);
    const end = session.snapshot().events.findLast((e) => e.type === "turn/end");
    assert.equal(end?.data.reason.kind === "error" && end.data.reason.error.code, "TOOL_TIMEOUT");
  });
}

test("只读超时预算跨 Step 累计，在新 Turn 重置", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = new Session({ sessionId: "budget", createdAt: 0 }); session.bindCheckpoint(async () => {});
  const entered = Array.from({ length: 6 }, deferred); const releases = Array.from({ length: 6 }, deferred);
  let executions = 0; let requests = 0;
  const registry = new ToolRegistry();
  registry.register(defineLocalTool<typeof input, Promise<number>>({ name: "read", version: "1", description: "read", input, output, sideEffect: "read-only", timeoutMs: 10, handler: async ({ n }) => { if (n === 99) return n; const index = executions++; entered[index]!.resolve(); await releases[index]!.promise; return n; } }));
  const drive = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { const step = ++requests % 4; return step === 0 ? [{ chunk: { type: "finish" as const, reason: { kind: "stop" as const } } }] : [
    { chunk: { type: "tool_call" as const, index: 0, callId: "read", name: "read", argumentsDelta: '{"n":1}' } },
    ...(step === 3 ? [{ chunk: { type: "tool_call" as const, index: 1, callId: "tail", name: "read", argumentsDelta: '{"n":99}' } }] : []),
    { chunk: { type: "finish" as const, reason: { kind: "tool_calls" as const } } },
  ]; }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: registry });
  for (let turn = 1; turn <= 2; turn++) {
    requests = 0;
    const task = drive({ session, turn, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => assert.fail() });
    for (let i = (turn - 1) * 3; i < turn * 3; i++) { await entered[i]!.promise; t.mock.timers.tick(10); releases[i]!.resolve(); }
    await task;
    assert.equal(requests, 3);
  }
  assert.equal(executions, 6);
  assert.deepEqual(session.snapshot().events.filter((e) => e.type === "tool/result").map((e) => e.data.error?.code), ["TOOL_TIMEOUT", "TOOL_TIMEOUT", "TOOL_TIMEOUT", "TOOL_NOT_STARTED", "TOOL_TIMEOUT", "TOOL_TIMEOUT", "TOOL_TIMEOUT", "TOOL_NOT_STARTED"]);
  assert.deepEqual(session.snapshot().events.filter((e) => e.type === "turn/end").map((e) => e.data.reason.kind === "error" && e.data.reason.error.code), ["READ_ONLY_TIMEOUT_BUDGET_EXHAUSTED", "READ_ONLY_TIMEOUT_BUDGET_EXHAUSTED"]);
});


test("可注入只读超时上限并拒绝无效配置", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = new Session({ sessionId: "custom-budget", createdAt: 0 }); session.bindCheckpoint(async () => {});
  const entered = deferred(); const release = deferred();
  const registry = new ToolRegistry();
  registry.register(defineLocalTool<typeof input, Promise<number>>({ name: "read", version: "1", description: "read", input, output, sideEffect: "read-only", timeoutMs: 10, handler: async () => { entered.resolve(); await release.promise; return 1; } }));
  registry.register(defineLocalTool({ name: "done", version: "1", description: "done", input, output, sideEffect: "read-only", concludeTurn: true, handler: () => 1 }));
  let requests = 0;
  const options = { runtime: new LlmRuntime({ mock: createMockAdapter(() => { requests++; return [
    { chunk: { type: "tool_call" as const, index: 0, callId: "done", name: "done", argumentsDelta: '{"n":1}' } },
    { chunk: { type: "tool_call" as const, index: 1, callId: "read", name: "read", argumentsDelta: '{"n":1}' } },
    { chunk: { type: "finish" as const, reason: { kind: "tool_calls" as const } } },
  ]; }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: registry };
  for (const invalid of [0, -1, 1.5, Infinity]) assert.throws(() => createModelTurnDriver({ ...options, maxReadOnlyTimeouts: invalid }), RangeError);
  const task = createModelTurnDriver({ ...options, maxReadOnlyTimeouts: 1 })({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => assert.fail() });
  await entered.promise; t.mock.timers.tick(10); release.resolve(); await task;
  assert.equal(requests, 1);
  const end = session.snapshot().events.findLast((e) => e.type === "turn/end");
  assert.equal(end?.data.reason.kind === "error" && end.data.reason.error.code, "READ_ONLY_TIMEOUT_BUDGET_EXHAUSTED");
});
