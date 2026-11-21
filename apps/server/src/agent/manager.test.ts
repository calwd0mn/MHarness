import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSessionPersistence } from "@mharness/session/server";
import { AgentManager } from "./manager.ts";
import { SessionCommandController } from "../commands.ts";

test("维护任务保留返回值并与 prompt 共用准入", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-maintenance-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  const handle = await store.create({ sessionId: "s", createdAt: 1 });
  await handle.flush(); await handle.close();
  const manager = new AgentManager(store, async () => {});
  let release: (() => void) | undefined;
  try {
    const agent = await manager.load("s");
    const request = { requestId: "old", content: [{ type: "text" as const, text: "hello" }] };
    agent.prompt(request);
    await agent.waitForIdle();
    const task: Promise<string> = agent.runMaintenance(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return "result";
    });
    assert.equal(agent.state, "maintenance");
    assert.deepEqual(agent.prompt(request), { accepted: true });
    assert.throws(() => agent.prompt({ ...request, requestId: "new" }), { code: "agent_busy" });
    await assert.rejects(agent.runMaintenance(async () => {}), { code: "agent_busy" });
    let idle = false;
    const waiting = agent.waitForIdle().then(() => { idle = true; });
    await Promise.resolve();
    assert.equal(idle, false);
    release?.();
    assert.equal(await task, "result");
    await waiting;
    assert.equal(agent.state, "idle");
    assert.equal(agent.session.snapshot().events.filter((event) => event.type === "user/message").length, 1);
    const failure = new Error("maintenance");
    await assert.rejects(agent.runMaintenance(async () => { throw failure; }), (error) => error === failure);
    await agent.waitForIdle();
    agent.blockStorage(failure);
    assert.throws(() => agent.prompt({ ...request, requestId: "blocked" }), { code: "storage_blocked", cause: failure });
    await assert.rejects(agent.runMaintenance(async () => {}), { code: "storage_blocked", cause: failure });
    agent.beginStop();
    assert.throws(() => agent.prompt({ ...request, requestId: "closed" }), { code: "agent_closed" });
    await assert.rejects(agent.runMaintenance(async () => {}), { code: "agent_closed" });
  } finally {
    release?.();
    await manager.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("继承的用户编号不占用子会话的受理编号", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-inherited-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  const handle = await store.create(
    { sessionId: "child", createdAt: 1, isSeeded: true, parentSession: "parent" },
    { inheritedEventCount: 1 },
  );
  await handle.append([
    { type: "user/message", seq: 0, time: 1, surfaceOp: "append", data: {
      id: "parent-user", turn: 1, requestId: "same", role: "user", source: { kind: "user" },
      content: [{ type: "text", text: "父会话消息" }],
    } },
    { type: "session/end-seed", seq: 1, time: 2, data: { inherited: true } },
  ]);
  await handle.close();
  let calls = 0;
  const manager = new AgentManager(store, async ({ session, turn, step }) => {
    session.append({ type: "step/start", data: { turn, step } });
    calls++;
    session.append({ type: "step/end", data: { turn, step } });
    session.append({ type: "turn/end", data: { turn, reason: { kind: "completed" } } });
  });
  try {
    const commands = new SessionCommandController(manager);
    await commands.prompt({ sessionId: "child", requestId: "same", content: [{ type: "text", text: "子会话消息" }] });
    const agent = manager.get("child");
    assert.ok(agent);
    await agent.waitForIdle();
    assert.equal(calls, 1);
    assert.equal(agent.session.snapshot().events.filter((event) => event.type === "user/message").length, 2);
    await commands.prompt({ sessionId: "child", requestId: "same", content: [{ type: "text", text: "重发" }] });
    assert.equal(calls, 1);
  } finally {
    await manager.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("并发受理去重、忙碌拒绝、取消和重启查重", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-test-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  const handle = await store.create({ sessionId: "s", createdAt: 1 });
  await handle.flush(); await handle.close();
  let calls = 0;
  let release: (() => void) | undefined;
  const manager = new AgentManager(store, async ({ session, turn, step }) => {
    session.append({ type: "step/start", data: { turn, step } });
    calls++;
    await new Promise<void>((resolve) => { release = resolve; });
    session.append({ type: "step/end", data: { turn, step } });
    session.append({ type: "turn/end", data: { turn, reason: { kind: "completed" } } });
  });
  const commands = new SessionCommandController(manager);
  const request = { sessionId: "s", requestId: "r", content: [{ type: "text" as const, text: "first" }] };
  try {
    assert.deepEqual(await Promise.all([commands.prompt(request), commands.prompt({ ...request, content: [{ type: "text", text: "other" }] })]), [{ accepted: true }, { accepted: true }]);
    assert.equal(calls, 1);
    await assert.rejects(commands.prompt({ ...request, requestId: "new" }), { code: "agent_busy" });
    const agent = manager.get("s"); assert.ok(agent);
    assert.equal(agent.session.snapshot().events.filter((event) => event.type === "user/message").length, 1);
    release?.(); await agent.waitForIdle();
    await manager.close();
    const reopened = new AgentManager(store, async () => { calls++; });
    assert.deepEqual(await new SessionCommandController(reopened).prompt(request), { accepted: true });
    assert.equal(calls, 1);
    await reopened.close();
  } finally { release?.(); await manager.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("存储故障在运行结束后仍拒绝新任务，恢复检查点后才开放", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-fault-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  const handle = await store.create({ sessionId: "s", createdAt: 1 }); await handle.flush(); await handle.close();
  const manager = new AgentManager(store, async ({ session, turn, step, blockStorage }) => {
    session.append({ type: "step/start", data: { turn, step } });
    blockStorage(new Error("checkpoint"));
    session.append({ type: "step/end", data: { turn, step } });
    session.append({ type: "turn/end", data: { turn, reason: { kind: "completed" } } });
  });
  const commands = new SessionCommandController(manager);
  const request = { sessionId: "s", requestId: "r", content: [{ type: "text" as const, text: "x" }] };
  try {
    await commands.prompt(request);
    const agent = manager.get("s"); assert.ok(agent); await agent.waitForIdle();
    assert.equal(agent.state, "idle"); assert.equal(agent.storageOpen, false);
    assert.deepEqual(await commands.prompt(request), { accepted: true });
    await assert.rejects(commands.prompt({ ...request, requestId: "next" }), { code: "storage_blocked" });
    await agent.recoverStorage();
    assert.equal(agent.storageOpen, true);
    await commands.prompt({ ...request, requestId: "next" }); await agent.waitForIdle();
  } finally { await manager.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("加载通知同步连接观察，取消等待驱动退出并关闭释放写入权", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-close-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  const handle = await store.create({ sessionId: "s", createdAt: 1 }); await handle.flush(); await handle.close();
  let stopped = false;
  const manager = new AgentManager(store, async ({ session, turn, step, signal, publish }) => {
    session.append({ type: "step/start", data: { turn, step } });
    publish({ type: "assistant/start", attemptId: "a", turn, step });
    publish({ type: "assistant/chunk", attemptId: "a", index: 0, chunk: { type: "text-delta", index: 0, text: "x" } });
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    publish({ type: "assistant/end", attemptId: "a", turn, step, index: 1, outcome: { kind: "abandoned" } });
    session.append({ type: "step/end", data: { turn, step } });
    session.append({ type: "turn/end", data: { turn, reason: { kind: "aborted", reason: "cancelled" } } });
    stopped = true;
  });
  const observations: string[] = [];
  manager.onLoaded((agent) => agent.onObservation((notice) => observations.push(notice.type === "assistant-stream" ? notice.frame.type : notice.type)));
  const commands = new SessionCommandController(manager);
  try {
    await assert.rejects(commands.cancel("s"), { code: "session/not-found" });
    await commands.prompt({ sessionId: "s", requestId: "r", content: [{ type: "text", text: "x" }] });
    const agent = manager.get("s"); assert.ok(agent);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(agent.snapshot().assistantStream.activeAttempt?.nextIndex, 1);
    assert.deepEqual(observations.slice(0, 5), ["event", "event", "event", "start", "chunk"]);
    await manager.close(); assert.equal(stopped, true);
    const next = await store.open("s", "write"); assert.ok(next); await next.close();
  } finally { await manager.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});


test("加载失败不发布实例，释放写入权后可再次加载", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-load-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  const handle = await store.create({ sessionId: "s", createdAt: 1 }); await handle.flush(); await handle.close();
  let fail = true;
  const manager = new AgentManager({
    create: (header, options) => store.create(header, options),
    open: (id, access) => store.open(id, access),
    bindWriter: (writer, session, report) => {
      if (fail) throw new Error("bind failed");
      store.bindWriter(writer, session, report);
    },
  }, async () => {});
  try {
    await assert.rejects(manager.load("s"), /bind failed/);
    assert.equal(manager.get("s"), undefined);
    fail = false;
    assert.ok(await manager.load("s"));
  } finally { await manager.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("关闭同时取消所有会话，不等待较慢会话退出", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-close-all-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  for (const id of ["a", "b"]) {
    const handle = await store.create({ sessionId: id, createdAt: 1 });
    await handle.flush();
    await handle.close();
  }
  let releaseA: (() => void) | undefined;
  const cancelled: string[] = [];
  const manager = new AgentManager(store, async ({ session, signal }) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
      cancelled.push(session.header.sessionId);
      if (session.header.sessionId === "a") releaseA = resolve;
      else resolve();
    }, { once: true }));
  });
  const commands = new SessionCommandController(manager);
  try {
    for (const sessionId of ["a", "b"]) {
      await commands.prompt({ sessionId, requestId: "r", content: [{ type: "text", text: "x" }] });
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closing = manager.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(cancelled, ["a", "b"]);
    releaseA?.();
    await closing;
  } finally {
    releaseA?.();
    await manager.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("驱动异常后仅在修复并提交遗留范围后开放新 Turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-repair-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  const handle = await store.create({ sessionId: "s", createdAt: 1 });
  await handle.flush();
  await handle.close();
  let release: (() => void) | undefined;
  const manager = new AgentManager(store, async ({ session, turn, step }) => {
    session.append({ type: "step/start", data: { turn, step } });
    await new Promise<void>((resolve) => { release = resolve; });
    throw new Error("driver failed");
  });
  const commands = new SessionCommandController(manager);
  try {
    const request = { sessionId: "s", requestId: "first", content: [{ type: "text" as const, text: "x" }] };
    await commands.prompt(request);
    const agent = manager.get("s");
    assert.ok(agent);
    agent.blockStorage(new Error("blocked"));
    await assert.rejects(agent.recoverStorage());
    release?.();
    await agent.waitForIdle();
    await assert.rejects(commands.prompt({ ...request, requestId: "second" }), { code: "storage_blocked" });
    await agent.recoverStorage();
    const events = agent.session.snapshot().events;
    assert.deepEqual(events.slice(-2).map((event) => event.type), ["step/end", "turn/end"]);
    const persisted = await store.open("s", "read");
    assert.ok(persisted);
    assert.deepEqual(await persisted.read(), events);
    await persisted.close();
    await commands.prompt({ ...request, requestId: "second" });
    const types = agent.session.snapshot().events.map((event) => event.type);
    assert.ok(types.indexOf("turn/end") < types.lastIndexOf("turn/start"));
    release?.();
    await agent.waitForIdle();
  } finally {
    release?.();
    await manager.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("关闭等待加载期间汇总句柄释放失败", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-load-close-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  const prepared = await store.create({ sessionId: "s", createdAt: 1 });
  await prepared.flush();
  await prepared.close();
  let unblock: (() => void) | undefined;
  let opened: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { opened = resolve; });
  const manager = new AgentManager({
    create: (header, options) => store.create(header, options),
    open: async (id, access) => {
      const handle = await store.open(id, access);
      assert.ok(handle);
      opened?.();
      await new Promise<void>((resolve) => { unblock = resolve; });
      return {
        id: handle.id, header: handle.header, access: handle.access,
        inheritedEventCount: handle.inheritedEventCount,
        read: (offset, length) => handle.read(offset, length),
        append: (events) => handle.append(events),
        flush: () => handle.flush(),
        close: async () => { await handle.close(); throw new Error("close failed"); },
      };
    },
    bindWriter: () => {},
  }, async () => {});
  try {
    const loading = manager.load("s");
    const observedLoad = loading.catch((error: unknown) => error);
    await entered;
    const closing = manager.close();
    unblock?.();
    await assert.rejects(closing, (error: unknown) => error instanceof AggregateError
      && error.errors.some((item: unknown) => item instanceof Error && item.message === "close failed"));
    assert.ok(await observedLoad instanceof Error);
  } finally {
    unblock?.();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("等待加载时立即观察停止失败，避免未处理拒绝", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-stop-fail-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  for (const id of ["a", "b"]) {
    const handle = await store.create({ sessionId: id, createdAt: 1 });
    await handle.flush();
    await handle.close();
  }
  let rejectFlush: ((error: Error) => void) | undefined;
  let unblockLoad: (() => void) | undefined;
  let loadingEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { loadingEntered = resolve; });
  const manager = new AgentManager({
    create: (header, options) => store.create(header, options),
    open: async (id, access) => {
      const handle = await store.open(id, access);
      if (id === "b") {
        loadingEntered?.();
        await new Promise<void>((resolve) => { unblockLoad = resolve; });
      }
      return handle;
    },
    bindWriter: (_handle, session) => {
      session.bindCheckpoint(() => new Promise<void>((_resolve, reject) => { rejectFlush = reject; }));
    },
  }, async () => {});
  try {
    const agent = await manager.load("a");
    const recovery = agent.recoverStorage().catch((error: unknown) => error);
    const loading = manager.load("b").catch((error: unknown) => error);
    await entered;
    const closing = manager.close();
    rejectFlush?.(new Error("flush failed"));
    await recovery;
    await new Promise<void>((resolve) => setImmediate(resolve));
    unblockLoad?.();
    await loading;
    await assert.rejects(closing, (error: unknown) => error instanceof AggregateError
      && error.errors.some((item: unknown) => item instanceof Error && item.message === "flush failed"));
  } finally {
    unblockLoad?.();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
