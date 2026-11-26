import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, type IncomingMessage } from "node:http";
import { test } from "node:test";
import { sessionDirectoryFrameSchema, type SessionDirectoryFrame } from "@mharness/session/contracts";
import { Session, SqliteSessionPersistence } from "@mharness/session/server";
import { createEventSessionApp } from "../app.ts";

async function connect(base: string) {
  const request = get(`${base}/api/session-directory/events`, { agent: false, headers: { connection: "close" } });
  const response = await new Promise<IncomingMessage>((resolve, reject) => { request.once("response", resolve); request.once("error", reject); });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /^text\/event-stream/);
  const closed = new Promise<void>((resolve) => response.once("close", resolve));
  const reader = response[Symbol.asyncIterator]();
  const decoder = new TextDecoder();
  let buffer = "";
  const nextBlock = async (): Promise<string> => {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        return frame;
      }
      const chunk = await reader.next();
      assert.equal(chunk.done, false, "目录连接提前关闭");
      if (!(chunk.value instanceof Uint8Array)) throw new Error("目录帧不是字节数据");
      buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
    }
  };
  return {
    abort: { abort: () => request.destroy() },
    closed,
    nextBlock,
    async next(): Promise<SessionDirectoryFrame> {
      for (;;) {
        const frame = await nextBlock();
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data) return sessionDirectoryFrameSchema.parse(JSON.parse(data));
      }
    },
  };
}

test("真实目录连接首先收到 ready", { timeout: 10000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-sse-ready-"));
  const app = await createEventSessionApp(join(dir, "events.sqlite"));
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const stream = await connect(base);
  try { assert.deepEqual(await stream.next(), { type: "api-session/ready" }); } finally { stream.abort.abort(); }
});

