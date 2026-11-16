import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Session, SqliteSessionPersistence } from "@mharness/session/server";
import { AgentManager } from "./manager.ts";
import { SessionCommandController } from "../commands.ts";
import { createModelTurnDriver } from "./model-turn.ts";
import { createMockAdapter } from "../model/providers/mock.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { ApprovalService } from "../approval/service.ts";
import { defineLocalTool, ToolRegistry } from "../tools/registry.ts";
import { defineLocalToolOutput, HarnessError } from "../tools/result.ts";

function registry(handler: (n: number) => number, approvalPolicy: "allow" | "ask" = "allow") {
  const result = new ToolRegistry();
  result.register(defineLocalTool({ name: "read", version: "1", description: "read", input: z.strictObject({ n: z.number() }), timeoutMs: 100, sideEffect: "read-only", approvalPolicy, concludeTurn: true, output: defineLocalToolOutput({ schema: z.number(), render: (_args, value) => [{ type: "text", text: String(value) }] }), handler: ({ n }) => handler(n) }));
  return result;
}

function toolChunks(count: number) {
  return [
    ...Array.from({ length: count }, (_, index) => ({ chunk: { type: "tool_call" as const, index, callId: `c${index}`, name: "read", argumentsDelta: JSON.stringify({ n: index + 1 }) } })),
    { chunk: { type: "finish" as const, reason: { kind: "tool_calls" as const } } },
  ];
}

test("结束意向保留同批明确错误，并可用同一 Agent 处理下一轮", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-conclude-"));
  const store = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const handle = await store.create({ sessionId: "s", createdAt: 1 });
  await handle.flush(); await handle.close();
  const ran: number[] = [];
  let requests = 0;
  const driver = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => ++requests === 1 ? toolChunks(2) : [{ chunk: { type: "finish", reason: { kind: "stop" } } }]) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: registry((n) => { ran.push(n); if (n === 2) throw new HarnessError("业务失败", "BusinessError", "BUSINESS"); return n; }) });
  const manager = new AgentManager(store, driver);
  try {
    const commands = new SessionCommandController(manager);
    await commands.prompt({ sessionId: "s", requestId: "r1", content: [{ type: "text", text: "go" }] });
    const agent = manager.get("s"); assert.ok(agent); await agent.waitForIdle();
    const first = agent.session.snapshot().events;
    assert.deepEqual(ran, [1, 2]);
    assert.equal(requests, 1);
    assert.deepEqual(first.filter((e) => e.type === "tool/result").map((e) => [e.data.message.source.callId, e.data.error?.code]), [["c0", undefined], ["c1", "BUSINESS"]]);
    assert.equal(first.filter((e) => e.type === "step/start").length, 1);
    assert.equal(first.filter((e) => e.type === "assistant/message").length, 1);
    const end = first.findLast((e) => e.type === "turn/end");
    assert.equal(end?.data.reason.kind, "completed");
    await commands.prompt({ sessionId: "s", requestId: "r2", content: [{ type: "text", text: "again" }] });
    assert.equal(manager.get("s"), agent); await agent.waitForIdle();
    assert.equal(requests, 2);
    assert.deepEqual(agent.session.snapshot().events.filter((e) => e.type === "turn/end").map((e) => e.data.reason.kind), ["completed", "completed"]);
    await agent.session.flush();
    const reader = await store.open("s", "read"); assert.ok(reader);
    assert.equal((await reader.read()).filter((e) => e.type === "tool/result").length, 2);
    await reader.close();
  } finally { await manager.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("失败结果不能提出结束意向", async () => {
  const session = new Session({ sessionId: "failed-intent", createdAt: 0 }); session.bindCheckpoint(async () => {});
  let requests = 0;
  const driver = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => ++requests === 1 ? toolChunks(1) : [{ chunk: { type: "finish", reason: { kind: "stop" } } }]) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: registry(() => { throw new HarnessError("失败", "BusinessError", "BUSINESS"); }) });
  await driver({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => assert.fail() });
  assert.equal(requests, 2);
  assert.equal(session.snapshot().events.find((e) => e.type === "tool/result")?.data.error?.code, "BUSINESS");
});

test("已有结束意向时取消、拒绝或派发异常仍优先", async () => {
  for (const cause of ["cancel", "reject", "exception"] as const) {
    const session = new Session({ sessionId: cause, createdAt: 0 }); session.bindCheckpoint(async () => {});
    const controller = new AbortController(); let requests = 0; let approvals = 0;
    const driver = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { requests++; return toolChunks(2); }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: registry((n) => { if (n === 2 && cause === "cancel") controller.abort(); if (n === 2 && cause === "exception") throw new Error("lost"); return n; }, cause === "reject" ? "ask" : "allow"), approvalService: new ApprovalService(async () => ++approvals === 1 ? "allowed-once" : "rejected") });
    await driver({ session, turn: 1, step: 1, signal: controller.signal, publish: () => {}, blockStorage: () => assert.fail() });
    assert.equal(requests, 1);
    const end = session.snapshot().events.findLast((e) => e.type === "turn/end");
    assert.equal(end?.data.reason.kind, cause === "cancel" ? "aborted" : cause === "reject" ? "blocked" : "error");
  }
});
