import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session, SqliteSessionPersistence, type SessionHandle } from "@mharness/session/server";
import { commitCompactionBatch } from "../agent/compaction-lifecycle.ts";
import { commitCompactionSummary } from "../agent/commit-compaction-summary.ts";
import { AgentManager } from "../agent/manager.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { injectCompactionSqliteFault } from "./compaction-settlement-sqlite-fixture.ts";

async function cleanAll(cleanup: Array<() => Promise<unknown>>) {
  const errors: unknown[] = [];
  for (const close of cleanup.reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "测试资源清理失败");
}

test("start 已接受且待核对，确认回滚后统一排空重试原记录", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "compaction-drain-"));
  const cleanup: Array<() => Promise<unknown>> = [() => rm(dir, { recursive: true, force: true })];
  t.after(() => cleanAll(cleanup));
  const path = join(dir, "session.sqlite");
  const store = new SqliteSessionPersistence(path);
  cleanup.push(() => store.close());
  const session = new Session({ sessionId: "s", createdAt: 1 });
  const handle = await store.create(session.header);
  cleanup.push(() => handle.close());
  await handle.flush();
  let open = true;
  store.bindWriter(handle, session, () => { open = false; });
  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  cleanup.push(() => observer.close());
  const reader = await observer.open("s", "read");
  assert.ok(reader);
  cleanup.push(() => reader.close());
  for (const [id, text] of [["old", "旧内容".repeat(2000)], ["tail", "尾部"]] as const) {
    session.append({ type: "user/message", surfaceOp: "append", data: { id, role: "user", source: { kind: "user" }, turn: 1, requestId: id, content: [{ type: "text", text }] } });
  }
  await session.flush();
  const before = await reader.read();
  let calls = 0;
  const runtime = new LlmRuntime({ mock: { async *generate() { calls++; yield { type: "finish", reason: { kind: "stop" } }; } } });
  const fault = injectCompactionSqliteFault(t, { path, sessionId: "s", compactionId: "c", kind: "start", firstSeq: 2, mode: "rolled-back" });
  try {
    const result = await commitCompactionSummary({ session, storageOpen: () => open, blockStorage: () => { open = false; }, signal: new AbortController().signal, turn: null, identity: { compactionId: "c", sourceCommandId: "cmd" } }, { runtime, businessModel: runtime.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 });
    assert.equal(result.status, "commit-checkpoint-failed");
    assert.equal(result.side, "start");
    assert.equal(session.seq, 3);
    assert.deepEqual(await reader.read(), before);
    assert.equal(calls, 0);
    await assert.rejects(store.flush());
    assert.equal(fault.reconciliationReads, 0);
    fault.release();
    await store.flush();
    assert.equal(open, false);
    assert.equal(fault.targetCommits, 2);
    assert.deepEqual(await reader.read(), session.snapshot().events);
  } finally {
    fault.restore();
  }
});

