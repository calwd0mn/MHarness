import assert from "node:assert/strict";
import { test } from "node:test";
import { Session, type SessionHandle, type SessionHeader, type SessionPersistenceCreateOptions } from "@mharness/session/server";
import { AgentManager } from "../agent/manager.ts";
import type { AgentObservation } from "../agent/react-agent.ts";
import { SessionCommandController } from "../commands.ts";

type Event = ReturnType<Session["snapshot"]>["events"][number];

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

function parentRecords() {
  const parent = new Session({ sessionId: "parent", createdAt: 1 });
  parent.append({ type: "turn/start", time: 1, data: { turn: 1 } });
  parent.append({ type: "user/message", time: 2, surfaceOp: "append", data: {
    turn: 1, id: "parent-user", requestId: "shared", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "父消息" }],
  } });
  parent.append({ type: "turn/end", time: 3, data: { turn: 1, reason: { kind: "completed" } } });
  return parent.snapshot().events;
}

function fakeStorage(options: { failRead?: boolean; failCommit?: boolean; holdCreate?: boolean } = {}) {
  const taken = gate();
  const continueCreate = gate();
  const commitEntered = gate();
  const continueCommit = gate();
  const trace: string[] = [];
  const parent = parentRecords();
  let childId = "";
  let childBatch: readonly Event[] = [];
  let createSignal: AbortSignal | undefined;
  const port = {
    async open(id: string, access: "read" | "write"): Promise<SessionHandle | undefined> {
      trace.push(`open:${id}:${access}`);
      if (id !== "parent") return undefined;
      assert.equal(access, "read");
      return {
        id, header: { sessionId: id, createdAt: 1 }, inheritedEventCount: 0, access,
        async read() { trace.push("read-parent"); if (options.failRead) throw new Error("read failure"); return parent; },
        async append() { assert.fail("父日志被追加"); },
        async flush() { assert.fail("父日志被刷新"); },
        async close() { trace.push("close-parent"); },
      };
    },
    async create(header: SessionHeader, optionsForChild?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
      trace.push("prepare-child");
      childId = header.sessionId;
      assert.equal(header.isSeeded, true);
      assert.equal(header.parentSession, "parent");
      assert.equal(optionsForChild?.inheritedEventCount, 3);
      createSignal = optionsForChild?.signal;
      taken.open();
      if (options.holdCreate) await continueCreate.promise;
      return {
        id: childId, header, inheritedEventCount: 3, access: "write",
        async read() { return childBatch; },
        async append(events) {
          trace.push("append-child");
          commitEntered.open();
          await continueCommit.promise;
          if (options.failCommit) throw new Error("append rollback");
          childBatch = events;
          trace.push("committed-child");
        },
        async flush() { assert.fail("初始化不能 flush 空 header"); },
        async close() { trace.push("close-child"); },
      };
    },
    bindWriter(_handle: SessionHandle, session: Session) {
      trace.push("bind-child");
      session.on("session/event", (event) => trace.push(`queued:${event.seq}`));
    },
  };
  return { port, trace, taken, continueCreate, commitEntered, continueCommit, parent,
    childId: () => childId, childBatch: () => childBatch, createSignal: () => createSignal };
}

