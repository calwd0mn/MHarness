import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { Session, SqliteSessionPersistence, recoverInterruptedSession } from "@mharness/session/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../agent/manager.ts";
import { SessionCommandController } from "../commands.ts";
import { createModelTurnDriver } from "../agent/model-turn.ts";
import { createMockAdapter } from "../model/providers/mock.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { defineLocalTool, ToolRegistry } from "./registry.ts";
import { defineLocalToolOutput, HarnessError } from "./result.ts";
import { ApprovalService } from "../approval/service.ts";
import { runToolBatch } from "./batch.ts";

test("真实批次按声明顺序执行并让下一步读取已结算结果", async () => {
  const session = new Session({ sessionId: "batch", createdAt: 0 });
  session.bindCheckpoint(async () => {});
  const executed: number[] = [];
  const registry = new ToolRegistry();
  registry.register(defineLocalTool({ name: "read", version: "1", description: "read", input: z.strictObject({ n: z.number() }), timeoutMs: 100, sideEffect: "read-only", output: defineLocalToolOutput({ schema: z.number(), render: (_args, value) => [{ type: "text", text: String(value) }] }), handler: ({ n }) => { executed.push(n); return n; } }));
  let requests = 0;
  const drive = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => ++requests === 1 ? [
    { chunk: { type: "tool_call", index: 0, callId: "a", name: "read", argumentsDelta: '{"n":1}' } },
    { chunk: { type: "tool_call", index: 1, callId: "b", name: "read", argumentsDelta: '{"n":2}' } },
    { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
  ] : [{ chunk: { type: "finish", reason: { kind: "stop" } } }]) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: registry });
  await drive({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => assert.fail() });
  assert.deepEqual(executed, [1, 2]);
  assert.equal(requests, 2);
  assert.deepEqual(session.snapshot().events.filter((event) => event.type === "tool/call").map((event) => event.data.callId), ["a", "b"]);
});



function preparedSession(calls: { id: string; name: string; arguments: string }[]) {
  const session = new Session({ sessionId: `batch-${Math.random()}`, createdAt: 0 });
  session.bindCheckpoint(async () => {});
  session.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "assistant", role: "assistant", source: { provider: "mock", model: "m" }, content: calls.map((call) => ({ type: "tool-call" as const, ...call })) }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true } });
  return session;
}
function makeRegistry(handler: (n: number, signal: AbortSignal) => number | Promise<number>, approvalPolicy: "allow" | "ask" = "allow", concludeTurn = false) {
  const registry = new ToolRegistry();
  registry.register(defineLocalTool({ name: "read", version: "1", description: "read", input: z.strictObject({ n: z.number() }), timeoutMs: 100, approvalPolicy, concludeTurn, output: defineLocalToolOutput({ schema: z.number(), render: (_args, value) => [{ type: "text", text: String(value) }] }), handler: ({ n }, signal) => handler(n, signal) }));
  return registry;
}
const calls = [1, 2, 3].map((n) => ({ id: String(n), name: "read", arguments: JSON.stringify({ n }) }));

test("参数错误与明确业务失败只结算对应项并继续", async () => {
  const declared = [{ ...calls[0]!, arguments: "{" }, calls[1]!, calls[2]!];
  const session = preparedSession(declared);
  const ran: number[] = [];
  const result = await runToolBatch(session, makeRegistry((n) => { ran.push(n); if (n === 2) throw new HarnessError("业务失败", "BusinessError", "BUSINESS"); return n; }), new ApprovalService(null), { turn: 1, step: 1 }, declared, new AbortController().signal, () => session.flush());
  assert.deepEqual(result, { kind: "completed", concludeTurn: false });
  assert.deepEqual(ran, [2, 3]);
  const events = session.snapshot().events;
  assert.deepEqual(events.filter((e) => e.type === "tool/result").map((e) => e.data.error?.code), ["INVALID_JSON", "BUSINESS", undefined]);
  assert.equal(events.filter((e) => e.type === "tool/operation").length, 2);
});

