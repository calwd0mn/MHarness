import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { SessionEvent } from "../../../../packages/session/src/events.ts";
import { Session } from "../../../../packages/session/src/session.ts";
import { SessionWriter } from "../../../../packages/session/src/writer.ts";
import { SqliteSessionPersistence } from "@mharness/session/server";

function setup() {
  const session = new Session({ sessionId: "writer-test", createdAt: 0 });
  const committed: SessionEvent[] = [];
  const batches: number[][] = [];
  const port = {
    async append(events: readonly SessionEvent[]) {
      batches.push(events.map(({ seq }) => seq));
      for (const event of events) {
        assert.equal(event.seq, committed.length);
        committed.push(event);
      }
    },
    async read(offset = 0, length = committed.length - offset) {
      if (offset > committed.length || offset + length > committed.length) {
        throw new RangeError("已提交范围不足");
      }
      return committed.slice(offset, offset + length);
    },
    async flush() {},
  };
  return { session, committed, batches, port };
}

for (const trigger of ["notification", "window", "close"] as const) {
  test(`同步批量追加经 ${trigger} 保留批次边界`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { session, committed, batches, port } = setup();
    let checkpoint: Promise<void> | undefined;
    const observed: number[] = [];
    session.on("session/event", (event) => {
      if (event.seq !== 1) return;
      observed.push(session.seq);
      if (trigger === "notification") checkpoint = session.flush();
    });
    const writer = new SessionWriter(session, port);
    session.append({ type: "turn/start", data: { turn: 1 } });
    const draft = session.snapshot();
    assert.throws(() => session.appendBatch(() => [
      { type: "step/start", data: { turn: 1, step: 1 } },
      { type: "command/done", data: { commandId: "missing", kind: "error" } },
    ]), /命令运行记录/);
    assert.deepEqual(session.snapshot(), draft);
    assert.deepEqual(observed, []);
    const accepted = session.appendBatch(() => [
      { type: "step/start", data: { turn: 1, step: 1 } },
      { type: "step/end", data: { turn: 1, step: 1 } },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ]);
    assert.deepEqual(accepted.map(event => event.seq), [1, 2, 3]);
    assert.deepEqual(observed, [4]);
    assert.equal(committed.length, 0);
    if (trigger === "notification") {
      assert.ok(checkpoint);
      await checkpoint;
    } else if (trigger === "window") {
      t.mock.timers.tick(200);
      await setImmediate();
    } else {
      await writer.close();
    }
    assert.deepEqual(batches, [[0], [1, 2, 3]]);
    assert.deepEqual(committed, session.snapshot().events);
    await writer.close();
  });
}

test("首事件启动固定写入窗口，在途写入的新事件保留到下一批", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, committed, batches, port } = setup();
  let finishFirst: () => void = () => {};
  const first = new Promise<void>((resolve) => { finishFirst = resolve; });
  const writer = new SessionWriter(session, {
    ...port,
    async append(events) {
      if (events[0]?.seq === 0) await first;
      await port.append(events);
    },
  });

  session.append({ type: "turn/start", data: { turn: 1 } });
  t.mock.timers.tick(150);
  session.append({ type: "step/start", data: { turn: 1, step: 1 } });
  t.mock.timers.tick(50);
  await setImmediate();
  assert.equal(committed.length, 0);

  session.append({ type: "step/end", data: { turn: 1, step: 1 } });
  assert.equal(session.seq, 3);
  finishFirst();
  await setImmediate();
  assert.deepEqual(batches, [[0, 1]]);
  t.mock.timers.tick(199);
  assert.equal(committed.length, 2);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.deepEqual(batches, [[0, 1], [2]]);
  await writer.close();
});

