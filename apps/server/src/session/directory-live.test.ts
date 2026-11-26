import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteSessionPersistence } from "@mharness/session/server";
import { AgentManager } from "../agent/manager.ts";
import { createModelTurnDriver } from "../agent/model-turn.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { SessionDirectory } from "./directory.ts";

test("真实 Agent 在首次 Turn 和收尾时同步更新目录", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-live-"));
  const path = join(dir, "events.sqlite");
  const storage = new SqliteSessionPersistence(path);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const manager = new AgentManager(storage, async () => { await gate; });
  t.after(async () => { finish(); await manager.close(); await storage.close(); await rm(dir, { recursive: true, force: true }); });
  const writer = await storage.create({ sessionId: "live", createdAt: 1 });
  await writer.flush();
  await writer.close();
  const directory = await SessionDirectory.restore(storage);
  const notices: unknown[] = [];
  directory.onObservation(notice => notices.push(notice));
  manager.onLoaded(agent => directory.observeAgent(agent));
  const agent = await manager.load("live");
  agent.prompt({ requestId: "r1", content: [{ type: "text", text: "hello" }] });
  assert.deepEqual(notices.slice(0, 2), [
    { type: "api-session/status", sessionId: "live", running: true, revision: 1 },
    { type: "api-session/updated", sessionId: "live", blank: false, seq: 0, revision: 2 },
  ]);
  assert.equal((await storage.stat("live"))?.eventCount, 0);
  assert.equal(directory.snapshot().sessions[0]?.blank, false);
  const before = directory.snapshot().revision;
  finish();
  await agent.waitForIdle();
  assert.deepEqual(notices.at(-1), { type: "api-session/status", sessionId: "live", running: false, revision: before + 1 });
});



test("批次逐条发布首次 Turn 与真实用户活动并忽略不推进时间的事件", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-batch-"));
  const storage = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const manager = new AgentManager(storage, async () => {});
  t.after(async () => { await manager.close(); await storage.close(); await rm(dir, { recursive: true, force: true }); });
  const writer = await storage.create({ sessionId: "batch", createdAt: 100 });
  await writer.flush(); await writer.close();
  const directory = await SessionDirectory.restore(storage);
  manager.onLoaded(agent => directory.observeAgent(agent));
  const agent = await manager.load("batch");
  const observed: { notice: unknown; updatedAt: number | undefined }[] = [];
  directory.onObservation(notice => observed.push({ notice, updatedAt: directory.snapshot().sessions[0]?.updatedAt }));
  agent.session.appendBatch(() => [
    { type: "turn/start", time: 110, data: { turn: 1 } },
    { type: "user/message", time: 120, surfaceOp: "append", data: { turn: 1, requestId: "a", id: "a", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "a" }] } },
    { type: "user/message", time: 119, surfaceOp: "append", data: { turn: 1, requestId: "b", id: "b", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "b" }] } },
    { type: "user/message", time: 120, surfaceOp: "append", data: { turn: 1, requestId: "c", id: "c", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "c" }] } },
    { type: "turn/start", time: 130, data: { turn: 2 } },
  ]);
  assert.deepEqual(observed, [
    { notice: { type: "api-session/updated", sessionId: "batch", blank: false, seq: 0, revision: 1 }, updatedAt: 100 },
    { notice: { type: "api-session/activity", sessionId: "batch", updatedAt: 120, revision: 2 }, updatedAt: 120 },
  ]);
  assert.equal((await directory.query(storage, id => manager.get(id))).revision, 2);
});

test("公开错误先于退出运行，维护和停止保持目录状态准确", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-error-"));
  const storage = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  let finish!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const manager = new AgentManager(storage, async context => { context.publish({ type: "agent/error", turn: context.turn, message: "公开错误" }); entered(); await gate; });
  t.after(async () => { finish(); await manager.close(); await storage.close(); await rm(dir, { recursive: true, force: true }); });
  const writer = await storage.create({ sessionId: "error", createdAt: 1 });
  await writer.flush(); await writer.close();
  const directory = await SessionDirectory.restore(storage);
  manager.onLoaded(agent => directory.observeAgent(agent));
  const agent = await manager.load("error");
  const notices: unknown[] = [];
  directory.onObservation(notice => notices.push(notice));
  await agent.runMaintenance(async () => {});
  assert.equal(directory.snapshot().revision, 0);
  agent.prompt({ requestId: "r", content: [{ type: "text", text: "hello" }] });
  await reached;
  const before = directory.snapshot().revision;
  assert.deepEqual(notices.at(-1), { type: "api-session/error", sessionId: "error", message: "公开错误" });
  assert.equal(directory.snapshot().sessions[0]?.running, true);
  const stopping = manager.close();
  finish(); await stopping;
  assert.deepEqual(notices.at(-1), { type: "api-session/status", sessionId: "error", running: false, revision: before + 1 });
});