test("明确拒绝优先于已有结束意向，后续调用不派发", async () => {
  const session = preparedSession(calls);
  let approvalCount = 0;
  const service = new ApprovalService(async () => ++approvalCount === 1 ? "allowed-once" : "rejected");
  const ran: number[] = [];
  const result = await runToolBatch(session, makeRegistry((n) => { ran.push(n); return n; }, "ask", true), service, { turn: 1, step: 1 }, calls, new AbortController().signal, () => session.flush());
  assert.deepEqual(result, { kind: "rejected" });
  assert.deepEqual(ran, [1]);
  assert.deepEqual(session.snapshot().events.filter((e) => e.type === "tool/result").map((e) => e.data.error?.code), [undefined, "APPROVAL_REJECTED", "TOOL_NOT_STARTED"]);
});

test("等待检查点取消不执行，派发后的取消传给正文并保留已成功项", async () => {
  for (const phase of ["checkpoint", "running"] as const) {
    const session = preparedSession(calls);
    const controller = new AbortController();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const ran: number[] = [];
    let toolSignal: AbortSignal | undefined;
    const registry = makeRegistry(async (n, signal) => { ran.push(n); if (n === 2 && phase === "running") { toolSignal = signal; entered(); await wait; } return n; });
    let checkpoints = 0;
    const task = runToolBatch(session, registry, new ApprovalService(null), { turn: 1, step: 1 }, calls, controller.signal, async () => { if (++checkpoints === 2 && phase === "checkpoint") { entered(); await wait; } });
    await started; controller.abort(); release();
    assert.deepEqual(await task, { kind: "aborted" });
    assert.deepEqual(ran, phase === "running" ? [1, 2] : [1]);
    if (phase === "running") assert.equal(toolSignal?.aborted, true);
    assert.deepEqual(session.snapshot().events.filter((e) => e.type === "tool/result").map((e) => e.data.error?.code), [undefined, phase === "running" ? "ABORTED" : "ABORTED_BEFORE_DISPATCH", "ABORTED_BEFORE_DISPATCH"]);
  }
});

test("同步和异步普通异常都安全结算并阻止后续调用", async () => {
  for (const asyncFailure of [false, true]) {
    const session = preparedSession(calls);
    const ran: number[] = [];
    const result = await runToolBatch(session, makeRegistry((n) => { ran.push(n); if (n === 2) { if (asyncFailure) return Promise.reject(new Error("secret")); throw new Error("secret"); } return n; }), new ApprovalService(null), { turn: 1, step: 1 }, calls, new AbortController().signal, () => session.flush());
    assert.deepEqual(result, { kind: "failed" });
    assert.deepEqual(ran, [1, 2]);
    assert.equal(JSON.stringify(session.snapshot().events).includes("secret"), false);
    assert.deepEqual(session.snapshot().events.filter((e) => e.type === "tool/result").map((e) => e.data.message.source.callId), ["1", "2", "3"]);
  }
});

test("真实 Agent 与 SQLite 中审批等待取消或派发后取消均停止续答", async (t) => {
  for (const phase of ["approval", "running"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "mharness-batch-"));
    const store = new SqliteSessionPersistence(join(dir, "events.sqlite"));
    const handle = await store.create({ sessionId: "s", createdAt: 1 }); await handle.flush(); await handle.close();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const executed: number[] = [];
    const registry = makeRegistry(async (n) => { executed.push(n); if (n === 2) { entered(); await waiting; } return n; }, phase === "approval" ? "ask" : "allow");
    const approvals = new ApprovalService(async () => { entered(); await waiting; return "allowed-once" as const; });
    let requests = 0;
    const drive = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { requests++; return [
      { chunk: { type: "tool_call", index: 0, callId: "1", name: "read", argumentsDelta: '{"n":1}' } },
      { chunk: { type: "tool_call", index: 1, callId: "2", name: "read", argumentsDelta: '{"n":2}' } },
      { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
    ]; }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: registry, approvalService: approvals });
    const manager = new AgentManager(store, drive);
    try {
      const commands = new SessionCommandController(manager);
      await commands.prompt({ sessionId: "s", requestId: "r", content: [{ type: "text", text: "go" }] });
      await started;
      const agent = manager.get("s"); assert.ok(agent);
      await commands.cancel("s"); release(); await agent.waitForIdle();
      assert.equal(requests, 1);
      assert.deepEqual(executed, phase === "approval" ? [] : [1, 2]);
      const results = agent.session.snapshot().events.filter((e) => e.type === "tool/result");
      assert.equal(results.length, 2);
      assert.equal(results[0]?.data.error?.code, phase === "approval" ? "ABORTED_BEFORE_DISPATCH" : undefined);
      assert.equal(results[1]?.data.error?.code, phase === "approval" ? "ABORTED_BEFORE_DISPATCH" : "ABORTED");
      await agent.session.flush();
      const reader = await store.open("s", "read"); assert.ok(reader);
      assert.equal((await reader.read()).filter((e) => e.type === "tool/result").length, 2);
      await reader.close();
    } finally { release(); await manager.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
  }
});

