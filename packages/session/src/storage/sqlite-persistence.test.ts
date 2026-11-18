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

test("暂存批次在 SQLite 成功提交或确认回滚，不会重放回滚候选", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-staged-"));
  const path = join(dir, "db.sqlite");
  const store = new SqliteSessionPersistence(path);
  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  const injection = new DatabaseSync(path);
  t.after(async () => { injection.close(); await observer.close(); await store.close(); await rm(dir, { recursive: true, force: true }); });
  const session = new Session(header);
  const handle = await store.create(header);
  await handle.flush(); store.bindWriter(handle, session);
  const reader = await observer.open("s", "read"); assert.ok(reader);
  const committed = await session.commitStaged(() => [
    { type: "turn/start", data: { turn: 1 } }, { type: "step/start", data: { turn: 1, step: 1 } },
  ]);
  assert.equal(committed.status, "committed");
  assert.deepEqual(await reader.read(), session.snapshot().events);
  injection.exec("CREATE TRIGGER fail_staged BEFORE INSERT ON mh_events WHEN NEW.seq=3 BEGIN SELECT RAISE(ABORT, 'staged failure'); END");
  const rolledBack = await session.commitStaged(() => [
    { type: "step/end", data: { turn: 1, step: 1 } }, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ]);
  assert.equal(rolledBack.status, "rolled-back");
  assert.equal(session.seq, 2); assert.equal((await reader.read()).length, 2);
  injection.exec("DROP TRIGGER fail_staged");
  await session.flush(); await store.flush();
  assert.equal((await reader.read()).length, 2);
  session.append({ type: "turn/start", data: { turn: 2 } }); await session.flush();
  assert.deepEqual(await reader.read(), session.snapshot().events);
  await observer.close(); await store.close();
  const reopened = new SqliteSessionPersistence(path, { readOnly: true });
  try {
    const reopenedReader = await reopened.open("s", "read"); assert.ok(reopenedReader);
    assert.deepEqual(await reopenedReader.read(), session.snapshot().events);
    assert.equal((await reopened.stat("s"))?.eventCount, 3);
  } finally { await reopened.close(); }
});

test("暂存事务未结束时保持旧视图和占用，显式核对后释放", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-staged-pending-"));
  const path = join(dir, "db.sqlite");
  const store = new SqliteSessionPersistence(path);
  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  let fail = true; let reconciliationReads = 0;
  const prepare = DatabaseSync.prototype.prepare;
  const readMonitor = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.startsWith("SELECT header_json, inherited_count, event_count")) reconciliationReads++;
    return prepare.call(this, sql);
  });
  t.after(async () => { fail = false; readMonitor.mock.restore(); await observer.close(); await store.close(); await rm(dir, { recursive: true, force: true }); });
  const session = new Session(header); const handle = await store.create(header);
  await handle.flush(); const reports: unknown[] = []; store.bindWriter(handle, session, (error) => reports.push(error));
  const reader = await observer.open("s", "read"); assert.ok(reader);
  const fault = interceptWrite(t, (_db, sql, execute) => {
    if (fail && (sql === "COMMIT" || sql === "ROLLBACK")) throw new Error("injected transaction failure");
    execute();
  });
  const operation = session.commitStaged(() => [{ type: "turn/start", data: { turn: 1 } }]);
  await assert.rejects(handle.append([event(0)]), /占用/); await assert.rejects(handle.flush(), /占用/);
  const result = await operation;
  assert.equal(result.status, "pending-reconciliation"); assert.equal(reports.length, 1);
  assert.equal(session.seq, 0); assert.deepEqual(await reader.read(), []);
  assert.throws(() => session.append({ type: "turn/start", data: { turn: 2 } }), /暂存/);
  await assert.rejects(session.commitStaged(() => [{ type: "turn/start", data: { turn: 2 } }]), /占用/);
  await assert.rejects(handle.flush(), /原事务尚未结束/); await assert.rejects(session.flush()); await assert.rejects(store.flush());
  assert.equal(reconciliationReads, 0);
  fail = false; await handle.flush(); assert.equal(session.seq, 0);
  session.append({ type: "turn/start", data: { turn: 2 } }); await session.flush();
  assert.deepEqual(await reader.read(), session.snapshot().events);
  fault.mock.restore();
});