test("首批确认后发布完整 Session 与 Agent，父句柄先于子准备释放", { timeout: 5000 }, async () => {
  const storage = fakeStorage();
  const agents = new AgentManager(storage.port, async () => { assert.fail("fork 不调用模型"); });
  const commands = new SessionCommandController(agents);
  const observed: { session: Session; agentSession: Session | undefined; records: readonly Event[] }[] = [];
  const realtime: AgentObservation[] = [];
  agents.onLoaded((agent) => {
    storage.trace.push("loaded-child");
    agent.onObservation((notice) => realtime.push(notice));
  });
  agents.onSessionCreated((session) => {
    storage.trace.push("created-child");
    observed.push({ session, agentSession: agents.get(session.header.sessionId)?.session, records: session.snapshot().events });
    session.append({ type: "turn/start", time: 4, data: { turn: 2 } });
  });
  try {
    const fork = commands.fork({ sessionId: "parent", atSeq: 0 });
    await storage.commitEntered.promise;
    const id = storage.childId();
    assert.equal(agents.get(id), undefined);
    assert.deepEqual(storage.trace, ["open:parent:read", "read-parent", "close-parent", "prepare-child", "append-child"]);
    const loading = agents.load(id);
    storage.continueCommit.open();
    assert.deepEqual(await fork, { sessionId: id });
    const child = await loading;
    assert.equal(child, agents.get(id));
    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.session, child.session);
    assert.equal(observed[0]?.agentSession, child.session);
    assert.deepEqual(observed[0]?.records, storage.childBatch());
    assert.ok(!storage.trace.includes(`open:${id}:write`));
    assert.deepEqual(child.session.snapshot().events.slice(0, 3), storage.parent);
    assert.deepEqual(child.session.snapshot().events.at(3), { type: "session/end-seed", seq: 3, time: child.session.header.createdAt, data: { inherited: true } });
    assert.deepEqual(storage.trace.slice(-5), ["committed-child", "bind-child", "loaded-child", "created-child", "queued:4"]);
    assert.deepEqual(storage.trace.filter((entry) => entry.startsWith("queued:")), ["queued:4"]);
    assert.deepEqual(realtime, [{ type: "event", event: { type: "turn/start", seq: 4, time: 4, data: { turn: 2 } } }]);
  } finally {
    storage.continueCommit.open();
    await agents.close();
  }
});

test("读取失败释放父句柄，首次提交失败释放子句柄且不发布", { timeout: 5000 }, async () => {
  for (const failRead of [true, false]) {
    const storage = fakeStorage({ failRead, failCommit: !failRead });
    const agents = new AgentManager(storage.port, async () => {});
    const commands = new SessionCommandController(agents);
    try {
      let created = 0;
      agents.onSessionCreated(() => { created++; });
      const fork = commands.fork({ sessionId: "parent" });
      storage.continueCommit.open();
      await assert.rejects(fork, failRead ? /read failure/ : /append rollback/);
      assert.equal(created, 0);
      assert.ok(storage.trace.includes("close-parent"));
      assert.ok(!storage.trace.includes("bind-child"));
      assert.equal(storage.trace.includes("prepare-child"), !failRead);
      assert.equal(storage.trace.includes("close-child"), !failRead);
      assert.equal(agents.get(storage.childId()), undefined);
    } finally {
      storage.continueCommit.open();
      await agents.close();
    }
  }
});

test("关闭等待已开始的首批提交并兑现分支，入途 prompt 无法接管", { timeout: 5000 }, async () => {
  const storage = fakeStorage();
  let turns = 0;
  const agents = new AgentManager(storage.port, async () => { turns++; });
  const commands = new SessionCommandController(agents);
  const realtime: AgentObservation[] = [];
  agents.onLoaded((agent) => agent.onObservation((notice) => realtime.push(notice)));
  agents.onSessionCreated((session) => {
    session.append({ type: "turn/start", time: 4, data: { turn: 2 } });
  });
  try {
    const fork = commands.fork({ sessionId: "parent" });
    await storage.commitEntered.promise;
    const id = storage.childId();
    const prompt = assert.rejects(commands.prompt({ sessionId: id, requestId: "new", content: [{ type: "text", text: "x" }] }), { code: "agent_closed" });
    const closing = agents.close();
    storage.continueCommit.open();
    assert.deepEqual(await fork, { sessionId: id });
    await prompt;
    await closing;
    assert.equal(turns, 0);
    assert.equal(storage.childBatch().length, 4);
    assert.deepEqual(storage.trace.filter((entry) => entry.startsWith("queued:")), ["queued:4"]);
    assert.deepEqual(realtime, [{ type: "event", event: { type: "turn/start", seq: 4, time: 4, data: { turn: 2 } } }]);
    assert.equal(agents.get(id), undefined);
    assert.equal(storage.trace.at(-1), "close-child");
  } finally {
    storage.continueCommit.open();
    await agents.close();
  }
});

