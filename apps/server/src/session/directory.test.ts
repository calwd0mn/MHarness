import assert from "node:assert/strict";
import { test } from "node:test";
import { Session, SqliteSessionPersistence, type SessionPersistence } from "@mharness/session/server";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sessionDirectoryFrameSchema, sessionDirectorySnapshotSchema } from "@mharness/session/contracts";
import { SessionDirectory } from "./directory.ts";

test("目录快照排序并只在实际新增和撤回时推进版本", () => {
  const directory = new SessionDirectory();
  assert.deepEqual(directory.snapshot(), { revision: 0, sessions: [] });
  assert.equal(directory.register(new Session({ sessionId: "b", createdAt: 1 })), true);
  directory.register(new Session({ sessionId: "a", createdAt: 1 }));
  directory.register(new Session({ sessionId: "c", createdAt: 2 }));
  assert.equal(directory.register(new Session({ sessionId: "a", createdAt: 9 })), false);
  assert.deepEqual(directory.snapshot().sessions.map((item) => item.sessionId), ["c", "a", "b"]);
  assert.equal(directory.snapshot().revision, 3);
  directory.remove("a"); directory.remove("a");
  assert.equal(directory.snapshot().revision, 4);
});

test("完整初始日志决定空状态和单调活动时间", () => {
  const source = new Session({ sessionId: "parent", createdAt: 1 });
  source.append({ type: "turn/start", time: 2, data: { turn: 1 } });
  source.append({ type: "user/message", time: 5, surfaceOp: "append", data: { id: "u", role: "user", source: { kind: "user" }, turn: 1, requestId: "r", content: [] } });
  const child = new Session({ sessionId: "child", createdAt: 3, isSeeded: true, parentSession: "parent" }, { seed: { kind: "fork", events: source.snapshot().events } });
  const directory = new SessionDirectory([child]);
  assert.deepEqual(directory.snapshot(), { revision: 0, sessions: [{ sessionId: "child", createdAt: 3, updatedAt: 5, running: false, blank: false, parentSessionId: "parent" }] });
});

test("契约限制安全整数并严格区分变更、就绪和错误帧", () => {
  assert.equal(sessionDirectorySnapshotSchema.safeParse({ revision: Number.MAX_SAFE_INTEGER + 1, sessions: [] }).success, false);
  assert.equal(sessionDirectoryFrameSchema.safeParse({ type: "api-session/ready", revision: 0 }).success, false);
  assert.equal(sessionDirectoryFrameSchema.safeParse({ type: "api-session/error", sessionId: "s", message: "错误" }).success, true);
  assert.equal(sessionDirectoryFrameSchema.safeParse({ type: "api-session/updated", sessionId: "s", revision: 1, blank: false, seq: -1 }).success, false);
});

test("恢复使用检查点而不打开事件日志", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-restore-directory-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  t.after(async () => { await persistence.close(); await rm(dir, { recursive: true, force: true }); });
  persistence.upgradeDirectoryMetadata();
  const uncommitted = await persistence.create({ sessionId: "pending", createdAt: 1 });
  const blank = await persistence.create({ sessionId: "blank", createdAt: 2 });
  await blank.flush(); await blank.close();
  const active = await persistence.create({ sessionId: "active", createdAt: 3 });
  await active.append([{ type: "turn/start", seq: 0, time: 4, data: { turn: 1 } },
    { type: "user/message", seq: 1, time: 9, surfaceOp: "append", data: { id: "u", role: "user", source: { kind: "user" }, turn: 1, requestId: "r", content: [] } }]);
  await active.close();
  t.mock.method(persistence, "open", async () => { throw new Error("不应读取日志"); });
  const directory = await SessionDirectory.restore(persistence);
  assert.deepEqual(directory.snapshot(), { revision: 0, sessions: [
    { sessionId: "active", createdAt: 3, updatedAt: 3, running: false, blank: false },
    { sessionId: "blank", createdAt: 2, updatedAt: 2, running: false, blank: true },
  ] });
  await uncommitted.close();

});

test("在线目录投影随接受事件增量更新", () => {
  const session = new Session({ sessionId: "projection", createdAt: 1 });
  assert.deepEqual(session.listMetadata, { blank: true, lastPromptAt: null });
  session.append({ type: "turn/start", time: 2, data: { turn: 1 } });
  session.append({ type: "user/message", time: 5, surfaceOp: "append", data: { id: "u", role: "user", source: { kind: "user" }, turn: 1, requestId: "r", content: [] } });
  assert.deepEqual(session.listMetadata, { blank: false, lastPromptAt: 5 });
});

test("清单读取期间发布分支后重读以覆盖注册版本", async () => {
  const directory = new SessionDirectory();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const branch = new Session({ sessionId: "branch", createdAt: 1, isSeeded: true, parentSession: "parent" }, { seed: { kind: "fork", events: [] } });
  let calls = 0;
  const persistence = { list: async () => {
    if (++calls === 1) { entered(); await gate; return []; }
    return [{ header: branch.header, inheritedEventCount: 0, eventCount: 1 }];
  } } as Pick<SessionPersistence, "list">;
  const query = directory.query(persistence, () => ({ session: branch, state: "idle" }));
  await reached;
  directory.register(branch);
  release();
  const result = await query;
  assert.equal(calls, 2);
  assert.equal(result.revision, 1);
  assert.equal(result.sessions[0]?.sessionId, "branch");
});

test("批次追加保留已有目录投影并推进活动时间", () => {
  const session = new Session({ sessionId: "batch", createdAt: 1 });
  session.append({ type: "turn/start", time: 2, data: { turn: 1 } });
  session.append({ type: "user/message", time: 9, surfaceOp: "append", data: { id: "u", role: "user", source: { kind: "user" }, turn: 1, requestId: "r", content: [] } });
  session.appendBatch(() => [{ type: "turn/end", time: 10, data: { turn: 1, reason: { kind: "completed" } } }]);
  assert.deepEqual(session.listMetadata, { blank: false, lastPromptAt: 9 });
});

test("损坏检查点只降级对应会话", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-bad-checkpoint-"));
  const path = join(dir, "events.sqlite");
  const persistence = new SqliteSessionPersistence(path);
  t.after(async () => { await persistence.close(); await rm(dir, { recursive: true, force: true }); });
  persistence.upgradeDirectoryMetadata();
  for (const [sessionId, createdAt] of [["blank", 1], ["overflow", 2], ["activity", 3]] as const) {
    const handle = await persistence.create({ sessionId, createdAt });
    await handle.flush(); await handle.close();
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec("UPDATE mh_session_list_metadata SET last_prompt_at=9223372036854775807 WHERE session_id='overflow'; UPDATE mh_session_list_metadata SET last_prompt_at=10 WHERE session_id='activity'");
  } finally { db.close(); }
  await persistence.close();
  const { createEventSessionApp } = await import("../app.ts");
  const app = await createEventSessionApp(path);
  const response = await app.inject({ method: "GET", url: "/api/sessions" });
  assert.equal(response.statusCode, 200);
  const result = response.json() as { revision: number; sessions: unknown[] };
  await app.close();
  assert.equal(result.revision, 0);
  assert.deepEqual(result.sessions, [
    { sessionId: "activity", createdAt: 3, updatedAt: 3, running: false, blank: false },
    { sessionId: "overflow", createdAt: 2, updatedAt: 2, running: false, blank: false },
    { sessionId: "blank", createdAt: 1, updatedAt: 1, running: false, blank: true },
  ]);
});