test("提交响应和首次核对读取丢失后补发布完整批次一次", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-staged-lost-")); const path = join(dir, "db.sqlite");
  const store = new SqliteSessionPersistence(path); const observer = new SqliteSessionPersistence(path, { readOnly: true });
  t.after(async () => { await observer.close(); await store.close(); await rm(dir, { recursive: true, force: true }); });
  const session = new Session(header); const handle = await store.create(header); await handle.flush();
  const reports: unknown[] = []; store.bindWriter(handle, session, (error) => reports.push(error));
  const reader = await observer.open("s", "read"); assert.ok(reader);
  const seen: number[] = []; session.on("session/event", ({ seq }) => seen.push(seq));
  let failRead = false; let loseCommit = true;
  const prepare = DatabaseSync.prototype.prepare;
  const readFault = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (failRead && sql.startsWith("SELECT header_json, inherited_count, event_count")) { failRead = false; throw new Error("read lost"); }
    return prepare.call(this, sql);
  });
  const writeFault = interceptWrite(t, (_db, sql, execute) => {
    execute(); if (sql === "COMMIT" && loseCommit) { loseCommit = false; failRead = true; throw new Error("response lost"); }
  });
  const result = await session.commitStaged(() => [{ type: "turn/start", data: { turn: 1 } }, { type: "step/start", data: { turn: 1, step: 1 } }]);
  assert.equal(result.status, "pending-reconciliation"); assert.equal(reports.length, 1);
  assert.equal(session.seq, 0); assert.deepEqual(seen, []); assert.equal((await reader.read()).length, 2);
  await Promise.all([handle.flush(), session.flush()]);
  assert.equal(session.seq, 2); assert.deepEqual(seen, [0, 1]); assert.deepEqual(await reader.read(), session.snapshot().events);
  await store.flush(); assert.deepEqual(seen, [0, 1]);
  writeFault.mock.restore(); readFault.mock.restore();
});

test("额外持久尾行阻止暂存并报告存储故障", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-staged-conflict-")); const path = join(dir, "db.sqlite");
  const store = new SqliteSessionPersistence(path); const injection = new DatabaseSync(path);
  t.after(async () => { injection.close(); await store.close(); await rm(dir, { recursive: true, force: true }); });
  const session = new Session(header); const handle = await store.create(header); await handle.flush();
  const reports: unknown[] = []; store.bindWriter(handle, session, (error) => reports.push(error));
  injection.prepare("INSERT INTO mh_events VALUES (?, ?, ?)").run("s", 0, JSON.stringify(event(0)));
  injection.prepare("UPDATE mh_sessions SET event_count=1 WHERE session_id=?").run("s");
  await assert.rejects(session.commitStaged(() => [{ type: "turn/start", data: { turn: 2 } }]), /前缀/);
  assert.equal(reports.length, 1); assert.equal(session.seq, 0); assert.equal((await handle.read()).length, 1);
});

