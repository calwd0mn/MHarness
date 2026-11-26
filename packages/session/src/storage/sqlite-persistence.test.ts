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

test("初始空会话与检查点原子提交并可在只读重开后查询", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-checkpoint-"));
  const path = join(dir, "events.sqlite");
  const store = new SqliteSessionPersistence(path);
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  store.upgradeDirectoryMetadata();
  const pending = await store.create({ sessionId: "pending", createdAt: 1 });
  const blank = await store.create({ sessionId: "blank", createdAt: 2 });
  await blank.flush();
  await blank.close();
  const reader = new SqliteSessionPersistence(path, { readOnly: true });
  try {
    assert.deepEqual(await reader.list(), [{ header: { sessionId: "blank", createdAt: 2 }, inheritedEventCount: 0, eventCount: 0, listMetadata: { blank: true, lastPromptAt: null, eventCount: 0, inheritedEventCount: 0 } }]);
  } finally { await reader.close(); await pending.close(); }
});

test("损坏的目录检查点表在打开时拒绝", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-checkpoint-schema-"));
  const path = join(dir, "events.sqlite");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const store = new SqliteSessionPersistence(path);
  store.upgradeDirectoryMetadata();
  await store.close();
  const db = new DatabaseSync(path);
  db.exec("DROP TABLE mh_session_list_metadata");
  db.close();
  assert.throws(() => new SqliteSessionPersistence(path, { readOnly: true }), /格式/);
});

test("关闭失败后原创建尝试可重试清理且不影响后续事务", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-attempt-cleanup-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const handle = await store.create(header);
  let writer: DatabaseSync | undefined;
  let faulty = true;
  const exec = DatabaseSync.prototype.exec;
  const close = DatabaseSync.prototype.close;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE") writer = this;
    if (this === writer && faulty && (sql === "COMMIT" || sql === "ROLLBACK")) throw new Error("事务故障");
    return exec.call(this, sql);
  });
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    if (this === writer && faulty) throw new Error("连接关闭故障");
    return close.call(this);
  });
  await assert.rejects(handle.flush());
  await assert.rejects(handle.close());
  assert.equal(await handle.confirmCreationEnded?.(), false);
  assert.equal(await store.stat("s"), undefined);
  faulty = false;
  assert.equal(await handle.confirmCreationEnded?.(), true);
  assert.equal(await store.stat("s"), undefined);
  const next = await store.create({ sessionId: "next", createdAt: 2 });
  await next.flush();
  assert.equal(await handle.confirmCreationEnded?.(), true);
  assert.ok(await store.stat("next"));
  await next.close();
});

test("旧版本只读打开与拒绝升级不修改数据库", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-checkpoint-readonly-"));
  const path = join(dir, "events.sqlite");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const old = new SqliteSessionPersistence(path);
  const handle = await old.create(header);
  await handle.flush(); await handle.close(); await old.close();
  const before = await readFile(path);
  const reader = new SqliteSessionPersistence(path, { readOnly: true });
  assert.equal((await reader.list())[0]?.listMetadata, undefined);
  assert.throws(() => reader.upgradeDirectoryMetadata(), /只读/);
  await reader.close();
  assert.deepEqual(await readFile(path), before);
});

test("首次创建核实不依赖陈旧的共享读取", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-fresh-creation-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const create = store.create.bind(store);
  t.mock.method(store, "create", async (...args: Parameters<typeof create>) => {
    const handle = await create(...args);
    const flush = handle.flush.bind(handle);
    t.mock.method(handle, "flush", async () => { await flush(); throw new Error("丢失回执"); });
    return handle;
  });
  t.mock.method(store, "stat", async () => undefined);
  const { createPersistedSession } = await import("../api/use-cases.ts");
  assert.equal((await createPersistedSession(store, header)).status, "committed");
});

test("首次新读缺失后事务确认期间出现提交，第二次新读发现会话", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-creation-second-read-"));
  const path = join(dir, "db.sqlite");
  const store = new SqliteSessionPersistence(path);
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const handle = await store.create(header);
  const verify = handle.creationVerifier!();
  await handle.close();
  const close = DatabaseSync.prototype.close;
  let injected = false;
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    close.call(this);
    if (!injected) {
      injected = true;
      const writer = new DatabaseSync(path);
      try { writer.prepare("INSERT INTO mh_sessions VALUES (?, ?, 0, 0)").run(header.sessionId, JSON.stringify(header)); }
      finally { close.call(writer); }
    }
  });
  assert.equal(await verify(), "committed");
});

