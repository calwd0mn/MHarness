import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SqliteSessionPersistence } from "@mharness/session/server";
import { AgentManager } from "../agent/manager.ts";
import { SessionCommandController } from "../commands.ts";
import { createModelTurnDriver } from "../agent/model-turn.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { createMockAdapter } from "../model/providers/mock.ts";

test("待核对通过实际写入告警关闭 Agent 准入，恢复检查点后开放", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-agent-staged-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  const initial = await store.create({ sessionId: "s", createdAt: 1 }); await initial.flush(); await initial.close();
  let calls = 0; let release = () => {}; let ready = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const staged = new Promise<void>((resolve) => { ready = resolve; });
  const driver = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { calls++; return [{ chunk: { type: "text", delta: "ok" } }, { chunk: { type: "finish", reason: { kind: "stop" } } }]; }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "" });
  const manager = new AgentManager(store, async (context) => {
    await context.session.flush(); fail = true;
    const result = await context.session.commitStaged(() => [{ type: "turn/start", data: { turn: 99 } }]);
    assert.equal(result.status, "pending-reconciliation"); ready(); await gate;
    await driver(context);
  });
  const commands = new SessionCommandController(manager);
  let fail = false; let write: DatabaseSync | undefined; const original = DatabaseSync.prototype.exec;
  const fault = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE") write = this;
    if (this === write && fail && (sql === "COMMIT" || sql === "ROLLBACK")) throw new Error("injected staged failure");
    original.call(this, sql);
  });
  try {
    const request = { sessionId: "s", requestId: "r", content: [{ type: "text" as const, text: "x" }] };
    await commands.prompt(request); await staged;
    const agent = manager.get("s"); assert.ok(agent); assert.equal(agent.storageOpen, false); assert.equal(calls, 0);
    await assert.rejects(agent.session.flush()); release(); await agent.waitForIdle();
    assert.equal(calls, 0); assert.equal(agent.storageOpen, false);
    assert.deepEqual(await commands.prompt(request), { accepted: true });
    await assert.rejects(commands.prompt({ ...request, requestId: "new" }), { code: "storage_blocked" });
    fail = false; await agent.session.flush(); assert.equal(agent.storageOpen, false);
    await agent.recoverStorage(); assert.equal(agent.storageOpen, true);
  } finally { fail = false; release(); fault.mock.restore(); await manager.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});


test("健康 Agent 通过同一模型驱动调用 Adapter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mh-agent-staged-healthy-"));
  const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
  const handle = await store.create({ sessionId: "s", createdAt: 1 }); await handle.flush(); await handle.close();
  let calls = 0;
  const driver = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { calls++; return [{ chunk: { type: "text", delta: "ok" } }, { chunk: { type: "finish", reason: { kind: "stop" } } }]; }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "" });
  const manager = new AgentManager(store, driver);
  try {
    await new SessionCommandController(manager).prompt({ sessionId: "s", requestId: "r", content: [{ type: "text", text: "x" }] });
    const agent = manager.get("s"); assert.ok(agent); await agent.waitForIdle(); assert.equal(calls, 1);
  } finally { await manager.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("元数据偏离时恢复不能开放准入，修复元数据并核验后才能开放", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-staged-header-")); const path = join(dir, "db.sqlite");
  const store = new SqliteSessionPersistence(path); const handle = await store.create({ sessionId: "s", createdAt: 1 });
  await handle.flush(); await handle.close();
  const manager = new AgentManager(store, async () => {}); const injection = new DatabaseSync(path);
  try {
    const agent = await manager.load("s");
    const execute = DatabaseSync.prototype.exec;
    let changeHeader = true;
    const intercept = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE" && changeHeader) {
        changeHeader = false;
        injection.prepare("UPDATE mh_sessions SET header_json=? WHERE session_id=?").run(JSON.stringify({ sessionId: "s", createdAt: 2 }), "s");
      }
      execute.call(this, sql);
    });
    await assert.rejects(agent.session.commitStaged(() => [{ type: "turn/start", data: { turn: 1 } }]), /前缀/);
    intercept.mock.restore();
    assert.equal(agent.storageOpen, false);
    await assert.rejects(agent.recoverStorage()); assert.equal(agent.storageOpen, false);
    injection.prepare("UPDATE mh_sessions SET header_json=? WHERE session_id=?").run(JSON.stringify({ sessionId: "s", createdAt: 1 }), "s");
    await agent.recoverStorage(); assert.equal(agent.storageOpen, true);
  } finally { injection.close(); await manager.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});
