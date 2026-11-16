import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { SqliteSessionPersistence } from "./sqlite-persistence.ts";
import { Session } from "../session.ts";
import { SessionStore } from "./sqlite.ts";

const header = { sessionId: "s", createdAt: 1 };
const event = (seq: number) => ({ type: "turn/start", seq, time: 2, data: { turn: seq + 1 } } as const);

function interceptWrite(
  t: TestContext,
  run: (db: DatabaseSync, sql: string, execute: () => void) => void,
) {
  const original = DatabaseSync.prototype.exec;
  let writer: DatabaseSync | undefined;
  return t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE") writer = this;
    const execute = () => original.call(this, sql);
    if (this === writer) run(this, sql, execute);
    else execute();
  });
}

test("准备中的会话不可见，首次批次原子发布，读取严格限制已提交范围", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mh-storage-"));
  try {
    const path = join(dir, "db.sqlite");
    const store = new SqliteSessionPersistence(path);
    const handle = await store.create(header);
    assert.equal(await store.stat("s"), undefined);
    assert.equal(await store.open("s", "read"), undefined);
    await handle.append([event(0), event(1)]);
    const reader = await store.open("s", "read");
    assert.ok(reader);
    assert.deepEqual(await reader.read(), [event(0), event(1)]);
    assert.deepEqual(await reader.read(2, 0), []);
    await assert.rejects(reader.read(0, 3));
    await assert.rejects(reader.append([event(2)]));
    await reader.close();
    await handle.close();
    await store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("无版本旧库和未知版本保持原样并拒绝打开", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mh-storage-"));
  try {
    for (const version of [0, 88]) {
      const path = join(dir, `${version}.sqlite`);
      const db = new DatabaseSync(path);
      db.exec(`CREATE TABLE old_data (value TEXT); INSERT INTO old_data VALUES ('keep'); PRAGMA user_version = ${version}`);
      db.close();
      const before = await readFile(path);
      assert.throws(() => new SqliteSessionPersistence(path), /版本|格式/);
      assert.deepEqual(await readFile(path), before);
      const check = new DatabaseSync(path, { readOnly: true });
      assert.equal(check.prepare("SELECT value FROM old_data").get()?.value, "keep");
      check.close();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("拒绝无法无损存取的会话标识，其他会话可以重开读取", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-session-id-"));
  const path = join(dir, "events.sqlite");
  const storage = new SqliteSessionPersistence(path);
  t.after(async () => {
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  });
  const valid = { sessionId: "会话🧪-\ufffd", createdAt: 1 };
  const handle = await storage.create(valid);
  await handle.flush();
  await handle.close();

  for (const sessionId of ["bad\0id", "会话🧪-\ud800", "会话🧪-\udc00"]) {
    await assert.rejects(storage.create({ sessionId, createdAt: 0 }), /会话标识/);
    await assert.rejects(storage.open(sessionId, "read"), /会话标识/);
    await assert.rejects(storage.stat(sessionId), /会话标识/);
  }
  assert.deepEqual((await storage.list()).map(({ header }) => header), [valid]);
  await storage.close();

  const reopened = new SqliteSessionPersistence(path, { readOnly: true });
  try {
    assert.deepEqual((await reopened.open(valid.sessionId, "read"))?.header, valid);
  } finally {
    await reopened.close();
  }
});

test("旧版存储拒绝在已版本化的新库上建旧表", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-versioned-"));
  try {
    const path = join(dir, "events.sqlite");
    const store = new SqliteSessionPersistence(path);
    await store.close();
    const before = await readFile(path);
    assert.throws(() => new SessionStore(path), /已版本化/);
    assert.deepEqual(await readFile(path), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("分支首次提交同时发布十条 seed 和继承标记，失败时均不可见", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-seed-"));
  const path = join(dir, "db.sqlite");
  const store = new SqliteSessionPersistence(path);
  const reader = new SqliteSessionPersistence(path, { readOnly: true });
  const injection = new DatabaseSync(path);
  t.after(async () => {
    injection.close();
    await reader.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const parent = new Session({ sessionId: "parent", createdAt: 0 });
  for (let turn = 1; turn <= 5; turn++) {
    parent.append({ type: "turn/start", data: { turn } });
    parent.append({ type: "turn/end", data: { turn, reason: { kind: "completed" } } });
  }
  const child = new Session({ sessionId: "child", parentSession: "parent", isSeeded: true, createdAt: 1 }, {
    seed: { kind: "fork", events: parent.snapshot().events },
  });
  const handle = await store.create(child.header, { inheritedEventCount: 10 });
  await assert.rejects(handle.flush(), /继承标记/);
  injection.exec(`CREATE TRIGGER fail_marker BEFORE INSERT ON mh_events WHEN NEW.seq = 10
    BEGIN SELECT RAISE(ABORT, '拒绝分支标记'); END`);
  const batch = child.snapshot().events;
  await assert.rejects(handle.append(batch), /拒绝分支标记/);
  assert.equal(await reader.stat("child"), undefined);
  assert.equal(await reader.open("child", "read"), undefined);
  assert.equal(await store.open("child", "write"), undefined);
  assert.deepEqual(await reader.list(), []);
  injection.exec("DROP TRIGGER fail_marker");
  await handle.append(batch);
  assert.deepEqual(await reader.stat("child"), { header: child.header, inheritedEventCount: 10, eventCount: 11 });
  const observation = await reader.open("child", "read");
  assert.deepEqual(await observation?.read(), batch);
});

test("首次插入失败完整回滚，重试后才同时公开 header 和事件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mh-storage-"));
  try {
    const path = join(dir, "db.sqlite");
    const store = new SqliteSessionPersistence(path);
    const handle = await store.create(header);
    const other = new DatabaseSync(path);
    other.exec("CREATE TRIGGER fail_event BEFORE INSERT ON mh_events BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await assert.rejects(handle.append([event(0)]), /injected/);
    assert.equal(await store.stat("s"), undefined);
    assert.equal(other.prepare("SELECT COUNT(*) AS n FROM mh_sessions").get()?.n, 0);
    other.exec("DROP TRIGGER fail_event");
    await handle.append([event(0)]);
    assert.equal((await store.stat("s"))?.eventCount, 1);
    await handle.close(); await store.close(); other.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("空 header 只由显式句柄 flush 提交，损坏事件拒绝读取", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mh-storage-"));
  try {
    const path = join(dir, "db.sqlite");
    const store = new SqliteSessionPersistence(path);
    const handle = await store.create(header);
    await store.flush();
    assert.equal(await store.stat("s"), undefined);
    await handle.flush();
    assert.equal((await store.stat("s"))?.eventCount, 0);
    await handle.append([event(0)]);
    const other = new DatabaseSync(path);
    other.prepare("UPDATE mh_events SET event_json=? WHERE session_id='s'").run(JSON.stringify({ ...event(0), type: "unknown" }));
    await assert.rejects(handle.read());
    await handle.close(); await store.close(); other.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("写入权冲突可区分，只读访问及其他会话不受阻", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mh-storage-"));
  try {
    const path = join(dir, "db.sqlite");
    const store = new SqliteSessionPersistence(path);
    const writer = await store.create(header);
    await writer.flush();
    await assert.rejects(store.open("s", "write"), { name: "OwnershipConflictError" });
    const reader = await store.open("s", "read");
    const other = await store.create({ sessionId: "other", createdAt: 1 });
    assert.ok(reader);
    await reader.close(); await other.close(); await writer.close(); await store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("提交返回异常时核对完整批次，冲突则阻塞后续写入", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-storage-"));
  try {
    const path = join(dir, "db.sqlite");
    const store = new SqliteSessionPersistence(path);
    const writer = await store.create(header);
    let mode: "confirmed" | "conflict" | "none" = "confirmed";
    interceptWrite(t, (db, sql, execute) => {
      execute();
      if (sql === "COMMIT" && mode !== "none") {
        const current = mode;
        mode = "none";
        if (current === "conflict") db.prepare("UPDATE mh_events SET event_json=? WHERE session_id='s' AND seq=1").run(JSON.stringify({ ...event(1), time: 999 }));
        throw new Error("提交响应丢失");
      }
    });
    await writer.append([event(0)]);
    assert.deepEqual(await writer.read(), [event(0)]);
    mode = "conflict";
    await assert.rejects(writer.append([event(1)]), /提交响应丢失/);
    await assert.rejects(writer.flush(), /冲突/);
    await assert.rejects(writer.append([event(2)]), /待核对/);
    await assert.rejects(writer.close(), /冲突/);
    await store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("只读存储不创建文件，并能观察其他连接提交的前缀", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mh-storage-"));
  try {
    const path = join(dir, "db.sqlite");
    assert.throws(() => new SqliteSessionPersistence(path, { readOnly: true }));
    const store = new SqliteSessionPersistence(path);
    const writer = await store.create(header);
    await writer.append([event(0)]);
    const observer = new SqliteSessionPersistence(path, { readOnly: true });
    const reader = await observer.open("s", "read");
    assert.ok(reader);
    assert.deepEqual(await reader.read(), [event(0)]);
    await assert.rejects(observer.open("s", "write"), /只读/);
    await reader.close(); await observer.close(); await writer.close(); await store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("回滚失败时其他读取只看已提交数据，恢复后重试原批次", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-storage-"));
  try {
    const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
    const writer = await store.create(header);
    const injection = interceptWrite(t, (_db, sql, execute) => {
      if (sql === "COMMIT") throw new Error("提交失败");
      if (sql === "ROLLBACK") throw new Error("回滚失败");
      execute();
    });
    await assert.rejects(writer.append([event(0)]), /提交失败/);
    assert.equal(await store.stat("s"), undefined);
    assert.equal(await store.open("s", "read"), undefined);
    assert.equal(await store.open("s", "write"), undefined);
    assert.deepEqual(await writer.read(), []);
    await assert.rejects(writer.flush(), /原事务尚未结束/);
    injection.mock.restore();
    await writer.flush();
    assert.deepEqual(await writer.read(), [event(0)]);
    await writer.close(); await store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("未结束事务关闭时释放写锁且不暴露未提交记录", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-storage-"));
  try {
    const path = join(dir, "db.sqlite");
    const store = new SqliteSessionPersistence(path);
    const writer = await store.create(header);
    const injection = interceptWrite(t, (_db, sql, execute) => {
      if (sql === "COMMIT" || sql === "ROLLBACK") throw new Error("注入事务错误");
      execute();
    });
    await assert.rejects(writer.append([event(0)]));
    await assert.rejects(writer.close(), /原事务尚未结束/);
    injection.mock.restore();
    const other = new SqliteSessionPersistence(path);
    assert.equal(await other.stat("s"), undefined);
    const next = await other.create(header);
    await next.append([event(0)]);
    await next.close(); await other.close(); await store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