for (const scenario of ["session", "handle", "handle-committed", "handle-rolled-back", "manager", "manager-unknown"] as const) test(`真实摘要缓冲与暂存隔离经 ${scenario} 排空或关闭`, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "compaction-drain-agent-"));
  const cleanup: Array<() => Promise<unknown>> = [() => rm(dir, { recursive: true, force: true })];
  t.after(() => cleanAll(cleanup));
  const path = join(dir, "session.sqlite");
  const store = new SqliteSessionPersistence(path);
  cleanup.push(() => store.close().catch(() => {}));
  const initial = await store.create({ sessionId: "s", createdAt: 1 });
  cleanup.push(() => initial.close().catch(() => {}));
  await initial.flush();
  await initial.close();
  let bound: SessionHandle | undefined;
  const manager = new AgentManager({
    open: (...args) => store.open(...args),
    create: (...args) => store.create(...args),
    bindWriter(handle, session, reportError) { bound = handle; store.bindWriter(handle, session, reportError); },
  }, async () => {});
  cleanup.push(() => manager.close().catch(() => {}));
  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  cleanup.push(() => observer.close());
  const reader = await observer.open("s", "read");
  assert.ok(reader);
  cleanup.push(() => reader.close());
  const agent = await manager.load("s");
  const session = agent.session;
  for (const [id, text] of [["old", "旧内容".repeat(2000)], ["tail", "尾部"]] as const) {
    session.append({ type: "user/message", surfaceOp: "append", data: { id, role: "user", source: { kind: "user" }, turn: 1, requestId: id, content: [{ type: "text", text }] } });
  }
  await session.flush();
  const published: string[] = [];
  session.on("session/event", (event) => published.push(event.type));
  let calls = 0;
  const runtime = new LlmRuntime({ mock: { async *generate() {
    calls++;
    if (scenario === "handle") throw new Error("摘要失败");
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "摘要" } };
    yield { type: "finish", reason: { kind: "stop" } };
  } } });
  const options = { runtime, businessModel: runtime.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 };
  const context = { session, storageOpen: () => agent.storageOpen, blockStorage: (error: unknown) => agent.blockStorage(error) };
  const fault = injectCompactionSqliteFault(t, { path, sessionId: "s", compactionId: "c", kind: scenario === "handle" ? "end" : "success", firstSeq: 3, mode: scenario === "handle" || scenario === "handle-rolled-back" ? "rolled-back" : "committed" });
  try {
    const result = await agent.runMaintenance((signal) => commitCompactionSummary({ ...context, signal, turn: null, identity: { compactionId: "c", sourceCommandId: "cmd" } }, options));
    if (scenario === "handle") {
      assert.equal(result.status, "model-not-completed");
      const end = await commitCompactionBatch(context, () => [{ type: "compaction/end", data: { compactionId: "c", sourceCommandId: "cmd", turn: null, status: "failed", reason: { code: "failed" } } }]);
      assert.equal(end.status, "pending-reconciliation");
    } else {
      assert.equal(result.status, "commit-checkpoint-failed");
      assert.equal(result.side, "success");
    }
    assert.equal(calls, 1);
    assert.equal(session.seq, scenario === "handle" ? 3 : 6);
    assert.deepEqual(published, scenario === "handle" ? ["compaction/start"] : ["compaction/start", "compaction/summary", "user/message", "compaction/end"]);
    assert.equal(agent.storageOpen, false);
    assert.equal((await reader.read()).length, scenario === "handle" || scenario === "handle-rolled-back" ? 3 : 6);
    if (scenario !== "manager-unknown") fault.release();
    if (scenario === "session") {
      await session.flush();
      await session.flush();
      assert.equal(session.seq, 6);
      assert.equal(session.replaceGeneration, 1);
      assert.deepEqual(published, ["compaction/start", "compaction/summary", "user/message", "compaction/end"]);
    } else if (scenario === "handle") {
      assert.ok(bound);
      await bound.flush();
      assert.equal(session.seq, 3);
      assert.deepEqual(published, ["compaction/start"]);
    } else if (scenario === "handle-committed" || scenario === "handle-rolled-back") {
      assert.ok(bound);
      session.append({ type: "user/message", surfaceOp: "append", data: { id: "next", role: "user", source: { kind: "user" }, turn: 1, requestId: "next", content: [{ type: "text", text: "后续事件" }] } });
      await bound.flush();
      assert.deepEqual(await reader.read(), session.snapshot().events.slice(0, 6));
      await session.flush();
      assert.deepEqual(await reader.read(), session.snapshot().events);
      assert.equal(session.replaceGeneration, 1);
      assert.deepEqual(published, ["compaction/start", "compaction/summary", "user/message", "compaction/end", "user/message"]);
    } else if (scenario === "manager") {
      await manager.close();
      assert.equal(session.seq, 6);
      assert.equal(manager.get("s"), undefined);
      const write = await store.open("s", "write");
      assert.ok(write);
      assert.equal((await write.read()).filter((event) => event.type === "compaction/end").length, 1);
      await write.close();
    } else {
      await assert.rejects(manager.close(), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        const contains = (value: unknown): boolean => value === fault.failure || (value instanceof AggregateError && value.errors.some(contains)) || (value instanceof Error && contains(value.cause));
        assert.ok(contains(error));
        return true;
      });
      fault.release();
      fault.restore();
      const reopened = new SqliteSessionPersistence(path);
      try {
        const write = await reopened.open("s", "write");
        assert.ok(write);
        assert.equal((await write.read()).filter((event) => event.type === "compaction/end").length, 1);
        await write.close();
      } finally { await reopened.close(); }
    }
    assert.equal(fault.targetCommits, scenario === "handle-rolled-back" ? 2 : 1);
    assert.equal(agent.storageOpen, false);
    assert.equal((await reader.read()).filter((event) => event.type === "command/done").length, 0);
  } finally {
    fault.restore();
  }
});