test("WAL 共享连接停留旧快照时首次创建核实仍读到提交", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-wal-stale-"));
  const path = join(dir, "db.sqlite");
  const store = new SqliteSessionPersistence(path);
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const setup = new DatabaseSync(path);
  setup.exec("PRAGMA journal_mode=WAL"); setup.close();
  const prepare = DatabaseSync.prototype.prepare;
  let shared: DatabaseSync | undefined;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql === "SELECT * FROM mh_sessions WHERE session_id=?" && !shared) shared = this;
    return prepare.call(this, sql);
  });
  await store.stat(header.sessionId);
  assert.ok(shared);
  shared.exec("BEGIN");
  assert.equal(prepare.call(shared, "SELECT * FROM mh_sessions WHERE session_id=?").get(header.sessionId), undefined);
  const create = store.create.bind(store);
  t.mock.method(store, "create", async (...args: Parameters<typeof create>) => {
    const handle = await create(...args);
    const flush = handle.flush.bind(handle);
    t.mock.method(handle, "flush", async () => { await flush(); throw new Error("丢失回执"); });
    return handle;
  });
  try {
    const { createPersistedSession } = await import("../api/use-cases.ts");
    assert.equal((await createPersistedSession(store, header)).status, "committed");
    assert.equal(await store.stat(header.sessionId), undefined);
  } finally { shared.exec("ROLLBACK"); }
  assert.ok(await store.stat(header.sessionId));
});

test("首次创建未提交但锁释放未确认时保持未知并在恢复后失败", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-create-lock-fault-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const create = store.create.bind(store);
  let fail = true;
  let lockConnection: DatabaseSync | undefined;
  const close = DatabaseSync.prototype.close;
  t.mock.method(store, "create", async (...args: Parameters<typeof create>) => {
    const handle = await create(...args);
    t.mock.method(handle, "flush", async () => { throw new Error("flush fault"); });
    t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
      if (fail && (!lockConnection || lockConnection === this)) { lockConnection = this; throw new Error("lock close fault"); }
      return close.call(this);
    });
    return handle;
  });
  const { createPersistedSession } = await import("../api/use-cases.ts");
  const result = await createPersistedSession(store, header, () => {});
  assert.equal(result.status, "unknown");
  if (result.status !== "unknown") throw new Error("预期未知结果");
  fail = false;
  assert.equal(await result.verify(), "failed");
  const next = await store.create(header);
  await next.close();
});

test("原创建事务核实不会回滚或释放同句柄后续事务的写入权", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-creation-transaction-token-"));
  const path = join(dir, "db.sqlite");
  const store = new SqliteSessionPersistence(path);
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const handle = await store.create(header);
  const verify = handle.creationVerifier!();
  let commits = 0;
  let verification: Promise<"committed" | "failed" | "unknown"> | undefined;
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "COMMIT" && ++commits === 1) throw new Error("首次失败");
    if (sql === "COMMIT" && commits === 2) verification = verify();
    return exec.call(this, sql);
  });
  await assert.rejects(handle.flush());
  await handle.flush();
  assert.equal(await verification, "unknown");
  await assert.rejects(store.open(header.sessionId, "write"));
  await handle.close();
});

test("已提交会话的锁关闭失败后由存储重试释放", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-storage-lock-retry-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  const handle = await store.create(header);
  await handle.flush();
  const close = DatabaseSync.prototype.close;
  let fail = true;
  let lock: DatabaseSync | undefined;
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    if (fail && (!lock || lock === this)) { lock = this; throw new Error("lock close fault"); }
    return close.call(this);
  });
  try {
    await assert.rejects(handle.close(), /lock close fault/);
    await assert.rejects(store.open("s", "write"), { name: "OwnershipConflictError" });
    fail = false;
    await new Promise(resolve => setTimeout(resolve, 600));
    const next = await store.open("s", "write");
    assert.ok(next);
    await next.close();
  } finally { fail = false; await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("创建准备失败且锁未释放时保留核实能力", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-storage-prepare-lock-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  const controller = new AbortController();
  const exec = DatabaseSync.prototype.exec;
  const close = DatabaseSync.prototype.close;
  let lock: DatabaseSync | undefined;
  let fail = true;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    exec.call(this, sql);
    if (sql === "PRAGMA busy_timeout = 0; BEGIN IMMEDIATE") { lock = this; controller.abort(); }
  });
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    if (fail && this === lock) throw new Error("lock close fault");
    return close.call(this);
  });
  try {
    const { createPersistedSession } = await import("../api/use-cases.ts");
    const originalCreate = store.create.bind(store);
    t.mock.method(store, "create", (value: Parameters<typeof originalCreate>[0]) => originalCreate(value, { signal: controller.signal }));
    const result = await createPersistedSession(store, header);
    assert.equal(result.status, "unknown");
    if (result.status !== "unknown") throw new Error("预期未知结果");
    assert.equal(await result.verify(), "unknown");
    await assert.rejects(originalCreate(header), { name: "OwnershipConflictError" });
    fail = false;
    assert.equal(await result.verify(), "failed");
    const next = await originalCreate(header);
    await next.close();
  } finally { fail = false; await store.close(); await rm(dir, { recursive: true, force: true }); }
});