test("关闭取消准备中的分支并释放取得的句柄", { timeout: 5000 }, async () => {
  const storage = fakeStorage({ holdCreate: true });
  const agents = new AgentManager(storage.port, async () => {});
  const commands = new SessionCommandController(agents);
  try {
    const fork = assert.rejects(commands.fork({ sessionId: "parent" }), { code: "agent_closed" });
    await storage.taken.promise;
    const closing = agents.close();
    assert.equal(storage.createSignal()?.aborted, true);
    storage.continueCreate.open();
    await fork;
    await closing;
    assert.deepEqual(storage.trace.slice(-2), ["prepare-child", "close-child"]);
  } finally {
    storage.continueCreate.open();
    storage.continueCommit.open();
    await agents.close();
  }
});


test("关闭等待父读取时不汇总没有闭合轮次的业务拒绝", { timeout: 5000 }, async () => {
  const storage = fakeStorage();
  const entered = gate();
  const resume = gate();
  const open = storage.port.open;
  storage.port.open = async (id, access) => {
    const handle = await open(id, access);
    if (!handle) return undefined;
    return { ...handle, async read() { entered.open(); await resume.promise; return []; } };
  };
  const agents = new AgentManager(storage.port, async () => {});
  const fork = assert.rejects(new SessionCommandController(agents).fork({ sessionId: "parent" }), { code: "session/fork-unavailable" });
  await entered.promise;
  const closing = agents.close();
  resume.open();
  await fork;
  await closing;
  assert.ok(storage.trace.includes("close-parent"));
});

test("关闭等待父读取时仍汇总读取和句柄关闭异常", { timeout: 5000 }, async () => {
  for (const failure of ["read failure", "close failure"]) {
    const storage = fakeStorage();
    const entered = gate();
    const resume = gate();
    const open = storage.port.open;
    storage.port.open = async (id, access) => {
      const handle = await open(id, access);
      if (!handle) return undefined;
      return { ...handle,
        async read() { entered.open(); await resume.promise; if (failure === "read failure") throw new Error(failure); return []; },
        async close() { await handle.close(); if (failure === "close failure") throw new Error(failure); },
      };
    };
    const agents = new AgentManager(storage.port, async () => {});
    const fork = assert.rejects(new SessionCommandController(agents).fork({ sessionId: "parent" }), new RegExp(failure));
    await entered.promise;
    const closing = assert.rejects(agents.close(), (error: unknown) => error instanceof AggregateError
      && error.errors.some((item: unknown) => item instanceof Error && item.message === failure));
    resume.open();
    await fork;
    await closing;
    assert.ok(storage.trace.includes("close-parent"));
  }
});