test("运行状态监听器同步停止时等待驱动退出", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-reentrant-"));
  const storage = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let signal: AbortSignal | undefined;
  const manager = new AgentManager(storage, async context => { signal = context.signal; await gate; });
  t.after(async () => { finish(); await manager.close(); await storage.close(); await rm(dir, { recursive: true, force: true }); });
  const writer = await storage.create({ sessionId: "stop", createdAt: 1 });
  await writer.flush(); await writer.close();
  const agent = await manager.load("stop");
  let stopped = false;
  let stopping: Promise<void> | undefined;
  agent.onStateChange(state => { if (state === "running") stopping = agent.stop().then(() => { stopped = true; }); });
  agent.prompt({ requestId: "r", content: [{ type: "text", text: "hello" }] });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(signal?.aborted, true);
  assert.equal(stopped, false);
  finish(); await stopping;
  assert.equal(stopped, true);
});

test("目录重入通知保持各监听器版本顺序，idle 发布期间拒绝新任务", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-order-"));
  const storage = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const manager = new AgentManager(storage, async () => {});
  t.after(async () => { await manager.close(); await storage.close(); await rm(dir, { recursive: true, force: true }); });
  for (const sessionId of ["a", "b"]) { const writer = await storage.create({ sessionId, createdAt: 1 }); await writer.flush(); await writer.close(); }
  const directory = await SessionDirectory.restore(storage);
  const a = await manager.load("a");
  const b = await manager.load("b");
  let rejected = false;
  a.onStateChange(state => { if (state === "idle") { try { a.prompt({ requestId: "again", content: [{ type: "text", text: "x" }] }); } catch { rejected = true; } } });
  directory.observeAgent(a); directory.observeAgent(b);
  let triggered = false;
  directory.onObservation(frame => { if (!triggered && frame.type === "api-session/status" && frame.sessionId === "a" && frame.running) { triggered = true; b.prompt({ requestId: "b", content: [{ type: "text", text: "b" }] }); } });
  const revisions: number[] = [];
  directory.onObservation(frame => { if ("revision" in frame) revisions.push(frame.revision); });
  a.prompt({ requestId: "a", content: [{ type: "text", text: "a" }] });
  await Promise.all([a.waitForIdle(), b.waitForIdle()]);
  assert.deepEqual(revisions, [...revisions].sort((x, y) => x - y));
  assert.equal(rejected, true);
});

test("失败终态和驱动拒绝只发送目录错误，不改变聊天错误通知", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-failure-"));
  const storage = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const manager = new AgentManager(storage, async context => {
    if (context.session.header.sessionId === "reject") throw new Error("secret");
    context.session.append({ type: "turn/end", data: { turn: context.turn, reason: { kind: "error", error: { code: "UNKNOWN", message: "secret" } } } });
  });
  t.after(async () => { await manager.close(); await storage.close(); await rm(dir, { recursive: true, force: true }); });
  for (const sessionId of ["end", "reject"]) { const writer = await storage.create({ sessionId, createdAt: 1 }); await writer.flush(); await writer.close(); }
  const directory = await SessionDirectory.restore(storage);
  manager.onLoaded(agent => directory.observeAgent(agent));
  const notices: { type: string; sessionId?: string; message?: string }[] = [];
  directory.onObservation(frame => notices.push(frame));
  for (const sessionId of ["end", "reject"]) {
    const agent = await manager.load(sessionId);
    const chat: string[] = [];
    agent.onObservation(frame => { if (frame.type === "agent/error") chat.push(frame.message); });
    agent.prompt({ requestId: "r", content: [{ type: "text", text: "x" }] });
    await agent.waitForIdle();
    assert.deepEqual(chat, []);
    const errors = notices.filter(frame => frame.type === "api-session/error" && frame.sessionId === sessionId);
    assert.deepEqual(errors, [{ type: "api-session/error", sessionId, message: "本轮执行失败" }]);
    assert.equal(notices.at(-1)?.type, "api-session/status");
  }
});