test("存储关闭时停止重试并汇总未释放的锁错误", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-storage-close-retry-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  const handle = await store.create(header);
  await handle.flush();
  const close = DatabaseSync.prototype.close;
  let lock: DatabaseSync | undefined;
  let attempts = 0;
  let fail = true;
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    if (fail && (!lock || lock === this)) { lock = this; attempts++; throw new Error("lock close fault"); }
    return close.call(this);
  });
  try {
    await assert.rejects(handle.close(), /lock close fault/);
    await assert.rejects(store.close(), (error: unknown) => error instanceof AggregateError && error.errors.some((item: unknown) => item instanceof Error && /lock close fault/.test(item.message)));
    const stopped = attempts;
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(attempts, stopped);
  } finally { fail = false; if (lock?.isOpen) close.call(lock); await rm(dir, { recursive: true, force: true }); }
});

test("并发核实同一未释放锁只保留一个后台重试", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-storage-concurrent-cleanup-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  const handle = await store.create(header);
  const verify = handle.creationVerifier!();
  const close = DatabaseSync.prototype.close;
  let lock: DatabaseSync | undefined;
  let attempts = 0;
  let fail = true;
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    if (fail && (!lock || lock === this)) { lock = this; attempts++; throw new Error("lock close fault"); }
    return close.call(this);
  });
  try {
    await assert.rejects(handle.close(), /lock close fault/);
    assert.deepEqual(await Promise.all([verify(), verify()]), ["unknown", "unknown"]);
    await assert.rejects(store.close(), AggregateError);
    const before = attempts;
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(attempts, before);
  } finally { fail = false; if (lock?.isOpen) close.call(lock); await rm(dir, { recursive: true, force: true }); }
});

test("关闭扫尾等待在途释放失败后独立重试", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-close-race-"));
  const path = join(dir, "db.sqlite"); const store = new SqliteSessionPersistence(path);
  const handle = await store.create(header); await handle.flush();
  const close = DatabaseSync.prototype.close; let failures = 0; let lock: DatabaseSync | undefined;
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    if (this.isTransaction && failures++ === 0) { lock = this; throw new Error("transient close"); }
    return close.call(this);
  });
  try {
    const releasing = handle.close();
    const closing = store.close();
    await assert.rejects(releasing, /transient close/);
    await closing;
    const { acquireSessionOwnership } = await import("./ownership.ts");
    const next = await acquireSessionOwnership(path, header.sessionId); await next.release();
  } finally { if (lock?.isOpen) close.call(lock); await rm(dir, { recursive: true, force: true }); }
});

test("取得锁后回执丢失且关闭失败时创建保持未知直到释放", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-acquire-receipt-"));
  const path = join(dir, "db.sqlite"); const store = new SqliteSessionPersistence(path);
  const exec = DatabaseSync.prototype.exec; const close = DatabaseSync.prototype.close;
  let lock: DatabaseSync | undefined; let fail = true;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    exec.call(this, sql);
    if (sql === "PRAGMA busy_timeout = 0; BEGIN IMMEDIATE" && !lock) { lock = this; throw new Error("lost receipt"); }
  });
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    if (fail && this === lock) throw new Error("close fault"); return close.call(this);
  });
  try {
    const { createPersistedSession } = await import("../api/use-cases.ts");
    const result = await createPersistedSession(store, header);
    assert.equal(result.status, "unknown");
    if (result.status !== "unknown") throw new Error("预期未知结果");
    assert.equal(await result.verify(), "unknown");
    fail = false;
    assert.equal(await result.verify(), "failed");
    const next = await store.create(header); await next.close();
  } finally { fail = false; await store.close(); if (lock?.isOpen) close.call(lock); await rm(dir, { recursive: true, force: true }); }
});