test("不同 Step 重用调用编号时操作与结果独立并在下一请求前落盘", async () => {
  const session = new Session({ sessionId: "same-id", createdAt: 0 });
  let persisted = 0; session.bindCheckpoint(async (count) => { persisted = count; });
  let requests = 0;
  const registry = makeRegistry((n) => n, "ask");
  const drive = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => {
    requests++;
    if (requests > 1) {
      const events = session.snapshot().events;
      const priorEnd = events.findLast((e) => e.type === "step/end");
      assert.ok(priorEnd && priorEnd.seq < persisted);
    }
    return requests <= 2 ? [
      { chunk: { type: "tool_call", index: 0, callId: "same", name: "read", argumentsDelta: JSON.stringify({ n: requests }) } },
      { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
    ] : [{ chunk: { type: "finish", reason: { kind: "stop" } } }];
  }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: registry, approvalService: new ApprovalService(async () => "allowed-once" as const) });
  await drive({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => assert.fail() });
  const events = session.snapshot().events;
  const asked = events.filter((e) => e.type === "approval/asked");
  assert.equal(asked.length, 2); assert.notEqual(asked[0]?.data.id, asked[1]?.data.id);
  const operations = events.filter((e) => e.type === "tool/operation");
  assert.equal(operations.length, 2); assert.notEqual(operations[0]?.data.operationId, operations[1]?.data.operationId);
  assert.deepEqual(events.filter((e) => e.type === "tool/result").map((e) => [e.data.step, e.data.operationId]), operations.map((e) => [e.data.step, e.data.operationId]));
  assert.equal(requests, 3);
});

test("生成未完成的参数只保存失败 Attempt，不调度", async () => {
  const session = new Session({ sessionId: "incomplete", createdAt: 0 }); session.bindCheckpoint(async () => {});
  let executions = 0;
  const drive = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => [
    { chunk: { type: "tool_call", index: 0, callId: "c", name: "read", argumentsDelta: '{"n":' } },
    { chunk: { type: "finish", reason: { kind: "output_limit" } } },
  ]) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: makeRegistry((n) => { executions++; return n; }) });
  await drive({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => assert.fail() });
  assert.equal(executions, 0);
  assert.equal(session.snapshot().events.some((e) => e.type === "tool/call"), false);
  assert.equal(session.snapshot().events.some((e) => e.type === "assistant/attempt"), true);
});



test("带结束意向的成功后用户拒绝仍由 Turn 中止且不续答", async () => {
  const session = new Session({ sessionId: "reject-after-success", createdAt: 0 }); session.bindCheckpoint(async () => {});
  let approvals = 0; let requests = 0;
  const ran: number[] = [];
  const drive = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { requests++; return [
    ...calls.map((call, index) => ({ chunk: { type: "tool_call" as const, index, callId: call.id, name: call.name, argumentsDelta: call.arguments } })),
    { chunk: { type: "finish" as const, reason: { kind: "tool_calls" as const } } },
  ]; }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: makeRegistry((n) => { ran.push(n); return n; }, "ask", true), approvalService: new ApprovalService(async () => ++approvals === 1 ? "allowed-once" : "rejected") });
  await drive({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => assert.fail() });
  assert.equal(requests, 1); assert.deepEqual(ran, [1]);
  const events = session.snapshot().events;
  assert.deepEqual(events.filter((e) => e.type === "tool/result").map((e) => e.data.error?.code), [undefined, "APPROVAL_REJECTED", "TOOL_NOT_STARTED"]);
  const end = events.at(-1); assert.equal(end?.type === "turn/end" && end.data.reason.kind, "blocked");
});