test("清单读取期间通知后 Agent 释放则重读清单", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-query-release-"));
  const storage = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const manager = new AgentManager(storage, async context => { context.session.append({ type: "turn/end", data: { turn: context.turn, reason: { kind: "completed" } } }); });
  t.after(async () => { await manager.close(); await storage.close(); await rm(dir, { recursive: true, force: true }); });
  const writer = await storage.create({ sessionId: "query", createdAt: 1 }); await writer.flush(); await writer.close();
  const directory = await SessionDirectory.restore(storage);
  manager.onLoaded(agent => directory.observeAgent(agent));
  const agent = await manager.load("query");
  let release!: () => void; let captured!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { captured = resolve; });
  let calls = 0; let online = true;
  const query = directory.query({ list: async () => { calls++; const records = await storage.list(); if (calls === 1) { captured(); await gate; } return records; } }, id => online ? manager.get(id) : undefined);
  await reached;
  agent.prompt({ requestId: "r", content: [{ type: "text", text: "x" }] });
  await agent.waitForIdle(); await manager.close(); online = false; release();
  const snapshot = await query;
  assert.equal(calls, 2);
  assert.equal(snapshot.sessions[0]?.blank, false);
  assert.equal(snapshot.revision, directory.snapshot().revision);
});


test("真实模型流缺少 finish 只产生一次目录错误，成功不产生错误", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-model-"));
  const storage = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const runtime = new LlmRuntime({ mock: { async *generate(request) {
    if (request.route.model === "success") {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "ok" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "ok" } };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  } } });
  let model = "missing";
  const manager = new AgentManager(storage, createModelTurnDriver({ runtime, config: () => ({ provider: "mock", model }), systemPrompt: () => "" }));
  t.after(async () => { await manager.close(); await storage.close(); await rm(dir, { recursive: true, force: true }); });
  const writer = await storage.create({ sessionId: "model", createdAt: 1 }); await writer.flush(); await writer.close();
  const directory = await SessionDirectory.restore(storage);
  manager.onLoaded(agent => directory.observeAgent(agent));
  const agent = await manager.load("model");
  const notices: string[] = [];
  const chat: string[] = [];
  directory.onObservation(frame => { if (frame.type === "api-session/error") notices.push(frame.message); });
  agent.onObservation(frame => { if (frame.type === "agent/error") chat.push(frame.message); });
  agent.prompt({ requestId: "missing", content: [{ type: "text", text: "x" }] });
  await agent.waitForIdle();
  assert.deepEqual(notices, ["本轮执行失败"]);
  assert.deepEqual(chat, []);
  model = "success";
  agent.prompt({ requestId: "success", content: [{ type: "text", text: "x" }] });
  await agent.waitForIdle();
  assert.deepEqual(notices, ["本轮执行失败"]);
});

test("取消驱动不产生目录错误", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-cancel-"));
  const storage = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const manager = new AgentManager(storage, async context => {
    await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new DOMException("cancelled", "AbortError");
  });
  t.after(async () => { await manager.close(); await storage.close(); await rm(dir, { recursive: true, force: true }); });
  const writer = await storage.create({ sessionId: "cancel", createdAt: 1 }); await writer.flush(); await writer.close();
  const directory = await SessionDirectory.restore(storage);
  manager.onLoaded(agent => directory.observeAgent(agent));
  const agent = await manager.load("cancel");
  const errors: unknown[] = [];
  directory.onObservation(frame => { if (frame.type === "api-session/error") errors.push(frame); });
  agent.prompt({ requestId: "r", content: [{ type: "text", text: "x" }] });
  await Promise.resolve();
  agent.cancel(); await agent.waitForIdle();
  assert.deepEqual(errors, []);
});