test("非法父标识和锚点在开始父读取和注册初始化前拒绝", async () => {
  for (const request of [{ sessionId: "", atSeq: undefined }, { sessionId: "parent", atSeq: -1 }]) {
    const storage = fakeStorage();
    const agents = new AgentManager(storage.port, async () => {});
    const fork = assert.rejects(new SessionCommandController(agents).fork(request), request.sessionId ? RangeError : { name: "ZodError" });
    await Promise.resolve();
    await agents.close();
    await fork;
    assert.deepEqual(storage.trace, []);
  }
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteSessionPersistence } from "@mharness/session/server";

test("SQLite 首批拒绝标记时回滚子 header 和 seed，释放子写入权", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-fork-rollback-"));
  const path = join(dir, "events.sqlite");
  const storage = new SqliteSessionPersistence(path);
  const db = new DatabaseSync(path);
  const agents = new AgentManager(storage, async () => {});
  try {
    const parent = await storage.create({ sessionId: "parent", createdAt: 1 });
    await parent.append(parentRecords());
    await parent.close();
    let preparedHeader: SessionHeader | undefined;
    const create = storage.create.bind(storage);
    storage.create = (header, options) => {
      preparedHeader = header;
      return create(header, options);
    };
    db.exec(`CREATE TRIGGER reject_seed BEFORE INSERT ON mh_events WHEN NEW.seq = 3
      BEGIN SELECT RAISE(ABORT, '拒绝首次 seed 标记'); END`);
    let notices = 0;
    agents.onSessionCreated(() => { notices++; });
    await assert.rejects(new SessionCommandController(agents).fork({ sessionId: "parent" }), /拒绝首次 seed 标记/);
    assert.ok(preparedHeader);
    assert.equal(await storage.stat(preparedHeader.sessionId), undefined);
    assert.equal(await storage.open(preparedHeader.sessionId, "read"), undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mh_events WHERE session_id = ?").get(preparedHeader.sessionId)?.count, 0);
    assert.equal(agents.get(preparedHeader.sessionId), undefined);
    assert.equal(notices, 0);
    const retry = await create(preparedHeader, { inheritedEventCount: 3 });
    await retry.close();
  } finally {
    db.close();
    await agents.close();
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite 独立恢复比父持久历史更长的 seed 和嵌套谱系", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = await mkdtemp(join(tmpdir(), "mharness-fork-reopen-"));
  const path = join(dir, "events.sqlite");
  const storage = new SqliteSessionPersistence(path);
  const db = new DatabaseSync(path);
  const agents = new AgentManager(storage, async () => {});
  let reopened: SqliteSessionPersistence | undefined;
  let after: AgentManager | undefined;
  let parentWriteRejected = false;
  try {
    const header = await storage.create({ sessionId: "parent", createdAt: 1 });
    await header.flush();
    await header.close();
    const commands = new SessionCommandController(agents);
    await assert.rejects(commands.fork({ sessionId: "missing" }), { code: "session/not-found" });
    await assert.rejects(commands.fork({ sessionId: "parent" }), { code: "session/fork-unavailable" });
    assert.equal(agents.get("parent"), undefined);
    const { session } = await agents.load("parent");
    const seed = parentRecords();
    for (const event of seed.slice(0, 2)) {
      if (event.type === "turn/start" || event.type === "user/message") {
        const { seq: _, ...append } = event;
        session.append(append);
      }
    }
    await session.flush();
    await assert.rejects(commands.fork({ sessionId: "parent", atSeq: 1 }), { code: "session/fork-unavailable" });
    const end = seed[2];
    assert.ok(end.type === "turn/end");
    session.append({ type: "turn/end", time: end.time, data: end.data });
    db.exec(`CREATE TRIGGER reject_parent_tail BEFORE INSERT ON mh_events
      WHEN NEW.session_id = 'parent' AND NEW.seq = 2
      BEGIN SELECT RAISE(ABORT, '父尾部未提交'); END`);
    parentWriteRejected = true;
    const { sessionId: childId } = await commands.fork({ sessionId: "parent" });
    const child = agents.get(childId)?.session;
    assert.ok(child);
    assert.equal(child.inheritedEventCount, 3);
    assert.deepEqual(child.snapshot().events.slice(0, 3), seed);
    assert.equal((await storage.stat("parent"))?.eventCount, 2);
    assert.equal(session.seq, 3);
    const { sessionId: grandchildId } = await commands.fork({ sessionId: childId, atSeq: 3 });
    const grandchild = agents.get(grandchildId)?.session;
    assert.ok(grandchild);
    assert.equal(grandchild.inheritedEventCount, 4);
    assert.equal(grandchild.header.parentSession, childId);
    assert.deepEqual(grandchild.snapshot().events.filter((event) => event.type === "session/end-seed").map((event) => event.seq), [3, 4]);
    await assert.rejects(agents.close(), (error: unknown) => error instanceof AggregateError
      && error.errors.some((item: unknown) => item instanceof Error && item.message.includes("父尾部未提交")));
    await storage.close();

    reopened = new SqliteSessionPersistence(path);
    after = new AgentManager(reopened, async () => {});
    assert.equal((await reopened.stat("parent"))?.eventCount, 2);
    for (const original of [child, grandchild]) {
      const recovered: Session = (await after.load(original.header.sessionId)).session;
      assert.deepEqual(recovered.header, original.header);
      assert.equal(recovered.inheritedEventCount, original.inheritedEventCount);
      assert.deepEqual(recovered.snapshot().events, original.snapshot().events);
      assert.deepEqual(recovered.deriveMessages(), original.deriveMessages());
      assert.equal(recovered.seq, original.inheritedEventCount + 1);
    }
  } finally {
    await after?.close();
    await reopened?.close();
    db.close();
    if (parentWriteRejected) await agents.close().catch(() => {});
    else await agents.close();
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});