test("打开写句柄时取得锁回执丢失会后台释放遗留锁", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-open-acquire-receipt-"));
  const path = join(dir, "db.sqlite"); const store = new SqliteSessionPersistence(path);
  const handle = await store.create(header); await handle.flush(); await handle.close();
  const exec = DatabaseSync.prototype.exec; const close = DatabaseSync.prototype.close;
  let lock: DatabaseSync | undefined; let fail = true;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    exec.call(this, sql);
    if (sql === "PRAGMA busy_timeout = 0; BEGIN IMMEDIATE" && !lock) { lock = this; throw new Error("lost receipt"); }
  });
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    if (fail && this === lock) throw new Error("close fault"); return close.call(this);
  });
  try {
    await assert.rejects(store.open(header.sessionId, "write"), /清理待确认/);
    fail = false;
    await new Promise(resolve => setTimeout(resolve, 600));
    const next = await store.open(header.sessionId, "write"); assert.ok(next); await next.close();
  } finally { fail = false; await store.close(); if (lock?.isOpen) close.call(lock); await rm(dir, { recursive: true, force: true }); }
});

test("主库开始事务回执丢失且清理受阻时保持未知，恢复后确认失败", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-main-begin-receipt-"));
  const path = join(dir, "db.sqlite"); const store = new SqliteSessionPersistence(path);
  const exec = DatabaseSync.prototype.exec; const close = DatabaseSync.prototype.close;
  let writer: DatabaseSync | undefined; let fail = true;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && !writer) {
      writer = this; exec.call(this, sql); throw new Error("begin receipt lost");
    }
    if (this === writer && sql === "ROLLBACK" && fail) throw new Error("rollback fault");
    return exec.call(this, sql);
  });
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    if (this === writer && fail) throw new Error("writer close fault");
    return close.call(this);
  });
  try {
    const { createPersistedSession } = await import("../api/use-cases.ts");
    const result = await createPersistedSession(store, header, () => {});
    assert.equal(result.status, "unknown");
    if (result.status !== "unknown") throw new Error("预期未知结果");
    assert.equal(await result.verify(), "unknown");
    assert.equal(writer?.isTransaction, true);
    fail = false;
    assert.equal(await result.verify(), "failed");
    assert.equal(writer?.isTransaction, false);
    const next = await store.create(header); await next.flush(); await next.close();
  } finally { fail = false; await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("首次批次回滚后重试会核实新的创建事务", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-create-retry-token-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  const handle = await store.create(header); const verify = handle.creationVerifier!();
  const exec = DatabaseSync.prototype.exec; const close = DatabaseSync.prototype.close;
  let writer: DatabaseSync | undefined; let begins = 0; let fail = true;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE") {
      writer = this; begins++; exec.call(this, sql);
      if (begins === 2) throw new Error("begin receipt lost");
      return;
    }
    if (this === writer && sql === "COMMIT" && begins === 1) throw new Error("first commit failed");
    if (this === writer && sql === "ROLLBACK" && begins === 2 && fail) throw new Error("rollback fault");
    return exec.call(this, sql);
  });
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    if (this === writer && fail) throw new Error("close fault"); return close.call(this);
  });
  try {
    await assert.rejects(handle.flush());
    await assert.rejects(handle.flush());
    await assert.rejects(handle.close());
    assert.equal(await verify(), "unknown");
    fail = false;
    assert.equal(await verify(), "failed");
  } finally { fail = false; await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("存储关闭写连接后仍能核实未提交的创建", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-create-closed-writer-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  const handle = await store.create(header); const verify = handle.creationVerifier!();
  const exec = DatabaseSync.prototype.exec; const close = DatabaseSync.prototype.close;
  let writer: DatabaseSync | undefined; let fail = true;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE") { writer = this; exec.call(this, sql); throw new Error("begin receipt lost"); }
    if (this === writer && sql === "ROLLBACK" && fail) throw new Error("rollback fault");
    return exec.call(this, sql);
  });
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    if (this === writer && fail) throw new Error("close fault"); return close.call(this);
  });
  try {
    await assert.rejects(handle.flush()); await assert.rejects(handle.close());
    assert.equal(await verify(), "unknown");
    fail = false; await store.close();
    assert.equal(await verify(), "failed");
  } finally { fail = false; if (writer?.isOpen) close.call(writer); await rm(dir, { recursive: true, force: true }); }
});