test("后台失败保留原批且停止自动写入，显式检查点按序重试", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, committed, batches, port } = setup();
  const initial = session.append({ type: "turn/start", data: { turn: 1 } });
  await port.append([initial]);
  batches.length = 0;
  const failure = new Error("批次已回滚");
  const reports: unknown[] = [];
  const attempts: number[][] = [];
  const writer = new SessionWriter(session, {
    ...port,
    async append(events) {
      attempts.push(events.map(({ seq }) => seq));
      if (attempts.length === 1) throw failure;
      await port.append(events);
    },
  }, (error) => reports.push(error));

  session.append({ type: "step/start", data: { turn: 1, step: 1 } });
  t.mock.timers.tick(200);
  await setImmediate();
  assert.deepEqual(reports, [failure]);
  session.append({ type: "step/end", data: { turn: 1, step: 1 } });
  t.mock.timers.tick(1_000);
  await setImmediate();
  assert.deepEqual(attempts, [[1]]);
  assert.deepEqual(committed, [initial]);

  await session.flush();
  assert.deepEqual(attempts, [[1], [1], [2]]);
  assert.deepEqual(batches, [[1], [2]]);
  assert.deepEqual(committed, session.snapshot().events);
  await writer.close();
});

test("显式检查点与关闭等待在途写入，尾批只提交一次", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, committed, batches, port } = setup();
  let finishFirst: () => void = () => {};
  const first = new Promise<void>((resolve) => { finishFirst = resolve; });
  const writer = new SessionWriter(session, {
    ...port,
    async append(events) {
      if (events[0]?.seq === 0) await first;
      await port.append(events);
    },
  });
  session.append({ type: "turn/start", data: { turn: 1 } });
  t.mock.timers.tick(200);
  await setImmediate();
  session.append({ type: "step/start", data: { turn: 1, step: 1 } });
  const flushing = session.flush();
  const closing = writer.close();
  assert.equal(writer.close(), closing);
  assert.equal(committed.length, 0);
  finishFirst();
  await Promise.all([flushing, closing]);
  assert.deepEqual(batches, [[0], [1]]);
  await assert.rejects(session.flush(), /未绑定/);
});

test("前缀未入队时即使无待写记录也拒绝检查点", async () => {
  const { session, port } = setup();
  await assert.rejects(session.flush(), /未绑定/);
  session.append({ type: "turn/start", data: { turn: 1 } });
  const writer = new SessionWriter(session, port);
  await assert.rejects(session.flush(), /已提交范围不足/);
  await assert.rejects(writer.close(), /已提交范围不足/);
});

test("SQLite 只读取已提交的严格范围，读取不会排空在线尾部", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = await mkdtemp(join(tmpdir(), "mharness-prefix-"));
  const path = join(dir, "events.sqlite");
  const storage = new SqliteSessionPersistence(path);
  t.after(async () => {
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  });
  const session = new Session({ sessionId: "s", createdAt: 0 });
  for (let turn = 1; turn <= 4; turn++) {
    session.append({ type: "turn/start", data: { turn } });
    session.append({ type: "turn/end", data: { turn, reason: { kind: "completed" } } });
  }
  const writer = await storage.create(session.header);
  await writer.append(session.snapshot().events);
  storage.bindWriter(writer, session);
  session.append({ type: "turn/start", data: { turn: 5 } });
  session.append({ type: "step/start", data: { turn: 5, step: 1 } });

  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  try {
    const reader = await observer.open("s", "read");
    assert.ok(reader);
    assert.deepEqual(await reader.read(), session.snapshot(0, 8).events);
    assert.deepEqual(await reader.read(8, 0), []);
    for (const [offset, length] of [[0, 10], [9, 0], [-1, 0], [0.5, 0], [0, Number.MAX_SAFE_INTEGER + 1]]) {
      await assert.rejects(reader.read(offset, length), RangeError);
    }
    assert.equal((await observer.stat("s"))?.eventCount, 8);
    assert.equal(session.snapshot().events.length, 10);
    await session.flush();
    assert.deepEqual(await reader.read(), session.snapshot().events);
  } finally {
    await observer.close();
  }
});

