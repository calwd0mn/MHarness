import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionCommandController } from "../commands.ts";
import { Session, SqliteSessionPersistence } from "@mharness/session/server";
import { createMockAdapter } from "../model/providers/mock.ts";
import { LlmError, type ModelRequest } from "../model/adapter.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { AgentManager } from "./manager.ts";
import { createModelTurnDriver } from "./model-turn.ts";
import { rebuildRequestContext } from "./request-context.ts";

test("SQLite 重开后按每个结算前缀重建真实请求", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-replay-"));
  const path = join(dir, "sessions.sqlite");
  const requests: ModelRequest[] = [];
  const messageArrays: ModelRequest["messages"][] = [];
  const adapter = {
    ...createMockAdapter((request) => {
      requests.push(structuredClone(request));
      messageArrays.push(request.messages);
      return [
        { chunk: { type: "reasoning", delta: "想" } },
        { chunk: { type: "text", delta: "答" } },
        { chunk: { type: "finish", reason: { kind: "stop" } } },
      ];
    }),
    modelInfo: { defaultMaxTokens: 128, supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" },
  };
  const runtime = new LlmRuntime({ mock: adapter });
  let store = new SqliteSessionPersistence(path);
  try {
    const handle = await store.create({ sessionId: "s", createdAt: 1 });
    const session = new Session(handle.header);
    session.append({ type: "user/message", surfaceOp: "append", data: {
      turn: 1, requestId: "r1", id: "u1", role: "user", source: { kind: "user" },
      content: [{ type: "text", text: "原文" }],
    } });
    let config = { provider: "mock", model: "m", params: { temperature: 0.2, stop: ["结束"] } };
    let prompt = "系统一";
    let tools: { name: string; inputSchema: Record<string, unknown> }[] = [{ name: "lookup", inputSchema: { type: "object" } }];
    let persisted = 0;
    let firstCheckpoint = true;
    session.bindCheckpoint(async () => {
      if (firstCheckpoint) {
        config.params.temperature = 0.4;
        tools[0]!.inputSchema.type = "string";
        firstCheckpoint = false;
      }
      const events = session.snapshot().events.slice(persisted);
      await handle.append(events);
      persisted += events.length;
      await handle.flush();
    });
    const drive = createModelTurnDriver({ runtime, config: () => config, systemPrompt: () => prompt, tools: () => tools });
    const run = (turn: number) => drive({
      session, turn, step: 1, signal: new AbortController().signal,
      publish: () => {}, blockStorage: () => assert.fail("检查点失败"),
    });
    await run(1);
    assert.equal(requests[0]?.effectiveParams.temperature, 0.2);
    assert.deepEqual(requests[0]?.tools, [{ name: "lookup", inputSchema: { type: "object" } }]);
    await run(2);
    const headerCount = session.snapshot().events.filter((event) => event.type === "request/header").length;
    assert.equal(headerCount, 2);
    await run(3);
    assert.equal(session.snapshot().events.filter((event) => event.type === "request/header").length, headerCount);
    session.append({ type: "user/message", surfaceOp: { op: "replace", start: 0, end: 0 }, sourceEventSeqs: [0], data: {
      id: "summary", role: "user", source: { kind: "compact", compactionId: "c1" },
      content: [{ type: "text", text: "摘要" }],
    } });
    await run(4);
    const summary = session.snapshot().events.find((event) => event.type === "user/message" && event.data.id === "summary");
    assert.ok(summary);
    session.append({ type: "user/message", surfaceOp: { op: "replace", start: summary.seq, end: summary.seq }, sourceEventSeqs: [summary.seq], data: {
      id: "summary2", role: "user", source: { kind: "compact", compactionId: "c2" },
      content: [{ type: "text", text: "新摘要" }],
    } });
    config = { provider: "mock", model: "m2", params: { temperature: 0.7, stop: ["停止"] } };
    prompt = "系统二";
    tools = [{ name: "search", inputSchema: { type: "object", properties: { q: { type: "string" } } } }];
    await run(5);
    await session.flush();
    await handle.close();
    await store.close();

    store = new SqliteSessionPersistence(path);
    const resumedHandle = await store.open("s", "write");
    assert.ok(resumedHandle);
    const priorEvents = await resumedHandle.read();
    const resumed = new Session(resumedHandle.header, { seed: { kind: "restore", events: priorEvents, inheritedEventCount: 0 } });
    store.bindWriter(resumedHandle, resumed);
    await drive({ session: resumed, turn: 6, step: 1, signal: new AbortController().signal,
      publish: () => {}, blockStorage: () => assert.fail("检查点失败") });
    await resumed.flush();
    await resumedHandle.close();
    const read = await store.open("s", "read");
    assert.ok(read);
    const events = await read.read();
    const settlements = events.filter((event) => event.type === "assistant/message");
    assert.equal(settlements.length, requests.length);
    assert.equal(new Set(messageArrays).size, requests.length);
    assert.deepEqual(events.filter((event) => event.type === "request/header").map((event) => event.data.reason), ["initial", "change", "series", "change", "resume"]);
    const headers = events.filter((event) => event.type === "request/header");
    assert.equal(headers[3]?.data.startsSeries, true);
    const initial = headers[0];
    assert.deepEqual(initial?.data.header.adapterDefaults, { maxTokens: 128, reasoningEffort: "low" });
    const expectedMessages = [
      [{ role: "user", text: "原文" }],
      [{ role: "user", text: "原文" }, { role: "assistant", text: "答" }],
      [{ role: "user", text: "原文" }, { role: "assistant", text: "答" }, { role: "assistant", text: "答" }],
      [{ role: "user", text: "摘要" }, { role: "assistant", text: "答" }, { role: "assistant", text: "答" }, { role: "assistant", text: "答" }],
      [{ role: "user", text: "新摘要" }, { role: "assistant", text: "答" }, { role: "assistant", text: "答" }, { role: "assistant", text: "答" }, { role: "assistant", text: "答" }],
      [{ role: "user", text: "新摘要" }, { role: "assistant", text: "答" }, { role: "assistant", text: "答" }, { role: "assistant", text: "答" }, { role: "assistant", text: "答" }, { role: "assistant", text: "答" }],
    ];
    for (const [index, settlement] of settlements.entries()) {
      const prefix = new Session(read.header, { seed: { kind: "restore", events: events.slice(0, settlement.seq), inheritedEventCount: 0 } });
      const { header, input } = rebuildRequestContext(prefix);
      const request = requests[index];
      assert.ok(request);
      assert.deepEqual(request.messages, expectedMessages[index]);
      assert.deepEqual(input.messages, expectedMessages[index]);
      assert.deepEqual(input, { messages: request.messages, systemPrompt: request.systemPrompt, tools: request.tools });
      assert.deepEqual(request.effectiveParams, {
        temperature: index === 0 ? 0.2 : index < 4 ? 0.4 : 0.7,
        maxOutputTokens: 128, reasoningEffort: "low", stop: index < 4 ? ["结束"] : ["停止"],
      });
      assert.deepEqual(header.config, {
        provider: request.route.provider, model: request.route.model,
        temperature: request.effectiveParams.temperature, maxTokens: request.effectiveParams.maxOutputTokens,
        reasoningEffort: request.effectiveParams.reasoningEffort, stop: request.effectiveParams.stop,
      });
    }
    await read.close();
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("模型调用前已提交的未闭合范围在重开时修复且不续跑", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-crash-"));
  const path = join(dir, "sessions.sqlite");
  const crash = `
    import { Session, SqliteSessionPersistence } from "@mharness/session/server";
    const store = new SqliteSessionPersistence(process.argv[1]);
    const handle = await store.create({ sessionId: "s", createdAt: 1 });
    await handle.flush();
    const session = new Session(handle.header);
    store.bindWriter(handle, session);
    session.append({ type: "turn/start", data: { turn: 1 } });
    session.append({ type: "step/start", data: { turn: 1, step: 1 } });
    session.append({ type: "user/message", surfaceOp: "append", data: {
      turn: 1, requestId: "r", id: "u", role: "user", source: { kind: "user" },
      content: [{ type: "text", text: "待处理" }],
    } });
    session.append({ type: "request/header", data: {
      reason: "initial", header: { config: { provider: "mock", model: "m" }, system: "系统" },
    } });
    await session.flush();
    process.exit(0);
  `;
  await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", crash, path]);
  const store = new SqliteSessionPersistence(path);
  try {
    let calls = 0;
    const manager = new AgentManager(store, async () => { calls++; });
    const agent = await manager.load("s");
    assert.equal(calls, 0);
    assert.deepEqual(agent.session.snapshot().events.slice(-2).map((event) => event.type), ["step/end", "turn/end"]);
    const end = agent.session.snapshot().events.at(-1);
    assert.deepEqual(end?.type === "turn/end" && end.data.reason, { kind: "interrupted" });
    await manager.close();
    const read = await store.open("s", "read");
    assert.ok(read);
    assert.deepEqual((await read.read()).slice(-2).map((event) => event.type), ["step/end", "turn/end"]);
    await read.close();
    assert.equal(calls, 0);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test("SQLite 写入失败阻止模型并保留终态，修复后排空原批次", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-fault-"));
  const path = join(dir, "sessions.sqlite");
  const store = new SqliteSessionPersistence(path);
  const handle = await store.create({ sessionId: "s", createdAt: 1 });
  await handle.flush();
  await handle.close();
  const db = new DatabaseSync(path);
  db.exec("CREATE TRIGGER reject_events BEFORE INSERT ON mh_events BEGIN SELECT RAISE(ABORT, 'private storage detail'); END");
  let calls = 0;
  const runtime = new LlmRuntime({ mock: createMockAdapter(() => { calls++; return []; }) });
  const manager = new AgentManager(store, createModelTurnDriver({ runtime, config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "系统" }));
  const notices: string[] = [];
  manager.onLoaded((agent) => agent.onObservation((notice) => {
    if (notice.type === "agent/error") notices.push(notice.message);
  }));
  try {
    const commands = new SessionCommandController(manager);
    await commands.prompt({ sessionId: "s", requestId: "r", content: [{ type: "text", text: "输入" }] });
    const agent = manager.get("s");
    assert.ok(agent);
    await agent.waitForIdle();
    assert.equal(calls, 0);
    assert.equal(agent.storageOpen, false);
    assert.deepEqual(notices, ["本轮执行失败"]);
    const ends = agent.session.snapshot().events.filter((event) => event.type === "turn/end");
    assert.equal(ends.length, 1);
    assert.deepEqual(ends[0]?.data.reason, { kind: "error", error: { code: "ERR_SQLITE_ERROR", message: "本轮执行失败" } });
    db.exec("DROP TRIGGER reject_events");
    await agent.recoverStorage();
    const read = await store.open("s", "read");
    assert.ok(read);
    assert.deepEqual(await read.read(), agent.session.snapshot().events);
    await read.close();
    assert.equal(calls, 0);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS reject_events");
    db.close();
    await manager.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});







test("取消与截断后保留正式工具配对，重放流不重复派生消息", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-context-"));
  const path = join(dir, "sessions.sqlite");
  let store = new SqliteSessionPersistence(path);
  const created = await store.create({ sessionId: "s", createdAt: 1 });
  await created.flush();
  await created.close();
  const requests: ModelRequest[] = [];
  let now = 1000;
  const realNow = Date.now;
  Date.now = () => now;
  const runtime = new LlmRuntime({ mock: {
    async *generate(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        now = 1002; yield { type: "text", delta: "先" };
        now = 1005; yield { type: "text", delta: "查" };
        now = 1009; yield { type: "reasoning", delta: "想" };
        now = 1014; yield { type: "text", delta: "再查" };
        now = 1020; yield { type: "tool_call", index: 0, callId: "c", name: "lookup", argumentsDelta: "{" };
        now = 1024; yield { type: "tool_call", index: 0, argumentsDelta: "}" };
        now = 1030; yield { type: "finish", reason: { kind: "tool_calls" } };
      } else if (requests.length === 2) {
        yield { type: "text", delta: "截断片段" };
        yield { type: "finish", reason: { kind: "output_limit" } };
      } else if (requests.length === 3) {
        yield { type: "text", delta: "取消片段" };
        throw new LlmError("ABORTED");
      } else if (requests.length === 4) {
        yield { type: "text", delta: "失败片段" };
      } else {
        yield { type: "text", delta: "最终" };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    },
  } });
  const manager = new AgentManager(store, createModelTurnDriver({ runtime, config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "" }));
  try {
    const commands = new SessionCommandController(manager);
    for (let turn = 1; turn <= 5; turn++) {
      await commands.prompt({ sessionId: "s", requestId: `r${turn}`, content: [{ type: "text", text: `问题${turn}` }] });
      const agent = manager.get("s");
      assert.ok(agent);
      await agent.waitForIdle();
    }
    assert.equal(requests.length, 5);
    assert.deepEqual(requests[4]?.messages, [
      { role: "user", text: "问题1" },
      { role: "assistant", text: "先查再查", toolCalls: [{ callId: "c", name: "lookup", arguments: "{}" }] },
      { role: "tool", callId: "c", text: JSON.stringify([{ type: "text", text: "工具尚未派发" }]) },
      { role: "user", text: "问题2" }, { role: "user", text: "问题3" }, { role: "user", text: "问题4" }, { role: "user", text: "问题5" },
    ]);
    await manager.close();
    await store.close();
    store = new SqliteSessionPersistence(path);
    const read = await store.open("s", "read");
    assert.ok(read);
    const events = await read.read();
    const first = events.find((event) => event.type === "assistant/message");
    assert.ok(first);
    const timed = first.data.stream.flatMap((entry) => {
      assert.ok(entry && typeof entry === "object" && !Array.isArray(entry));
      if ("chunks" in entry) {
        assert.ok(Array.isArray(entry.chunks));
        return entry.chunks;
      }
      return [entry];
    });
    assert.deepEqual(timed, [
      { time: 2, chunk: { type: "text", delta: "先" } },
      { time: 5, chunk: { type: "text", delta: "查" } },
      { time: 9, chunk: { type: "reasoning", delta: "想" } },
      { time: 14, chunk: { type: "text", delta: "再查" } },
      { time: 20, chunk: { type: "tool_call", index: 0, callId: "c", name: "lookup", argumentsDelta: "{" } },
      { time: 24, chunk: { type: "tool_call", index: 0, argumentsDelta: "}" } },
      { time: 30, chunk: { type: "finish", reason: { kind: "tool_calls" } } },
    ]);
    const attempts = events.filter((event) => event.type === "assistant/attempt");
    assert.deepEqual(attempts.map((event) => [event.data.outcome, event.data.text, event.data.includeInModelContext]), [
      ["truncated", "截断片段", false], ["cancelled", "取消片段", false], ["failed", undefined, false],
    ]);
    const failedMessages = [
      { role: "user", text: "问题1" },
      { role: "assistant", text: "先查再查", toolCalls: [{ callId: "c", name: "lookup", arguments: "{}" }] },
      { role: "tool", callId: "c", text: JSON.stringify([{ type: "text", text: "工具尚未派发" }]) },
      { role: "user", text: "问题2" }, { role: "user", text: "问题3" }, { role: "user", text: "问题4" },
    ];
    assert.deepEqual(requests[3]?.messages, failedMessages);
    const failed = attempts[2];
    assert.ok(failed);
    const failedPrefix = new Session(read.header, { seed: { kind: "restore", events: events.slice(0, failed.seq), inheritedEventCount: 0 } });
    assert.deepEqual(rebuildRequestContext(failedPrefix).input.messages, failedMessages);
    assert.deepEqual(failed.data.stream, [
      { time: 0, chunk: { type: "text", delta: "失败片段" } },
      { time: 0, chunk: { type: "finish", reason: { kind: "error", failure: { code: "STREAM_CLOSED", message: "Provider stream ended without a finish event" } } } },
    ]);
    assert.deepEqual(attempts[2]?.data.reason, { code: "STREAM_CLOSED", message: "Provider stream ended without a finish event" });
    assert.equal(events.filter((event) => event.type === "assistant/message").length, 2);
    const settlements = events.filter((event) => event.type === "assistant/message" || event.type === "assistant/attempt");
    assert.equal(settlements.length, requests.length);
    for (const [index, settlement] of settlements.entries()) {
      const prefix = new Session(read.header, { seed: { kind: "restore", events: events.slice(0, settlement.seq), inheritedEventCount: 0 } });
      const rebuilt = rebuildRequestContext(prefix);
      const request = requests[index];
      assert.ok(request);
      assert.deepEqual(rebuilt.input, { systemPrompt: request.systemPrompt, messages: request.messages, tools: request.tools });
      assert.deepEqual(rebuilt.header.config, { provider: request.route.provider, model: request.route.model });
      assert.deepEqual(request.effectiveParams, {});
    }
    const last = events.findLast((event) => event.type === "assistant/message");
    assert.ok(last);
    const prefix = new Session(read.header, { seed: { kind: "restore", events: events.slice(0, last.seq), inheritedEventCount: 0 } });
    assert.deepEqual(rebuildRequestContext(prefix).input.messages, requests[4]?.messages);
    await read.close();
  } finally {
    Date.now = realNow;
    await manager.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