test("活跃句柄的旧核实不会中断重试中的初始事务", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-verify-retry-")); const path = join(dir, "db.sqlite");
  const store = new SqliteSessionPersistence(path); const handle = await store.create(header); const verify = handle.creationVerifier!();
  const exec = DatabaseSync.prototype.exec; const prepare = DatabaseSync.prototype.prepare;
  let begins = 0; let verification: Promise<"committed" | "failed" | "unknown"> | undefined;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && ++begins === 1) throw new Error("首次失败");
    const result = exec.call(this, sql);
    if (sql === "BEGIN IMMEDIATE" && begins === 2) verification = verify();
    return result;
  });
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql === "INSERT INTO mh_events VALUES (?, ?, ?)" && begins === 2) throw new Error("事件写入失败");
    return prepare.call(this, sql);
  });
  try {
    await assert.rejects(handle.append([event(0)]));
    await assert.rejects(handle.append([event(0)]));
    assert.equal(await verification, "unknown");
    assert.equal(await store.stat(header.sessionId), undefined);
    const db = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mh_events").get()?.count, 0); } finally { db.close(); }
  } finally { t.mock.restoreAll(); await handle.close().catch(() => {}); await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("活跃句柄的核实可确认已提交的同身份头", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-verify-live-")); const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const handle = await store.create(header); const verify = handle.creationVerifier!(); await handle.flush();
  assert.equal(await verify(), "committed");
});

test("旧创建标记不会使核实清理后续目录迁移事务", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-verify-migration-")); const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  const handle = await store.create(header); const verify = handle.creationVerifier!();
  const exec = DatabaseSync.prototype.exec; let writer: DatabaseSync | undefined; let failBegin = true; let failMigration = true;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && failBegin) { failBegin = false; writer = this; exec.call(this, sql); throw new Error("BEGIN 回执丢失"); }
    if (sql.startsWith("BEGIN IMMEDIATE;\n        CREATE TABLE") && failMigration) { exec.call(this, "BEGIN IMMEDIATE"); throw new Error("迁移失败"); }
    if (this === writer && sql === "ROLLBACK" && failMigration && !failBegin && this.isTransaction && migrationStarted) throw new Error("迁移回滚失败");
    return exec.call(this, sql);
  });
  let migrationStarted = false;
  try {
    await assert.rejects(handle.flush()); await handle.close();
    migrationStarted = true; assert.throws(() => store.upgradeDirectoryMetadata());
    assert.equal(await verify(), "failed");
    assert.equal(writer?.isOpen, true); assert.equal(writer?.isTransaction, true);
  } finally { failMigration = false; if (writer?.isOpen && writer.isTransaction) exec.call(writer, "ROLLBACK"); t.mock.restoreAll(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const afterClose of [false, true]) test(`关闭写连接${afterClose ? "后" : "前"}报错时核实事务`, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-verify-close-")); const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  const handle = await store.create(header); const verify = handle.creationVerifier!();
  const exec = DatabaseSync.prototype.exec; const close = DatabaseSync.prototype.close; let writer: DatabaseSync | undefined; let fault = true; let closes = 0;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE") writer = this;
    if (this === writer && fault && (sql === "COMMIT" || sql === "ROLLBACK")) throw new Error("事务故障");
    return exec.call(this, sql);
  });
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    if (this === writer && fault) { if (afterClose && ++closes > 1) close.call(this); throw new Error("关闭故障"); }
    return close.call(this);
  });
  try {
    await assert.rejects(handle.flush()); await assert.rejects(handle.close());
    assert.equal(await verify(), afterClose ? "failed" : "unknown");
    fault = false; assert.equal(await verify(), "failed");
  } finally { fault = false; t.mock.restoreAll(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("关闭中的公开事务确认等待写入与关闭结束", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-confirm-close-order-")); const path = join(dir, "db.sqlite");
  const store = new SqliteSessionPersistence(path); const handle = await store.create(header); const verify = handle.creationVerifier!();
  const exec = DatabaseSync.prototype.exec; const prepare = DatabaseSync.prototype.prepare;
  let activeDuringWrite = false; let closing: Promise<void> | undefined; let confirmation: Promise<boolean> | undefined; let verification: Promise<"committed" | "failed" | "unknown"> | undefined;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    const result = exec.call(this, sql);
    if (sql === "BEGIN IMMEDIATE") {
      closing = handle.close(); confirmation = handle.confirmCreationEnded!(); verification = verify();
      activeDuringWrite = this.isTransaction;
    }
    return result;
  });
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql === "INSERT INTO mh_events VALUES (?, ?, ?)") throw new Error("事件写入失败");
    return prepare.call(this, sql);
  });
  try {
    await assert.rejects(handle.append([event(0)])); await closing;
    assert.equal(activeDuringWrite, true); assert.equal(await confirmation, true); assert.equal(await verification, "failed");
    assert.equal(await store.stat(header.sessionId), undefined);
  } finally { t.mock.restoreAll(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});