test("输出契约失败保留失败结局并继续同批后续项", async () => {
  const session = preparedSession(calls.slice(0, 2));
  const ran: number[] = [];
  const registry = new ToolRegistry();
  registry.register(defineLocalTool({ name: "read", version: "1", description: "read", input: z.strictObject({ n: z.number() }), timeoutMs: 100, sideEffect: "read-only", output: defineLocalToolOutput({ schema: z.number(), render: (_args, value) => [{ type: "text", text: String(value) }] }), handler: ({ n }) => { ran.push(n); return n === 1 ? NaN : n; } }));
  const outcome = await runToolBatch(session, registry, new ApprovalService(null), { turn: 1, step: 1 }, calls.slice(0, 2), new AbortController().signal, () => session.flush());
  assert.deepEqual(outcome, { kind: "completed", concludeTurn: false }); assert.deepEqual(ran, [1, 2]);
  assert.deepEqual(session.snapshot().events.filter((e) => e.type === "tool/result").map((e) => e.data.error?.code), ["INVALID_TOOL_OUTPUT", undefined]);
});

test("正文前检查点失败阻止正文并按声明顺序补齐结果", async () => {
  const session = preparedSession(calls); let executions = 0;
  await assert.rejects(runToolBatch(session, makeRegistry((n) => { executions++; return n; }), new ApprovalService(null), { turn: 1, step: 1 }, calls, new AbortController().signal, async () => { throw new Error("checkpoint"); }), /checkpoint/);
  assert.equal(executions, 0);
  assert.deepEqual(session.snapshot().events.filter((e) => e.type === "tool/result").map((e) => [e.data.message.source.callId, e.data.error?.code]), [["1", "TOOL_NOT_STARTED"], ["2", "TOOL_NOT_STARTED"], ["3", "TOOL_NOT_STARTED"]]);
});

test("真实 Agent 在工具检查点等待期间取消不会执行正文", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-checkpoint-"));
  const store = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const handle = await store.create({ sessionId: "s", createdAt: 1 }); await handle.flush(); await handle.close();
  let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  let executions = 0; let requests = 0;
  const drive = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { requests++; return [
    { chunk: { type: "tool_call", index: 0, callId: "1", name: "read", argumentsDelta: '{"n":1}' } },
    { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
  ]; }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: makeRegistry((n) => { executions++; return n; }) });
  const manager = new AgentManager(store, drive);
  manager.onLoaded((agent) => {
    const original = agent.session.flush.bind(agent.session); let count = 0;
    agent.session.flush = async () => { if (++count === 3) { entered(); await waiting; } await original(); };
  });
  try {
    const commands = new SessionCommandController(manager);
    await commands.prompt({ sessionId: "s", requestId: "r", content: [{ type: "text", text: "go" }] });
    await started; const agent = manager.get("s"); assert.ok(agent); await commands.cancel("s"); release(); await agent.waitForIdle();
    assert.equal(executions, 0); assert.equal(requests, 1);
    assert.equal(agent.session.snapshot().events.find((e) => e.type === "tool/result")?.data.error?.code, "ABORTED_BEFORE_DISPATCH");
  } finally { release(); await manager.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("stop 结束但携带调用时只结算未派发结果", async () => {
  const session = new Session({ sessionId: "stop-call", createdAt: 0 }); session.bindCheckpoint(async () => {});
  let executions = 0;
  const drive = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => [
    { chunk: { type: "tool_call", index: 0, callId: "c", name: "read", argumentsDelta: '{"n":1}' } },
    { chunk: { type: "finish", reason: { kind: "stop" } } },
  ]) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: makeRegistry((n) => { executions++; return n; }) });
  await drive({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => assert.fail() });
  assert.equal(executions, 0);
  assert.equal(session.snapshot().events.find((e) => e.type === "tool/result")?.data.error?.code, "TOOL_NOT_STARTED");
});