test("两个真实连接按序接收创建、运行、活动、错误、空闲和撤回", { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-sse-live-")); const path = join(dir, "events.sqlite");
  let finish!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const app = await createEventSessionApp(path, false, async (context) => {
    context.publish({ type: "agent/error", turn: context.turn, message: "公开错误" }); entered(); await gate;
  });
  t.after(async () => { finish(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const a = await connect(base); const b = await connect(base);
  try {
    assert.deepEqual(await a.next(), { type: "api-session/ready" });
    assert.deepEqual(await b.next(), { type: "api-session/ready" });
    const both = async () => { const [left, right] = await Promise.all([a.next(), b.next()]); assert.deepEqual(left, right); return left; };
    const originalNow = Date.now; let now = originalNow();
    t.mock.method(Date, "now", () => now);
    const created = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(created.status, 201); const { sessionId } = await created.json() as { sessionId: string };
    const added = await both(); assert.equal(added.type, "api-session/added");
    if (added.type !== "api-session/added") throw new Error("预期新增帧");
    assert.equal(added.revision, 1); assert.equal(added.summary.sessionId, sessionId); assert.equal(added.summary.blank, true);
    now += 100;
    const prompt = await fetch(`${base}/api/sessions/${sessionId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "r", content: [{ type: "text", text: "hello" }] }) });
    assert.equal(prompt.status, 202); await reached;
    assert.deepEqual(await both(), { type: "api-session/status", sessionId, running: true, revision: 2 });
    assert.deepEqual(await both(), { type: "api-session/updated", sessionId, blank: false, seq: 0, revision: 3 });
    assert.deepEqual(await both(), { type: "api-session/activity", sessionId, updatedAt: now, revision: 4 });
    assert.deepEqual(await both(), { type: "api-session/error", sessionId, message: "公开错误" });
    finish(); assert.deepEqual(await both(), { type: "api-session/status", sessionId, running: false, revision: 5 });
    const create = SqliteSessionPersistence.prototype.create;
    t.mock.method(SqliteSessionPersistence.prototype, "create", async function (this: SqliteSessionPersistence, ...args: Parameters<typeof create>) {
      const handle = await create.apply(this, args);
      t.mock.method(handle, "flush", async () => { throw new Error("创建失败"); });
      return handle;
    });
    const failed = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(failed.status, 500);
    const pending = await both(); assert.equal(pending.type, "api-session/added");
    if (pending.type !== "api-session/added") throw new Error("预期待确认新增");
    assert.equal(pending.revision, 6);
    assert.deepEqual(await both(), { type: "api-session/removed", sessionId: pending.summary.sessionId, reason: "creation-failed", revision: 7 });
  } finally { a.abort.abort(); b.abort.abort(); }
});

test("订阅不扫描清单，GET 安静补齐分支并校正冷摘要", { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-sse-query-")); const path = join(dir, "events.sqlite");
  const fixture = new SqliteSessionPersistence(path); fixture.upgradeDirectoryMetadata();
  const cold = await fixture.create({ sessionId: "cold", createdAt: 1 }); await cold.flush(); await cold.close();
  const { DatabaseSync } = await import("node:sqlite"); const db = new DatabaseSync(path);
  db.exec("DELETE FROM mh_session_list_metadata WHERE session_id='cold'");
  const app = await createEventSessionApp(path);
  t.after(async () => { await app.close(); db.close(); await fixture.close(); await rm(dir, { recursive: true, force: true }); });
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const list = SqliteSessionPersistence.prototype.list; const open = SqliteSessionPersistence.prototype.open;
  let lists = 0; let opens = 0;
  t.mock.method(SqliteSessionPersistence.prototype, "list", async function (this: SqliteSessionPersistence) { lists++; return list.call(this); });
  t.mock.method(SqliteSessionPersistence.prototype, "open", async function (this: SqliteSessionPersistence, ...args: Parameters<typeof open>) { opens++; return open.apply(this, args); });
  const a = await connect(base); const b = await connect(base);
  try {
    assert.deepEqual(await a.next(), { type: "api-session/ready" }); assert.deepEqual(await b.next(), { type: "api-session/ready" });
    const child = new Session({ sessionId: "branch", createdAt: 2, isSeeded: true, parentSession: "cold" }, { seed: { kind: "fork", events: [] } });
    const branch = await fixture.create(child.header, { inheritedEventCount: 0 }); await branch.append(child.snapshot().events); await branch.close();
    db.prepare("INSERT INTO mh_session_list_metadata VALUES (?, 1, NULL, 0, 0)").run("cold");
    assert.equal(lists, 0); assert.equal(opens, 0);
    const snapshot = await (await fetch(`${base}/api/sessions`)).json() as { revision: number; sessions: { sessionId: string; blank: boolean }[] };
    assert.equal(snapshot.revision, 0); assert.equal(snapshot.sessions.find((item) => item.sessionId === "branch")?.blank, true);
    assert.equal(snapshot.sessions.find((item) => item.sessionId === "cold")?.blank, true);
    assert.equal(lists, 1); assert.equal(opens, 0);
    const secondSnapshot = await (await fetch(`${base}/api/sessions`)).json() as typeof snapshot;
    assert.deepEqual(secondSnapshot, snapshot); assert.equal(lists, 2); assert.equal(opens, 0);
    const mark = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(mark.status, 201); const { sessionId } = await mark.json() as { sessionId: string };
    for (const frame of await Promise.all([a.next(), b.next()])) {
      assert.equal(frame.type, "api-session/added");
      if (frame.type !== "api-session/added") throw new Error("预期标记帧");
      assert.equal(frame.summary.sessionId, sessionId); assert.equal(frame.revision, 1);
    }
    a.abort.abort();
    const marker = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const second = await marker.json() as { sessionId: string };
    const frame = await b.next(); assert.equal(frame.type, "api-session/added");
    if (frame.type !== "api-session/added") throw new Error("预期第二标记帧");
    assert.equal(frame.summary.sessionId, second.sessionId); assert.equal(frame.revision, 2);
    await app.close();
    await b.closed;
  } finally { a.abort.abort(); b.abort.abort(); }
});



test("真实目录心跳不触发清单扫描或打开日志", { timeout: 10000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-sse-heartbeat-"));
  const app = await createEventSessionApp(join(dir, "events.sqlite"));
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const list = SqliteSessionPersistence.prototype.list; const open = SqliteSessionPersistence.prototype.open;
  let lists = 0; let opens = 0;
  t.mock.method(SqliteSessionPersistence.prototype, "list", async function (this: SqliteSessionPersistence) { lists++; return list.call(this); });
  t.mock.method(SqliteSessionPersistence.prototype, "open", async function (this: SqliteSessionPersistence, ...args: Parameters<typeof open>) { opens++; return open.apply(this, args); });
  t.mock.timers.enable({ apis: ["setInterval"] });
  const stream = await connect(base);
  try {
    assert.deepEqual(await stream.next(), { type: "api-session/ready" });
    t.mock.timers.tick(15000);
    assert.equal(await stream.nextBlock(), ": heartbeat");
    assert.equal(lists, 0); assert.equal(opens, 0);
  } finally { stream.abort.abort(); }
});