test("第二次清单读取期间再次离线变化时有界合并", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-query-twice-"));
  const storage = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const manager = new AgentManager(storage, async context => { context.session.append({ type: "turn/end", data: { turn: context.turn, reason: { kind: "completed" } } }); });
  t.after(async () => { await manager.close(); await storage.close(); await rm(dir, { recursive: true, force: true }); });
  for (const sessionId of ["first", "second"]) { const writer = await storage.create({ sessionId, createdAt: 1 }); await writer.flush(); await writer.close(); }
  const directory = await SessionDirectory.restore(storage);
  manager.onLoaded(agent => directory.observeAgent(agent));
  const first = await manager.load("first"); const second = await manager.load("second");
  let releaseFirst!: () => void; let releaseSecond!: () => void;
  let enteredFirst!: () => void; let enteredSecond!: () => void;
  const gates = [new Promise<void>(resolve => { releaseFirst = resolve; }), new Promise<void>(resolve => { releaseSecond = resolve; })];
  const reached = [new Promise<void>(resolve => { enteredFirst = resolve; }), new Promise<void>(resolve => { enteredSecond = resolve; })];
  const online = new Set(["first", "second"]); let calls = 0;
  const query = directory.query({ list: async () => {
    const index = calls++; const records = await storage.list();
    if (index === 0) enteredFirst(); else if (index === 1) enteredSecond();
    if (index < gates.length) await gates[index];
    return records;
  } }, id => online.has(id) ? manager.get(id) : undefined);
  await reached[0];
  first.prompt({ requestId: "a", content: [{ type: "text", text: "a" }] }); await first.waitForIdle(); await first.stop(); online.delete("first"); releaseFirst();
  await reached[1];
  second.prompt({ requestId: "b", content: [{ type: "text", text: "b" }] }); await second.waitForIdle(); await second.stop(); online.delete("second"); releaseSecond();
  const result = await query;
  assert.equal(calls, 2);
  assert.equal(result.revision, directory.snapshot().revision);
  assert.deepEqual(result.sessions.map(item => item.blank), [false, false]);
});

test("取消与已标记存储故障并发时仍通知目录错误", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-cancel-storage-"));
  const storage = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const manager = new AgentManager(storage, async context => {
    await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    context.blockStorage(new Error("private storage failure"));
    throw new Error("private hook failure");
  });
  t.after(async () => { await manager.close(); await storage.close(); await rm(dir, { recursive: true, force: true }); });
  const writer = await storage.create({ sessionId: "storage", createdAt: 1 }); await writer.flush(); await writer.close();
  const directory = await SessionDirectory.restore(storage); manager.onLoaded(agent => directory.observeAgent(agent));
  const agent = await manager.load("storage");
  const frames: unknown[] = []; const chat: unknown[] = [];
  directory.onObservation(frame => frames.push(frame));
  agent.onObservation(frame => { if (frame.type === "agent/error") chat.push(frame); });
  agent.prompt({ requestId: "r", content: [{ type: "text", text: "x" }] });
  await Promise.resolve(); agent.cancel(); await agent.waitForIdle();
  assert.deepEqual(frames.filter(frame => typeof frame === "object" && frame !== null && "type" in frame && frame.type === "api-session/error"), [{ type: "api-session/error", sessionId: "storage", message: "本轮执行失败" }]);
  assert.deepEqual(chat, []);
});

test("真实 v2 重读检查点落后时保留首读期间已观察活动", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-v2-stale-"));
  const storage = new SqliteSessionPersistence(join(dir, "events.sqlite")); storage.upgradeDirectoryMetadata();
  const manager = new AgentManager(storage, async () => {});
  t.after(async () => { await manager.close(); await storage.close(); await rm(dir, { recursive: true, force: true }); });
  const writer = await storage.create({ sessionId: "stale", createdAt: 1 }); await writer.flush(); await writer.close();
  const initial = (await storage.list())[0];
  assert.equal(initial?.eventCount, 0); assert.equal(initial?.listMetadata?.blank, true);
  const directory = await SessionDirectory.restore(storage); manager.onLoaded(agent => directory.observeAgent(agent));
  const agent = await manager.load("stale");
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const reached = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0; let online = true; const notices: unknown[] = [];
  directory.onObservation(frame => notices.push(frame));
  const query = directory.query({ list: async () => { const result = await storage.list(); if (++calls === 1) { entered(); await gate; } return result; } }, id => online ? manager.get(id) : undefined);
  await reached;
  agent.prompt({ requestId: "r", content: [{ type: "text", text: "x" }] }); await agent.waitForIdle();
  await agent.session.flush(); await agent.stop(); online = false;
  const record = (await storage.list())[0]; assert.equal(record?.eventCount, 2); assert.equal(record?.listMetadata?.eventCount, 0);
  const notificationsBeforeRead = notices.length;
  release(); const result = await query;
  assert.equal(calls, 2); assert.equal(notices.length, notificationsBeforeRead);
  assert.equal(result.sessions[0]?.blank, false); assert.ok((result.sessions[0]?.updatedAt ?? 0) > 1);
  assert.equal(result.revision, directory.snapshot().revision);
});

