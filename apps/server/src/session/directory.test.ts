import assert from "node:assert/strict";
import { test } from "node:test";
import { Session, SqliteSessionPersistence, type SessionPersistence } from "@mharness/session/server";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
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
  const fixture = new DatabaseSync(join(dir, "events.sqlite"));
  fixture.prepare("DELETE FROM mh_session_list_metadata WHERE session_id=?").run("active");
  fixture.close();
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

test("业务监听新增和撤回按版本交付并隔离摘要", () => {
  const directory = new SessionDirectory();
  const frames: unknown[] = []; const added: unknown[] = []; const removed: string[] = [];
  const observedBlank: boolean[] = [];
  directory.on("api-session/added", summary => { added.push({ ...summary }); Reflect.set(summary, "blank", false); });
  const off = directory.on("api-session/removed", id => removed.push(id));
  directory.onObservation(frame => { frames.push(structuredClone(frame)); if (frame.type === "api-session/added") Reflect.set(frame.summary, "blank", false); });
  directory.onObservation(frame => { if (frame.type === "api-session/added") observedBlank.push(frame.summary.blank); });
  const session = new Session({ sessionId: "new", createdAt: 1 });
  assert.equal(directory.register(session, true), true);
  assert.equal(directory.register(session, true), false);
  assert.equal(directory.snapshot().sessions[0]?.blank, true);
  directory.confirm("new");
  assert.equal(directory.snapshot().revision, 1);
  directory.remove("new"); directory.remove("new"); off(); off();
  directory.register(new Session({ sessionId: "other", createdAt: 2 }), true); directory.remove("other");
  assert.deepEqual(observedBlank, [true, true]);
  assert.deepEqual(added, [
    { sessionId: "new", createdAt: 1, updatedAt: 1, running: false, blank: true },
    { sessionId: "other", createdAt: 2, updatedAt: 2, running: false, blank: true },
  ]);
  assert.deepEqual(removed, ["new"]);
  assert.deepEqual(frames, [
    { type: "api-session/added", revision: 1, summary: added[0] },
    { type: "api-session/removed", revision: 2, sessionId: "new", reason: "creation-failed" },
    { type: "api-session/added", revision: 3, summary: added[1] },
    { type: "api-session/removed", revision: 4, sessionId: "other", reason: "creation-failed" },
  ]);
});

test("业务监听同步重入保持完整帧顺序", () => {
  const directory = new SessionDirectory(); const revisions: number[] = [];
  directory.on("api-session/added", summary => { if (summary.sessionId === "a") directory.register(new Session({ sessionId: "b", createdAt: 2 })); });
  directory.onObservation(frame => { if ("revision" in frame) revisions.push(frame.revision); });
  directory.register(new Session({ sessionId: "a", createdAt: 1 }));
  assert.deepEqual(revisions, [1, 2]);
});

test("监听器抛错不阻止后续监听和目录版本", (t) => {
  const directory = new SessionDirectory(); const received: string[] = [];
  t.mock.method(console, "error", () => {});
  directory.on("api-session/added", () => { throw new Error("listener failure"); });
  directory.on("api-session/added", summary => received.push(summary.sessionId));
  directory.register(new Session({ sessionId: "safe", createdAt: 1 }));
  assert.deepEqual(received, ["safe"]); assert.equal(directory.snapshot().revision, 1);
});

test("业务监听参数类型随事件收窄", () => {
  const directory = new SessionDirectory();
  directory.on("api-session/updated", (id, blank, seq) => { const values: [string, false, number] = [id, blank, seq]; assert.equal(values.length, 3); });
  if (false) {
    // @ts-expect-error updated 的第二个参数固定为 false。
    directory.on("api-session/updated", (_id: string, _blank: true) => {});
    // @ts-expect-error 未定义的事件不可订阅。
    directory.on("api-session/unknown", () => {});
  }
});
