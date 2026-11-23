import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SqliteSessionPersistence } from "@mharness/session/server";
import { z } from "zod";
import { ToolRegistry, defineLocalTool } from "../tools/registry.ts";
import { defineLocalToolOutput } from "../tools/result.ts";
import { SessionWriter } from "../../../../packages/session/src/writer.ts";
import { ReActAgent } from "../agent/react-agent.ts";
import { createModelTurnDriver } from "../agent/model-turn.ts";
import { runPreStepPressure } from "../agent/pre-step-pressure.ts";
import { recoverContextOverflow } from "../agent/context-overflow-recovery.ts";
import { rebuildRequestContext } from "../agent/request-context.ts";
import { estimateRequestTokens } from "../model/token-meter.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { LlmError, type ModelAdapter, type ModelRequest } from "../model/adapter.ts";

const pruningScenarios = [
  ["pressure", "success"], ["pressure", "low"], ["pressure", "flush-fails"], ["pressure", "pending"],
  ["overflow", "success"], ["overflow", "flush-fails"], ["overflow", "pending"],
] as const;
for (const [entry, mode] of pruningScenarios) test(`真实 Turn 修剪与持久化边界：${entry}/${mode}`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pressure-acceptance-"));
  const path = join(dir, "session.sqlite");
  const store = new SqliteSessionPersistence(path);
  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  const session = new Session({ sessionId: "pressure", createdAt: 1 });
  const handle = await store.create(session.header);
  await handle.flush();
  session.append({ type: "turn/start", data: { turn: 1 } });
  session.append({ type: "user/message", surfaceOp: "append", data: { id: "old", role: "user", source: { kind: "user" }, turn: 1, requestId: "old", content: [{ type: "text", text: "旧任务" }] } });
  session.append({ type: "step/start", data: { turn: 1, step: 1 } });
  session.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "call", role: "assistant", source: { provider: "mock", model: "m" }, content: [{ type: "tool-call", id: "c", name: "read", arguments: "{}" }] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true } });
  const call = session.append({ type: "tool/call", data: { turn: 1, step: 1, callId: "c", name: "read", arguments: "{}" } });
  session.append({ type: "tool/result", surfaceOp: "append", sourceEventSeqs: [call.seq], data: { turn: 1, step: 1, message: { id: "result", role: "user", source: { kind: "tool", callId: "c" }, content: [{ type: "tool-result", toolCallId: "c", isError: false, content: [{ type: "text", text: "x".repeat(12000) }] }] } } });
  session.append({ type: "step/end", data: { turn: 1, step: 1 } });
  session.append({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  await handle.append(session.snapshot().events);
  const reader = await observer.open("pressure", "read"); assert.ok(reader);
  const original = new Error(`injected-${mode}`);
  let armed = false;
  let factoryCalls = 0;
  let stagedCalls = 0;
  let attemptConfirmed = false;
  let businessCalls = 0;
  let summaryCalls = 0;
  let businessRequest: ModelRequest | undefined;
  let diskAtEntry: Awaited<ReturnType<typeof reader.read>> | undefined;
  const adapter: ModelAdapter = {
    modelBudgets: { m: { contextWindow: 100000 } },
    async *generate(request) {
      if (request.effectiveParams.maxOutputTokens === 8192) {
        summaryCalls++;
        if (entry === "overflow") throw new LlmError("CONTEXT_WINDOW_EXCEEDED");
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "历史摘要" } };
        yield { type: "finish", reason: { kind: "stop" } };
        return;
      }
      businessCalls++;
      businessRequest = request;
      diskAtEntry = await reader.read();
      if (entry === "overflow" && businessCalls === 1) throw new LlmError("CONTEXT_WINDOW_EXCEEDED");
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "完成" } };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
  const runtime = new LlmRuntime({ mock: () => { factoryCalls++; return adapter; } });
  const meter = new LlmRuntime({ mock: adapter }).prepare({ provider: "mock", model: "m" });
  const warnings: string[] = [];
  const driver = createModelTurnDriver({
    runtime,
    config: () => ({ provider: "mock", model: "m", params: { maxOutputTokens: (mode === "low" || entry === "overflow" ? 79999 : 80000) - estimateRequestTokens(meter, { systemPrompt: "system", tools: [], messages: session.deriveMessages() }) } }),
    systemPrompt: () => "system",
    ...(entry === "overflow" ? {
      recoverOverflow: async (context, operations) => {
        attemptConfirmed = (await reader.read()).some(event => event.type === "assistant/attempt" && event.data.turn === 2);
        const pressure = operations.measure();
        assert.ok(pressure.status === "measured");
        assert.equal(pressure.pressure, 79999);
        armed = true;
        return recoverContextOverflow(context, operations, reason => warnings.push(reason));
      },
    } : {
    preStep: async (context, operations) => {
      const pressure = operations.measure();
      assert.equal(pressure.status, "measured");
      if (pressure.status === "measured") assert.equal(pressure.pressure, mode === "low" ? 79999 : 80000);
      armed = true;
      await runPreStepPressure(context, operations, reason => warnings.push(reason), 1);
    } }),
  });
  const agent = new ReActAgent(session, driver, handle);
  const writer = new SessionWriter(session, {
    append: events => handle.append(events),
    flush: async () => { if (armed && mode === "flush-fails") { armed = false; throw original; } await handle.flush(); },
    read: (offset, length) => handle.read(offset, length),
    commitStaged: async events => { stagedCalls++; if (mode === "pending") return { status: "pending-reconciliation", error: original }; await handle.append(events); return { status: "committed" }; },
    reconcileStaged: async () => ({ status: "rolled-back", error: original }),
  }, error => agent.blockStorage(error));
  const observations: string[] = [];
  agent.onObservation(notice => observations.push(notice.type === "event" ? notice.event.type : notice.type));
  try {
    agent.prompt({ requestId: "new", content: [{ type: "text", text: "继续" }] });
    await agent.waitForIdle();
    assert.equal(factoryCalls, 1);
    const events = session.snapshot().events;
    if (mode === "low") {
      assert.equal(stagedCalls, 0);
      assert.equal(businessCalls, 1);
      assert.equal(events.some(event => event.type === "compaction/prune" || event.type === "compaction/start"), false);
      assert.deepEqual(warnings, []);
    } else if (mode === "success") {
      assert.equal(stagedCalls, 1);
      assert.ok(businessRequest && diskAtEntry);
      assert.equal(events.filter(event => event.type === "compaction/prune").length, 1);
      assert.equal(events.filter(event => event.type === "compaction/start").length, entry === "overflow" ? 1 : 0);
      assert.ok(diskAtEntry.some(event => event.type === "compaction/prune"));
      assert.ok(diskAtEntry.some(event => event.type === "step/start" && event.data.turn === 2));
      const restored = new Session(session.header, { seed: { kind: "restore", events: diskAtEntry, inheritedEventCount: 0 } });
      const replay = rebuildRequestContext(restored);
      assert.deepEqual({ systemPrompt: businessRequest.systemPrompt, tools: businessRequest.tools, messages: businessRequest.messages }, replay.input);
      assert.deepEqual(businessRequest.effectiveParams.maxOutputTokens, replay.header.config.maxTokens);
      if (entry === "pressure") assert.ok(observations.indexOf("compaction/prune") < observations.indexOf("step/start"));
      else assert.ok(observations.indexOf("step/start") < observations.indexOf("compaction/prune"));
      assert.ok(observations.indexOf("step/start") < observations.indexOf("assistant-stream"));
      assert.deepEqual(warnings, entry === "overflow" ? ["summary-context-overflow"] : []);
      if (entry === "overflow") {
        assert.equal(businessCalls, 2);
        assert.equal(summaryCalls, 1);
        assert.equal(attemptConfirmed, true);
        assert.match(JSON.stringify(businessRequest.messages), /tool result middle pruned/);
        const failedAttempt = diskAtEntry.findIndex(event => event.type === "assistant/attempt" && event.data.turn === 2 && event.data.outcome === "failed");
        const prune = diskAtEntry.findIndex(event => event.type === "compaction/prune");
        assert.ok(failedAttempt >= 0 && failedAttempt < prune);
        assert.equal(diskAtEntry[prune + 1]?.type, "tool/result");
        assert.equal(diskAtEntry.some(event => event.type === "compaction/summary"), false);
        assert.equal(events.filter(event => event.type === "step/start" && event.data.turn === 2).length, 1);
        assert.equal(events.filter(event => event.type === "step/end" && event.data.turn === 2).length, 1);
      }
    } else {
      assert.equal(businessCalls, entry === "overflow" ? 1 : 0);
      assert.equal(attemptConfirmed, entry === "overflow");
      assert.equal(stagedCalls, mode === "pending" ? 1 : 0);
      assert.equal(agent.storageOpen, false);
      assert.equal(events.some(event => event.type === "step/start" && event.data.turn === 2), entry === "overflow");
      assert.equal(events.some(event => event.type === "step/end" && event.data.turn === 2), false);
      assert.equal(events.some(event => event.type === "turn/end" && event.data.turn === 2), false);
      assert.equal(events.some(event => event.type === "compaction/start"), false);
      if (entry === "pressure") assert.deepEqual(warnings, ["storage-failed"]);
      assert.throws(() => agent.prompt({ requestId: "another", content: [{ type: "text", text: "新" }] }), error => error instanceof Error && error.cause === original);
    }
  } finally {
    armed = false;
    await writer.close();
    await reader.close(); await handle.close(); await observer.close(); await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("两次真实摘要复用固定 Adapter，业务草稿晚于摘要持久化", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pressure-summary-"));
  const path = join(dir, "session.sqlite");
  const store = new SqliteSessionPersistence(path);
  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  const session = new Session({ sessionId: "summary", createdAt: 1 });
  const handle = await store.create(session.header); await handle.flush();
  for (let turn = 1; turn <= 3; turn++) {
    session.append({ type: "turn/start", data: { turn } });
    session.append({ type: "user/message", surfaceOp: "append", data: { id: `u${turn}`, role: "user", source: { kind: "user" }, turn, requestId: `r${turn}`, content: [{ type: "text", text: String(turn).repeat(80000) }] } });
    session.append({ type: "step/start", data: { turn, step: 1 } });
    session.append({ type: "assistant/message", surfaceOp: "append", data: { turn, step: 1, message: { id: `a${turn}`, role: "assistant", source: { provider: "mock", model: "m" }, content: [{ type: "text", text: "完成" }] }, finishReason: { kind: "stop" }, stream: [], includeInModelContext: true } });
    session.append({ type: "step/end", data: { turn, step: 1 } });
    session.append({ type: "turn/end", data: { turn, reason: { kind: "completed" } } });
  }
  await handle.append(session.snapshot().events);
  const reader = await observer.open("summary", "read"); assert.ok(reader);
  const requests: ModelRequest[] = [];
  let factoryCalls = 0;
  let diskAtEntry: Awaited<ReturnType<typeof reader.read>> | undefined;
  const adapter: ModelAdapter = {
    modelBudgets: { m: { contextWindow: 100000 } },
    async *generate(request) {
      requests.push(request);
      const summary = request.effectiveParams.maxOutputTokens === 8192;
      if (!summary) diskAtEntry = await reader.read();
      const text = summary ? requests.length === 1 ? "首摘要".repeat(400) : "次摘要" : "业务回答";
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
  const runtime = new LlmRuntime({ mock: () => { factoryCalls++; return adapter; } });
  const warnings: string[] = [];
  const driver = createModelTurnDriver({ runtime, config: () => ({ provider: "mock", model: "m", params: { maxOutputTokens: 79000 } }), systemPrompt: () => "system", preStep: (context, operations) => runPreStepPressure(context, operations, reason => warnings.push(reason), 1) });
  const agent = new ReActAgent(session, driver, handle);
  store.bindWriter(handle, session, error => agent.blockStorage(error));
  const observations: string[] = [];
  agent.onObservation(notice => observations.push(notice.type === "event" ? notice.event.type : notice.type));
  try {
    agent.prompt({ requestId: "new", content: [{ type: "text", text: "继续" }] });
    await agent.waitForIdle();
    assert.equal(factoryCalls, 1);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map(request => request.effectiveParams.maxOutputTokens), [8192, 8192, 79000]);
    assert.match(JSON.stringify(requests[1]?.messages), /首摘要/);
    const events = session.snapshot().events;
    const starts = events.filter(event => event.type === "compaction/start");
    assert.equal(starts.length, 2);
    assert.notEqual(starts[0]?.data.compactionId, starts[1]?.data.compactionId);
    assert.equal(events.filter(event => event.type === "compaction/summary").length, 2);
    assert.ok(diskAtEntry);
    assert.equal(diskAtEntry.filter(event => event.type === "compaction/summary").length, 2);
    const replay = rebuildRequestContext(new Session(session.header, { seed: { kind: "restore", events: diskAtEntry, inheritedEventCount: 0 } }));
    assert.deepEqual({ systemPrompt: requests[2]!.systemPrompt, tools: requests[2]!.tools, messages: requests[2]!.messages }, replay.input);
    assert.ok(observations.lastIndexOf("compaction/end") < observations.indexOf("step/start"));
    assert.ok(observations.indexOf("step/start") < observations.indexOf("assistant-stream"));
    assert.deepEqual(warnings, ["pressure-remains-high"]);
  } finally {
    await agent.stop(); await reader.close(); await handle.close(); await observer.close(); await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});


for (const changed of [false, true]) test(`工具续答真实压力替换后的请求头：${changed ? "配置变更" : "同配置"}`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pressure-next-step-"));
  const path = join(dir, "session.sqlite");
  const store = new SqliteSessionPersistence(path);
  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  const session = new Session({ sessionId: "next", createdAt: 1 });
  const handle = await store.create(session.header); await handle.flush();
  const reader = await observer.open("next", "read"); assert.ok(reader);
  const registry = new ToolRegistry();
  registry.register(defineLocalTool({
    name: "read", version: "1", description: "读取", input: z.strictObject({}), sideEffect: "read-only",
    handler: () => "x".repeat(12000),
    output: defineLocalToolOutput({ schema: z.string(), render: (_args, value) => [{ type: "text", text: value }] }),
  }));
  const requests: ModelRequest[] = [];
  const prefixes: (Awaited<ReturnType<typeof reader.read>>)[] = [];
  const adapter: ModelAdapter = {
    modelBudgets: { m: { contextWindow: 100000 } },
    async *generate(request) {
      requests.push(request);
      prefixes.push(await reader.read());
      if (requests.length === 1) {
        const block = { type: "tool-call", id: "c", name: "read", arguments: "{}" } as const;
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield { type: "block-end", index: 0, block };
        yield { type: "finish", reason: { kind: "tool-calls" } };
      } else {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "完成" } };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    },
  };
  let configs = 0;
  const runtime = new LlmRuntime({ mock: adapter });
  const warnings: string[] = [];
  const measurements: boolean[] = [];
  const driver = createModelTurnDriver({
    runtime, toolRegistry: registry,
    config: () => ({ provider: "mock", model: "m", params: { maxOutputTokens: 78000, temperature: changed && ++configs > 1 ? 0.5 : 0.2 } }),
    systemPrompt: () => "system",
    preStep: async (context, operations) => {
      const pressure = operations.measure();
      assert.equal(pressure.status, "measured");
      if (pressure.status === "measured") measurements.push(pressure.triggered);
      await runPreStepPressure(context, operations, reason => warnings.push(reason), 1);
    },
  });
  const agent = new ReActAgent(session, driver, handle);
  store.bindWriter(handle, session, error => agent.blockStorage(error));
  try {
    agent.prompt({ requestId: "new", content: [{ type: "text", text: "读取" }] });
    await agent.waitForIdle();
    assert.deepEqual(measurements, [false, true]);
    assert.equal(requests.length, 2);
    const events = session.snapshot().events;
    assert.equal(events.filter(event => event.type === "compaction/prune").length, 1);
    assert.equal(events.filter(event => event.type === "compaction/start").length, 0);
    const headers = events.filter(event => event.type === "request/header");
    assert.deepEqual(headers.map(event => [event.data.reason, event.data.startsSeries]), [["initial", undefined], changed ? ["change", true] : ["series", undefined]]);
    assert.ok(prefixes[1]!.some(event => event.type === "compaction/prune"));
    for (let index = 0; index < requests.length; index++) {
      const replay = rebuildRequestContext(new Session(session.header, { seed: { kind: "restore", events: prefixes[index]!, inheritedEventCount: 0 } }));
      const request = requests[index]!;
      assert.deepEqual({ systemPrompt: request.systemPrompt, tools: request.tools, messages: request.messages }, replay.input);
      assert.equal(request.effectiveParams.temperature, replay.header.config.temperature);
      assert.equal(request.effectiveParams.maxOutputTokens, replay.header.config.maxTokens);
    }
    assert.deepEqual(warnings, []);
  } finally {
    await agent.stop(); await reader.close(); await handle.close(); await observer.close(); await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