test("核对时出现额外尾行保持阻塞并在关闭失败后释放写入权", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-staged-conflict-pending-")); const path = join(dir, "db.sqlite");
  const store = new SqliteSessionPersistence(path); const injection = new DatabaseSync(path);
  const session = new Session(header); const handle = await store.create(header); await handle.flush(); store.bindWriter(handle, session, () => {});
  let failRead = false; let loseCommit = true; const prepare = DatabaseSync.prototype.prepare;
  const readFault = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (failRead && sql.startsWith("SELECT header_json, inherited_count, event_count")) { failRead = false; throw new Error("read failure"); }
    return prepare.call(this, sql);
  });
  const writeFault = interceptWrite(t, (_db, sql, execute) => { execute(); if (sql === "COMMIT" && loseCommit) { loseCommit = false; failRead = true; throw new Error("lost response"); } });
  try {
    assert.equal((await session.commitStaged(() => [{ type: "turn/start", data: { turn: 1 } }])).status, "pending-reconciliation");
    injection.prepare("INSERT INTO mh_events VALUES (?, ?, ?)").run("s", 1, JSON.stringify(event(1)));
    injection.prepare("UPDATE mh_sessions SET event_count=2 WHERE session_id=?").run("s");
    await assert.rejects(session.flush(), /冲突/); assert.equal(session.seq, 0);
    assert.throws(() => session.append({ type: "turn/start", data: { turn: 3 } }), /暂存/);
    await assert.rejects(handle.close());
    const replacement = await store.open("s", "write"); assert.ok(replacement); await replacement.close();
  } finally {
    writeFault.mock.restore(); readFault.mock.restore(); injection.close(); await store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("核对拒绝部分批次、内容不符、旧前缀缺号和额外尾行", async (t) => {
  for (const kind of ["partial", "different", "missing-prefix", "extra-tail"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "mh-staged-shape-")); const path = join(dir, "db.sqlite");
    const store = new SqliteSessionPersistence(path); const injection = new DatabaseSync(path);
    const session = new Session(header); session.append({ type: "turn/start", data: { turn: 10 } });
    const handle = await store.create(header); await handle.append(session.snapshot().events); store.bindWriter(handle, session, () => {});
    let failRead = false; let loseCommit = true; const prepare = DatabaseSync.prototype.prepare;
    const readFault = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (failRead && sql.startsWith("SELECT header_json, inherited_count, event_count")) { failRead = false; throw new Error("read failure"); }
      return prepare.call(this, sql);
    });
    const writeFault = interceptWrite(t, (_db, sql, execute) => { execute(); if (sql === "COMMIT" && loseCommit) { loseCommit = false; failRead = true; throw new Error("lost response"); } });
    try {
      const seen: number[] = []; session.on("session/event", ({ seq }) => seen.push(seq));
      const outcome = await session.commitStaged(() => [{ type: "turn/start", data: { turn: 11 } }, { type: "turn/start", data: { turn: 12 } }]);
      assert.equal(outcome.status, "pending-reconciliation", kind);
      if (kind === "partial") injection.prepare("DELETE FROM mh_events WHERE session_id=? AND seq=2").run("s");
      if (kind === "different") injection.prepare("UPDATE mh_events SET event_json=? WHERE session_id=? AND seq=1").run(JSON.stringify(event(1)), "s");
      if (kind === "missing-prefix") injection.prepare("DELETE FROM mh_events WHERE session_id=? AND seq=0").run("s");
      if (kind === "missing-prefix" || kind === "extra-tail") injection.prepare("INSERT INTO mh_events VALUES (?, ?, ?)").run("s", 3, JSON.stringify(event(3)));
      await assert.rejects(session.flush(), /冲突/, kind); assert.equal(session.seq, 1, kind); assert.deepEqual(seen, [], kind);
      assert.throws(() => session.append({ type: "turn/start", data: { turn: 13 } }), /暂存/, kind);
      await assert.rejects(handle.close());
      const replacement = await store.open("s", "write"); assert.ok(replacement); await replacement.close();
    } finally {
      writeFault.mock.restore(); readFault.mock.restore(); injection.close(); await store.close(); await rm(dir, { recursive: true, force: true });
    }
  }
});