test("统一 flush 汇总两个失败并提交第三个会话，关闭失败后可重新取得写入权", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = await mkdtemp(join(tmpdir(), "mharness-flush-"));
  const path = join(dir, "events.sqlite");
  const storage = new SqliteSessionPersistence(path);
  const injection = new DatabaseSync(path);
  t.after(async () => {
    injection.close();
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  });
  const handles = [];
  for (const sessionId of ["fail-a", "good", "fail-b"]) {
    const session = new Session({ sessionId, createdAt: 0 });
    const handle = await storage.create(session.header);
    await handle.flush();
    storage.bindWriter(handle, session);
    session.append({ type: "turn/start", data: { turn: 1 } });
    handles.push(handle);
  }
  const [a, good, b] = handles;
  assert.ok(a && good && b);
  injection.exec(`CREATE TRIGGER fail_writes BEFORE INSERT ON mh_events
    WHEN NEW.session_id IN ('fail-a', 'fail-b')
    BEGIN SELECT RAISE(ABORT, '拒绝测试写入'); END`);
  await assert.rejects(storage.flush(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    const failures: unknown[] = error.errors;
    assert.deepEqual(failures.map((failure) => {
      assert.ok(failure instanceof Error && "sessionId" in failure);
      assert.ok(failure.cause instanceof Error);
      assert.match(failure.cause.message, /拒绝测试写入/);
      return failure.sessionId;
    }), ["fail-a", "fail-b"]);
    return true;
  });
  assert.deepEqual((await good.read()).map(({ seq }) => seq), [0]);
  assert.deepEqual(await a.read(), []);
  assert.deepEqual(await b.read(), []);
  const closing = a.close();
  await assert.rejects(closing, /拒绝测试写入/);
  assert.equal(a.close(), closing);
  await assert.rejects(a.read(), /关闭/);
  await assert.rejects(a.append([]), /关闭/);
  await assert.rejects(a.flush(), /关闭/);
  const replacement = await storage.open("fail-a", "write");
  assert.ok(replacement);
  await replacement.close();
  injection.exec("DROP TRIGGER fail_writes");
  await b.close();
  assert.equal((await storage.stat("fail-b"))?.eventCount, 1);
});

test("受理事件跨批写入，重开后可从自有用户消息恢复请求编号", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = await mkdtemp(join(tmpdir(), "mharness-accepted-"));
  const path = join(dir, "events.sqlite");
  const storage = new SqliteSessionPersistence(path);
  t.after(async () => {
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  });

  const parent = new Session({ sessionId: "parent", createdAt: 0 });
  parent.append({ type: "turn/start", data: { turn: 1 } });
  parent.append({ type: "step/start", data: { turn: 1, step: 1 } });
  parent.append({ type: "user/message", surfaceOp: "append", data: {
    id: "parent-message", role: "user", source: { kind: "user" }, turn: 1,
    requestId: "parent-request", content: [{ type: "text", text: "继承的消息" }],
  } });
  parent.append({ type: "step/end", data: { turn: 1, step: 1 } });
  parent.append({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  const child = new Session({ sessionId: "child", createdAt: 1, isSeeded: true, parentSession: "parent" }, {
    seed: { kind: "fork", events: parent.snapshot().events },
  });

  const handle = await storage.create(child.header, { inheritedEventCount: child.inheritedEventCount });
  await handle.append(child.snapshot().events);
  storage.bindWriter(handle, child);
  child.append({ type: "turn/start", data: { turn: 2 } });
  child.append({ type: "step/start", data: { turn: 2, step: 1 } });
  t.mock.timers.tick(200);
  await setImmediate();
  assert.equal((await storage.stat("child"))?.eventCount, 8);
  child.append({ type: "user/message", surfaceOp: "append", data: {
    id: "child-message", role: "user", source: { kind: "user" }, turn: 2,
    requestId: "child-request", content: [{ type: "text", text: "当前消息" }],
  } });
  await storage.close();

  const reopened = new SqliteSessionPersistence(path, { readOnly: true });
  try {
    const reader = await reopened.open("child", "read");
    assert.ok(reader);
    assert.equal(reader.inheritedEventCount, 5);
    const events = await reader.read();
    assert.deepEqual(events, child.snapshot().events);
    assert.deepEqual(events.slice(reader.inheritedEventCount).flatMap((event) =>
      event.type === "user/message" && "requestId" in event.data ? [event.data.requestId] : [],
    ), ["child-request"]);
  } finally {
    await reopened.close();
  }
});