test("仅被 GET 发现的分支在第二次读取期间变化并离线", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-v2-fork-"));
  const storage = new SqliteSessionPersistence(join(dir, "events.sqlite")); storage.upgradeDirectoryMetadata();
  const manager = new AgentManager(storage, async () => {});
  t.after(async () => { await manager.close(); await storage.close(); await rm(dir, { recursive: true, force: true }); });
  const writer = await storage.create({ sessionId: "first", createdAt: 1 }); await writer.flush(); await writer.close();
  const directory = await SessionDirectory.restore(storage); manager.onLoaded(agent => directory.observeAgent(agent));
  const first = await manager.load("first");
  let releaseFirst!: () => void; let releaseSecond!: () => void; let enteredFirst!: () => void; let enteredSecond!: () => void;
  const gates = [new Promise<void>(resolve => { releaseFirst = resolve; }), new Promise<void>(resolve => { releaseSecond = resolve; })];
  const reached = [new Promise<void>(resolve => { enteredFirst = resolve; }), new Promise<void>(resolve => { enteredSecond = resolve; })];
  const online = new Set(["first", "fork"]); let calls = 0;
  const query = directory.query({ list: async () => { const index = calls++; const records = await storage.list(); if (index === 0) enteredFirst(); if (index === 1) enteredSecond(); if (index < 2) await gates[index]; return records; } }, id => online.has(id) ? manager.get(id) : undefined);
  await reached[0];
  const branch = await manager.initializeFork({ sessionId: "fork", createdAt: 1, isSeeded: true, parentSession: "first" }, async () => []);
  first.prompt({ requestId: "a", content: [{ type: "text", text: "a" }] }); await first.waitForIdle(); await first.session.flush(); await first.stop(); online.delete("first"); releaseFirst();
  await reached[1];
  branch.prompt({ requestId: "b", content: [{ type: "text", text: "b" }] }); await branch.waitForIdle(); await branch.session.flush(); await branch.stop(); online.delete("fork"); releaseSecond();
  const result = await query; const fork = result.sessions.find(item => item.sessionId === "fork");
  assert.equal(calls, 2); assert.ok(fork); assert.equal(fork.blank, false); assert.ok(fork.updatedAt > 1);
  assert.equal(result.revision, directory.snapshot().revision);
});

test("真实 Agent 的全部业务监听按领域参数交付", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-business-"));
  const storage = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  let finish!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; }); const reached = new Promise<void>(resolve => { entered = resolve; });
  const manager = new AgentManager(storage, async context => { context.publish({ type: "agent/error", turn: context.turn, message: "公开错误" }); entered(); await gate; });
  t.after(async () => { finish(); await manager.close(); await storage.close(); await rm(dir, { recursive: true, force: true }); });
  const writer = await storage.create({ sessionId: "business", createdAt: 1 }); await writer.flush(); await writer.close();
  const directory = await SessionDirectory.restore(storage); manager.onLoaded(agent => directory.observeAgent(agent));
  const business: unknown[] = [];
  directory.on("api-session/status", (id, running) => business.push(["status", id, running]));
  directory.on("api-session/updated", (id, blank, seq) => business.push(["updated", id, blank, seq]));
  directory.on("api-session/activity", (id, time) => business.push(["activity", id, time]));
  directory.on("api-session/error", (id, message) => business.push(["error", id, message]));
  const agent = await manager.load("business"); agent.prompt({ requestId: "r", content: [{ type: "text", text: "hello" }] });
  await reached; const revision = directory.snapshot().revision; finish(); await agent.waitForIdle();
  assert.deepEqual(business, [["status", "business", true], ["updated", "business", false, 0], ["activity", "business", agent.session.snapshot().events[1]?.time], ["error", "business", "公开错误"], ["status", "business", false]]);
  assert.equal(directory.snapshot().revision, revision + 1);
});