test("提交成功但响应丢失时同步核对成功并重开保留完整批次", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-staged-commit-lost-")); const path = join(dir, "db.sqlite");
  const store = new SqliteSessionPersistence(path); const session = new Session(header);
  const handle = await store.create(header); await handle.flush(); store.bindWriter(handle, session);
  let loseCommit = true; const fault = interceptWrite(t, (_db, sql, execute) => {
    execute(); if (sql === "COMMIT" && loseCommit) { loseCommit = false; throw new Error("response lost"); }
  });
  try {
    const notifications: number[] = []; session.on("session/event", ({ seq }) => notifications.push(seq));
    const result = await session.commitStaged(() => [{ type: "turn/start", data: { turn: 1 } }, { type: "step/start", data: { turn: 1, step: 1 } }]);
    assert.equal(result.status, "committed"); assert.deepEqual(notifications, [0, 1]);
    await session.flush(); assert.deepEqual(notifications, [0, 1]);
    fault.mock.restore(); await store.close();
    const reopened = new SqliteSessionPersistence(path, { readOnly: true });
    try { const reader = await reopened.open("s", "read"); assert.ok(reader); assert.deepEqual(await reader.read(), session.snapshot().events); assert.equal((await reopened.stat("s"))?.eventCount, 2); }
    finally { await reopened.close(); }
  } finally { fault.mock.restore(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("预检失败且回滚延迟时，外部相同尾行不能冒充暂存提交", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-preflight-identical-")); const path = join(dir, "db.sqlite");
  const store = new SqliteSessionPersistence(path); const injection = new DatabaseSync(path);
  const session = new Session(header); const handle = await store.create(header); await handle.flush(); store.bindWriter(handle, session, () => {});
  const identical = event(0);
  injection.prepare("INSERT INTO mh_events VALUES (?, ?, ?)").run("s", 0, JSON.stringify(identical));
  injection.prepare("UPDATE mh_sessions SET event_count=1 WHERE session_id=?").run("s");
  let failRollback = true;
  const fault = interceptWrite(t, (_db, sql, execute) => {
    if (sql === "ROLLBACK" && failRollback) { failRollback = false; throw new Error("rollback lost"); }
    execute();
  });
  try {
    const notices: number[] = []; session.on("session/event", ({ seq }) => notices.push(seq));
    const result = await session.commitStaged(() => [{ type: "turn/start", time: 2, data: { turn: 1 } }]);
    assert.equal(result.status, "pending-reconciliation");
    await assert.rejects(session.flush()); assert.equal(session.seq, 0); assert.deepEqual(notices, []);
    await assert.rejects(handle.close());
  } finally { fault.mock.restore(); injection.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("核对读取 BEGIN 已生效后抛错会清理事务并允许重试发布", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-reconcile-begin-")); const path = join(dir, "db.sqlite");
  const store = new SqliteSessionPersistence(path); const session = new Session(header);
  const handle = await store.create(header); await handle.flush(); store.bindWriter(handle, session, () => {});
  let writer: DatabaseSync | undefined; let failBegin = false; let loseCommit = true;
  const original = DatabaseSync.prototype.exec;
  const fault = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE") writer = this;
    if (sql === "BEGIN" && failBegin) { failBegin = false; original.call(this, sql); throw new Error("begin response lost"); }
    original.call(this, sql);
    if (this === writer && sql === "COMMIT" && loseCommit) { loseCommit = false; failBegin = true; throw new Error("commit response lost"); }
  });
  try {
    const seen: number[] = []; session.on("session/event", ({ seq }) => seen.push(seq));
    const result = await session.commitStaged(() => [{ type: "turn/start", data: { turn: 1 } }, { type: "step/start", data: { turn: 1, step: 1 } }]);
    assert.equal(result.status, "pending-reconciliation"); assert.equal(session.seq, 0); assert.deepEqual(seen, []);
    await handle.flush(); assert.equal(session.seq, 2); assert.deepEqual(seen, [0, 1]);
    await session.flush(); assert.deepEqual(seen, [0, 1]); assert.deepEqual(await handle.read(), session.snapshot().events);
  } finally {
    fault.mock.restore();
    try { await store.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("范围读取 BEGIN 已生效后抛错不会污染后续读取", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-read-begin-")); const path = join(dir, "db.sqlite");
  const store = new SqliteSessionPersistence(path); const handle = await store.create(header);
  await handle.append([event(0)]);
  let fail = true; const original = DatabaseSync.prototype.exec;
  const fault = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    original.call(this, sql);
    if (sql === "BEGIN" && fail) { fail = false; throw new Error("begin response lost"); }
  });
  try {
    await assert.rejects(handle.read(), /begin response lost/);
    assert.deepEqual(await handle.read(), [event(0)]);
  } finally { fault.mock.restore(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});