test("审批 asked 与 decided 检查点失败关闭存储准入，渠道失败不关闭", async () => {
  for (const phase of ["asked", "decided", "channel"] as const) {
    const session = new Session({ sessionId: `approval-${phase}`, createdAt: 0 });
    let checkpoints = 0;
    session.bindCheckpoint(async () => {
      checkpoints++;
      if ((phase === "asked" && checkpoints === 3) || (phase === "decided" && checkpoints === 4)) throw Object.assign(new Error("secret"), { code: "SQLITE_BUSY" });
    });
    let blocked = 0; let executions = 0;
    const drive = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => [
      { chunk: { type: "tool_call", index: 0, callId: "1", name: "read", argumentsDelta: '{"n":1}' } },
      { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
    ]) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: makeRegistry((n) => { executions++; return n; }, "ask"), approvalService: new ApprovalService(async () => { if (phase === "channel") throw new Error("channel secret"); return "allowed-once" as const; }) });
    await drive({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => { blocked++; } });
    assert.equal(executions, 0); assert.equal(blocked, phase === "channel" ? 0 : 1);
    const end = session.snapshot().events.at(-1);
    assert.equal(end?.type === "turn/end" && end.data.reason.kind === "error" && end.data.reason.error.code, phase === "channel" ? "UNKNOWN" : "SQLITE_BUSY");
    assert.equal(JSON.stringify(session.snapshot().events).includes("secret"), false);
  }
});

test("审批等待的真实持久前缀在重启恢复时按结果未知结算", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-batch-recovery-"));
  const store = new SqliteSessionPersistence(join(dir, "live.sqlite"));
  const recoveryStore = new SqliteSessionPersistence(join(dir, "recovery.sqlite"));
  const initial = await store.create({ sessionId: "s", createdAt: 1 }); await initial.flush(); await initial.close();
  let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; });
  let executions = 0;
  const driver = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => [
    { chunk: { type: "tool_call", index: 0, callId: "1", name: "read", argumentsDelta: '{"n":1}' } },
    { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
  ]) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: makeRegistry((n) => { executions++; return n; }, "ask"), approvalService: new ApprovalService(async () => { entered(); await waiting; return "allowed-once" as const; }) });
  const manager = new AgentManager(store, driver);
  try {
    const commands = new SessionCommandController(manager);
    await commands.prompt({ sessionId: "s", requestId: "r", content: [{ type: "text", text: "go" }] }); await started;
    const reader = await store.open("s", "read"); assert.ok(reader); const prefix = await reader.read(); await reader.close();
    const recovery = await recoveryStore.create({ sessionId: "s", createdAt: 1 }); await recovery.append(prefix);
    const repaired = await recoverInterruptedSession(recovery);
    assert.equal(repaired.find((e) => e.type === "tool/result")?.data.error?.code, "TOOL_OUTCOME_UNKNOWN");
    assert.equal(executions, 0); await recovery.close();
  } finally { await new SessionCommandController(manager).cancel("s"); release(); await manager.close(); await store.close(); await recoveryStore.close(); await rm(dir, { recursive: true, force: true }); }
});



test("模型可在下一 Step 修正参数，成功结束意向不提前结束本轮", async () => {
  const session = new Session({ sessionId: "repair-arguments", createdAt: 0 }); session.bindCheckpoint(async () => {});
  let requests = 0; const ran: number[] = [];
  const drive = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => {
    requests++;
    return requests <= 2 ? [
      { chunk: { type: "tool_call", index: 0, callId: "c", name: "read", argumentsDelta: requests === 1 ? "{" : '{"n":7}' } },
      { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
    ] : [{ chunk: { type: "finish", reason: { kind: "stop" } } }];
  }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: makeRegistry((n) => { ran.push(n); return n; }, "allow", true) });
  await drive({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => assert.fail() });
  assert.equal(requests, 3); assert.deepEqual(ran, [7]);
  const results = session.snapshot().events.filter((e) => e.type === "tool/result");
  assert.deepEqual(results.map((e) => e.data.error?.code), ["INVALID_JSON", undefined]);
});
