import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { FollowController, type FollowState } from "../../../web/src/session/follow-controller.ts";
import { SqliteSessionPersistence, type SessionHandle } from "@mharness/session/server";
import { AgentManager } from "../agent/manager.ts";
import { createModelTurnDriver } from "../agent/model-turn.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { injectCompactionSqliteFault } from "./compaction-settlement-sqlite-fixture.ts";

for (const mode of ["committed", "rolled-back"] as const) test(`start 未知后按可靠前缀恢复：${mode}`, { timeout: 8000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "compaction-start-recovery-"));
  const path = join(dir, "session.sqlite");
  const store = new SqliteSessionPersistence(path);
  const initial = await store.create({ sessionId: "s", createdAt: 1 });
  await initial.flush(); await initial.close();
  const manager = new AgentManager(store, async () => {});
  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  const reader = await observer.open("s", "read"); assert.ok(reader);
  const agent = await manager.load("s");
  const session = agent.session;
  session.append({ type: "command/run", data: { commandId: "cmd", name: "compact", source: { kind: "user" } } });
  for (const [id, text] of [["old", "旧内容".repeat(2000)], ["tail", "尾部"]] as const) {
    session.append({ type: "user/message", surfaceOp: "append", data: { id, role: "user", source: { kind: "user" }, turn: 1, requestId: id, content: [{ type: "text", text }] } });
  }
  await session.flush();
  const before = session.snapshot();
  const published: string[] = [];
  session.on("session/event", event => published.push(event.type));
  let calls = 0;
  const runtime = new LlmRuntime({ mock: { async *generate() { calls++; yield { type: "finish", reason: { kind: "stop" } }; } } });
  const fault = injectCompactionSqliteFault(t, { path, sessionId: "s", compactionId: "c", kind: "start", firstSeq: 3, mode });
  try {
    const result = await agent.runMaintenance(signal => agent.settleCompaction({ session, signal, turn: null, storageOpen: () => agent.storageOpen, blockStorage: error => agent.blockStorage(error), identity: { compactionId: "c", sourceCommandId: "cmd" } }, { runtime, businessModel: runtime.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 }));
    assert.equal(result.status, "unsettled");
    const durable = await reader.read();
    assert.equal(durable.filter(event => event.type === "compaction/start").length, mode === "committed" ? 1 : 0);
    assert.deepEqual(session.snapshot().events.slice(0, -1), before.events);
    assert.equal(session.snapshot().events.at(-1)?.type, "compaction/start");
    await assert.rejects(agent.recoverStorage());
    assert.deepEqual(await reader.read(), durable);
    assert.deepEqual(session.snapshot().events.slice(0, -1), before.events);
    assert.equal(session.snapshot().events.at(-1)?.type, "compaction/start");
    assert.deepEqual(published, ["compaction/start"]);
    assert.equal(agent.storageOpen, false);
    assert.throws(() => agent.prompt({ requestId: "blocked", content: [{ type: "text", text: "x" }] }), { code: "storage_blocked" });
    await assert.rejects(agent.runMaintenance(async () => {}), { code: "storage_blocked" });
    assert.equal(calls, 0);
    fault.release();
    await agent.recoverStorage();
    const events = await reader.read();
    assert.deepEqual(events, session.snapshot().events);
    const starts = events.filter(event => event.type === "compaction/start");
    const ends = events.filter(event => event.type === "compaction/end");
    const done = events.filter(event => event.type === "command/done");
    assert.equal(starts.length, 1);
    assert.equal(ends.length, 1);
    assert.equal(ends[0]?.data.status, "interrupted");
    assert.deepEqual(ends[0]?.data.reason, { kind: "process_interrupted" });
    assert.ok(starts[0]!.seq < ends[0]!.seq && ends[0]!.seq < done[0]!.seq);
    assert.equal(done.length, 1);
    assert.equal(done[0]?.data.kind, "error");
    assert.equal(events.filter(event => event.type === "compaction/summary").length, 0);
    assert.equal(published.filter(type => type === "command/done").length, 1);
    assert.equal(fault.targetCommits, mode === "committed" ? 1 : 2);
    assert.deepEqual(published, ["compaction/start", "compaction/end", "command/done"]);
    assert.equal(agent.storageOpen, true);
    await agent.recoverStorage();
    assert.deepEqual(await reader.read(), events);
    assert.equal(calls, 0);
  } finally {
    fault.restore(); await reader.close(); await observer.close(); await manager.close(); await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("取消终态回滚后重试已发布终态并仅修复一次", { timeout: 8000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "compaction-cancel-recovery-"));
  const path = join(dir, "session.sqlite");
  const store = new SqliteSessionPersistence(path);
  const initial = await store.create({ sessionId: "s", createdAt: 1 }); await initial.flush(); await initial.close();
  const manager = new AgentManager(store, async () => {});
  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  const reader = await observer.open("s", "read"); assert.ok(reader);
  const agent = await manager.load("s"); const session = agent.session;
  session.append({ type: "command/run", data: { commandId: "cmd", name: "compact", source: { kind: "user" } } });
  for (const [id, text] of [["old", "旧内容".repeat(2000)], ["tail", "尾部"]] as const) {
    session.append({ type: "user/message", surfaceOp: "append", data: { id, role: "user", source: { kind: "user" }, turn: 1, requestId: id, content: [{ type: "text", text }] } });
  }
  await session.flush();
  let original: unknown;
  let calls = 0;
  const runtime = new LlmRuntime({ mock: { async *generate() { calls++; yield { type: "finish", reason: { kind: "stop" } }; } } });
  const published: string[] = [];
  session.on("session/event", event => published.push(event.type));
  const fault = injectCompactionSqliteFault(t, { path, sessionId: "s", compactionId: "c", kind: "end", firstSeq: 4, mode: "rolled-back" });
  try {
    const result = await agent.runMaintenance(signal => {
      session.on("session/event", event => { if (event.type === "compaction/start") { agent.cancel(); original = signal.reason; } });
      return agent.settleCompaction({ session, signal, turn: null, storageOpen: () => agent.storageOpen, blockStorage: error => agent.blockStorage(error), identity: { compactionId: "c", sourceCommandId: "cmd" } }, { runtime, businessModel: runtime.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 });
    });
    assert.equal(result.status, "unsettled");
    assert.equal(result.intent, undefined);
    assert.deepEqual(result.original, { present: true, value: original });
    await assert.rejects(agent.recoverStorage());
    assert.equal((await reader.read()).filter(event => event.type === "compaction/end" || event.type === "command/done").length, 0);
    const accepted = session.snapshot().events.at(-1);
    assert.ok(accepted?.type === "compaction/end" && accepted.data.status === "cancelled");
    fault.release(); await agent.recoverStorage();
    const events = await reader.read();
    const ends = events.filter(event => event.type === "compaction/end");
    const done = events.filter(event => event.type === "command/done");
    assert.equal(ends.length, 1); assert.equal(ends[0]?.data.status, "cancelled");
    assert.deepEqual(ends, [accepted]);
    assert.equal(done.length, 1); assert.equal(done[0]?.data.kind, "error");
    assert.ok(ends[0]!.seq < done[0]!.seq);
    assert.equal(events.filter(event => event.type === "compaction/summary").length, 0);
    assert.equal(published.filter(type => type === "compaction/end").length, 1);
    assert.equal(published.filter(type => type === "command/done").length, 1);
    assert.equal(fault.targetCommits, 2); assert.equal(calls, 0);
    await agent.recoverStorage(); assert.deepEqual(await reader.read(), events);
  } finally {
    fault.restore(); await reader.close(); await observer.close(); await manager.close(); await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const mode of ["committed", "rolled-back"] as const) test(`在线恢复采用原终态：${mode}`, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "compaction-recovery-"));
  const path = join(dir, "session.sqlite");
  const store = new SqliteSessionPersistence(path);
  const initial = await store.create({ sessionId: "s", createdAt: 1 });
  await initial.flush(); await initial.close();
  const manager = new AgentManager(store, async () => {});
  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  const reader = await observer.open("s", "read"); assert.ok(reader);
  const agent = await manager.load("s");
  const session = agent.session;
  session.append({ type: "command/run", data: { commandId: "cmd", name: "compact", source: { kind: "user" } } });
  for (const [id, text] of [["old", "旧内容".repeat(2000)], ["tail", "尾部"]] as const) {
    session.append({ type: "user/message", surfaceOp: "append", data: { id, role: "user", source: { kind: "user" }, turn: 1, requestId: id, content: [{ type: "text", text }] } });
  }
  await session.flush();
  let calls = 0;
  const runtime = new LlmRuntime({ mock: { async *generate() { calls++; throw new Error("模型失败"); } } });
  const fault = injectCompactionSqliteFault(t, { path, sessionId: "s", compactionId: "c", kind: "end", firstSeq: 4, mode });
  const published: string[] = [];
  session.on("session/event", (event) => published.push(event.type));
  try {
    const result = await agent.runMaintenance((signal) => agent.settleCompaction({ session, signal, turn: null, storageOpen: () => agent.storageOpen, blockStorage: (error) => agent.blockStorage(error), identity: { compactionId: "c", sourceCommandId: "cmd" } }, { runtime, businessModel: runtime.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 }));
    assert.equal(result.status, "unsettled");
    assert.equal(result.intent, undefined);
    assert.equal(agent.storageOpen, false);
    assert.equal((await reader.read()).filter(e => e.type === "command/done").length, 0);
    await assert.rejects(agent.recoverStorage());
    assert.equal(agent.storageOpen, false);
    const accepted = session.snapshot().events.at(-1);
    assert.ok(accepted?.type === "compaction/end" && accepted.data.status === "failed");
    fault.release();
    await agent.recoverStorage();
    assert.equal(agent.storageOpen, true);
    const events = await reader.read();
    const ends = events.filter(e => e.type === "compaction/end");
    assert.equal(ends.length, 1);
    assert.equal(ends[0]?.data.status, "failed");
    assert.deepEqual(ends, [accepted]);
    assert.equal(events.filter(e => e.type === "command/done").length, 1);
    assert.equal(published.filter(type => type === "compaction/end").length, 1);
    assert.equal(fault.targetCommits, mode === "committed" ? 1 : 2);
    assert.equal(calls, 1);
    await agent.recoverStorage();
    assert.deepEqual(await reader.read(), events);
  } finally {
    fault.restore(); await reader.close(); await observer.close(); await manager.close(); await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("成功批次未知后迟到取消，恢复采用原提交并补命令结果", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "compaction-late-cancel-"));
  const path = join(dir, "session.sqlite");
  const store = new SqliteSessionPersistence(path);
  const initial = await store.create({ sessionId: "s", createdAt: 1 }); await initial.flush(); await initial.close();
  const manager = new AgentManager(store, async () => {});
  const agent = await manager.load("s"); const session = agent.session;
  session.append({ type: "command/run", data: { commandId: "cmd", name: "compact", source: { kind: "user" } } });
  for (const [id, text] of [["old", "旧内容".repeat(2000)], ["tail", "尾部"]] as const) {
    session.append({ type: "user/message", surfaceOp: "append", data: { id, role: "user", source: { kind: "user" }, turn: 1, requestId: id, content: [{ type: "text", text }] } });
  }
  await session.flush();
  let calls = 0; let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = new LlmRuntime({ mock: { async *generate() { calls++; yield { type: "block-start", index: 0, blockType: "text" }; yield { type: "block-end", index: 0, block: { type: "text", text: "摘要" } }; yield { type: "finish", reason: { kind: "stop" } }; } } });
  const fault = injectCompactionSqliteFault(t, { path, sessionId: "s", compactionId: "c", kind: "success", firstSeq: 4, mode: "committed" });
  try {
    const task = agent.runMaintenance(async signal => {
      const result = await agent.settleCompaction({ session, signal, turn: null, storageOpen: () => agent.storageOpen, blockStorage: error => agent.blockStorage(error), identity: { compactionId: "c", sourceCommandId: "cmd" } }, { runtime, businessModel: runtime.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 });
      await gate; return result;
    });
    await fault.entered; agent.cancel();
    await assert.rejects(agent.recoverStorage());
    release(); const result = await task; assert.equal(result.status, "unsettled");
    assert.equal(session.snapshot().events.filter(e => e.type === "command/done").length, 0);
    await assert.rejects(agent.recoverStorage());
    fault.release(); await agent.recoverStorage();
    const events = session.snapshot().events;
    const end = events.find(e => e.type === "compaction/end");
    const summary = events.find(e => e.type === "compaction/summary");
    const done = events.find(e => e.type === "command/done");
    assert.equal(end?.data.status, "succeeded");
    assert.equal(done?.data.kind, "success");
    assert.equal(done?.data.sourceEventSeq, summary?.seq);
    assert.equal(fault.targetCommits, 1); assert.equal(calls, 1);
  } finally { release(); fault.restore(); await manager.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("恢复期间新的存储故障阻止修复并保留首次原因", async () => {
  const dir = await mkdtemp(join(tmpdir(), "compaction-generation-"));
  const store = new SqliteSessionPersistence(join(dir, "session.sqlite"));
  const initial = await store.create({ sessionId: "s", createdAt: 1 }); await initial.flush(); await initial.close();
  let pause = false; let entered = () => {}; let release = () => {};
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originals = new WeakMap<SessionHandle, SessionHandle>();
  const manager = new AgentManager({
    create: (...args) => store.create(...args),
    bindWriter: (handle, session, report) => store.bindWriter(originals.get(handle) ?? handle, session, report),
    async open(...args) {
      const handle = await store.open(...args);
      if (!handle) return handle;
      const proxy = new Proxy(handle, { get(target, key) {
        if (key === "read") return async (...readArgs: Parameters<typeof target.read>) => {
          if (pause) { pause = false; entered(); await gate; }
          return target.read(...readArgs);
        };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      originals.set(proxy, handle);
      return proxy;
    },
  }, async () => {});
  try {
    const agent = await manager.load("s");
    agent.session.append({ type: "command/run", data: { commandId: "cmd", name: "compact", source: { kind: "user" } } });
    await agent.session.flush();
    const first = new Error("首次故障"); agent.blockStorage(first);
    pause = true;
    const recovery = agent.recoverStorage();
    assert.equal(agent.recoverStorage(), recovery);
    await reached;
    await assert.rejects(agent.runMaintenance(async () => {}), { code: "storage_blocked", cause: first });
    agent.blockStorage(new Error("后续故障"));
    release(); await assert.rejects(recovery, /状态已变更/);
    assert.equal(agent.storageOpen, false);
    assert.equal(agent.session.snapshot().events.filter(e => e.type === "command/done").length, 0);
    await assert.rejects(agent.runMaintenance(async () => {}), { code: "storage_blocked", cause: first });
    await agent.recoverStorage();
    assert.equal(agent.session.snapshot().events.filter(e => e.type === "command/done").length, 1);
  } finally { release(); await manager.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("最终可靠前缀读取失败时保持关门，重试不重复修复", { timeout: 8000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "compaction-final-read-"));
  const path = join(dir, "session.sqlite");
  const store = new SqliteSessionPersistence(path);
  const initial = await store.create({ sessionId: "s", createdAt: 1 }); await initial.flush(); await initial.close();
  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  const reader = await observer.open("s", "read"); assert.ok(reader);
  const originals = new WeakMap<SessionHandle, SessionHandle>();
  let armed = false; let reads = 0;
  const failure = new Error("最终可靠读取失败");
  const manager = new AgentManager({
    create: (...args) => store.create(...args),
    bindWriter: (handle, session, report) => store.bindWriter(originals.get(handle) ?? handle, session, report),
    async open(...args) {
      const handle = await store.open(...args);
      if (!handle) return handle;
      const proxy = new Proxy(handle, { get(target, key) {
        if (key === "read") return async (...readArgs: Parameters<typeof target.read>) => {
          if (armed && ++reads === 2) throw failure;
          return target.read(...readArgs);
        };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      originals.set(proxy, handle); return proxy;
    },
  }, async () => {});
  try {
    const agent = await manager.load("s");
    agent.session.append({ type: "command/run", data: { commandId: "cmd", name: "compact", source: { kind: "user" } } });
    await agent.session.flush();
    const published: string[] = [];
    agent.session.on("session/event", event => published.push(event.type));
    agent.blockStorage(new Error("原始故障")); armed = true;
    await assert.rejects(agent.recoverStorage(), error => error === failure);
    assert.equal(reads, 2); assert.equal(agent.storageOpen, false);
    const repaired = await reader.read();
    assert.deepEqual(repaired, agent.session.snapshot().events);
    assert.equal(repaired.filter(event => event.type === "command/done").length, 1);
    assert.equal(published.filter(type => type === "command/done").length, 1);
    await assert.rejects(agent.runMaintenance(async () => {}), { code: "storage_blocked" });
    armed = false; await agent.recoverStorage();
    assert.equal(agent.storageOpen, true);
    assert.deepEqual(await reader.read(), repaired);
    assert.equal(published.filter(type => type === "command/done").length, 1);
  } finally {
    await reader.close(); await observer.close(); await manager.close(); await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("真实 Turn 的外部门关闭后由恢复关闭 Turn", { timeout: 8000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "compaction-turn-recovery-"));
  const path = join(dir, "session.sqlite");
  const store = new SqliteSessionPersistence(path);
  const initial = await store.create({ sessionId: "s", createdAt: 1 }); await initial.flush(); await initial.close();
  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  const reader = await observer.open("s", "read"); assert.ok(reader);
  let entered!: () => void; let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let businessCalls = 0; let summaryCalls = 0;
  const business = new LlmRuntime({ mock: { async *generate() { businessCalls++; yield { type: "finish", reason: { kind: "stop" } }; } } });
  const summary = new LlmRuntime({ mock: { async *generate() { summaryCalls++; entered(); await gate; yield { type: "block-start", index: 0, blockType: "text" }; yield { type: "block-end", index: 0, block: { type: "text", text: "摘要" } }; yield { type: "finish", reason: { kind: "stop" } }; } } });
  const driver = createModelTurnDriver({ runtime: business, config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", preStep: async context => {
    const agent = manager.get("s"); assert.ok(agent);
    const result = await agent.settleCompaction(context, { runtime: summary, businessModel: summary.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 });
    assert.equal(result.status, "unsettled");
    await context.session.flush();
  } });
  const manager = new AgentManager(store, driver);
  try {
    const agent = await manager.load("s");
    agent.session.append({ type: "user/message", surfaceOp: "append", data: { id: "old", role: "user", source: { kind: "user" }, turn: 77, requestId: "old", content: [{ type: "text", text: "旧内容".repeat(2000) }] } });
    await agent.session.flush();
    agent.prompt({ requestId: "r", content: [{ type: "text", text: "尾部" }] });
    const enteredModel = await Promise.race([reached.then(() => true), agent.waitForIdle().then(() => false)]);
    assert.equal(enteredModel, true, "Turn 提前退出，未进入摘要模型");
    agent.blockStorage(new Error("外部存储故障")); release();
    await agent.waitForIdle();
    const before = await reader.read();
    assert.equal(before.filter(event => event.type === "compaction/start").length, 1);
    assert.equal(before.filter(event => event.type === "turn/end" || event.type === "step/start" || event.type === "step/end").length, 0);
    assert.equal(businessCalls, 0); assert.equal(summaryCalls, 1);
    assert.equal(agent.storageOpen, false);
    await agent.recoverStorage();
    const repaired = await reader.read();
    assert.deepEqual(repaired, agent.session.snapshot().events);
    assert.equal(repaired.filter(event => event.type === "compaction/end").length, 1);
    assert.equal(repaired.filter(event => event.type === "turn/end").length, 1);
    assert.equal(repaired.filter(event => event.type === "step/start" || event.type === "step/end").length, 0);
    assert.equal(businessCalls, 0); assert.equal(summaryCalls, 1);
    await agent.recoverStorage(); assert.deepEqual(await reader.read(), repaired);
  } finally {
    release(); await reader.close(); await observer.close(); await manager.close(); await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("恢复先清除实时草稿再交付 Turn 终态", async () => {
  const dir = await mkdtemp(join(tmpdir(), "compaction-recovery-follow-"));
  const store = new SqliteSessionPersistence(join(dir, "session.sqlite"));
  const manager = new AgentManager(store, async ({ session, turn, step, publish, blockStorage }) => {
    session.append({ type: "step/start", data: { turn, step } });
    session.append({ type: "compaction/start", data: { compactionId: "unfinished", turn } });
    publish({ type: "assistant/start", attemptId: "draft", turn, step });
    blockStorage(new Error("旧存储故障"));
  });
  try {
    const initial = await store.create({ sessionId: "s", createdAt: 1 });
    await initial.flush();
    await initial.close();
    const agent = await manager.load("s");
    agent.prompt({ requestId: "r", content: [{ type: "text", text: "遗留草稿" }] });
    await agent.waitForIdle();
    const states: FollowState[] = [];
    const controller = new FollowController({
      connect(_id, callbacks) {
        const close = agent.onObservation(notice => callbacks.frame(notice));
        callbacks.frame({ type: "snapshot", ...agent.snapshot() });
        return { close };
      },
      onState: state => states.push(state),
      retryDelays: [],
    });
    try {
      controller.select("s");
      await setImmediate();
      assert.equal(states.at(-1)?.draft?.attemptId, "draft");
      await agent.recoverStorage();
      await setImmediate();
      const repaired = states.at(-1);
      assert.equal(repaired?.status, "ready");
      assert.equal(repaired.draft, undefined);
      assert.equal(repaired.records.at(-1)?.event.type, "turn/end");
      assert.equal(agent.storageOpen, true);
    } finally { controller.dispose(); }
  } finally {
    await manager.close(); await store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("发布遗留草稿结束时报告新故障，恢复仍不开放准入", async () => {
  const dir = await mkdtemp(join(tmpdir(), "compaction-recovery-notice-"));
  const store = new SqliteSessionPersistence(join(dir, "session.sqlite"));
  const first = new Error("首次存储故障");
  const manager = new AgentManager(store, async ({ turn, step, publish, blockStorage }) => {
    publish({ type: "assistant/start", attemptId: "a", turn, step });
    blockStorage(first);
  });
  try {
    const initial = await store.create({ sessionId: "s", createdAt: 1 }); await initial.flush(); await initial.close();
    const agent = await manager.load("s");
    agent.prompt({ requestId: "r", content: [{ type: "text", text: "恢复前遗留草稿" }] });
    await agent.waitForIdle();
    let observed = 0;
    const unsubscribe = agent.onObservation(notice => {
      if (notice.type === "assistant-stream" && notice.frame.type === "end") {
        observed++;
        agent.blockStorage(new Error("恢复通知期间发生新故障"));
      }
    });
    try {
      await assert.rejects(agent.recoverStorage(), /恢复期间会话状态已变更/);
      assert.equal(observed, 1);
      assert.equal(agent.storageOpen, false);
      await assert.rejects(agent.runMaintenance(async () => {}), { code: "storage_blocked", cause: first });
      await agent.recoverStorage();
      assert.equal(agent.storageOpen, true);
      assert.equal(observed, 1);
    } finally { unsubscribe(); }
  } finally { await manager.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});
