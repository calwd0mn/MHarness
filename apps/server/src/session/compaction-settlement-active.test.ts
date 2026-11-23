import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SqliteSessionPersistence } from "@mharness/session/server";
import { AgentManager } from "../agent/manager.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { createModelTurnDriver } from "../agent/model-turn.ts";
import type { CompactionSettlementResult } from "../agent/settle-compaction-summary.ts";

test("成功批次确认回滚后保留已接受终态并重试原批", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "active-settlement-"));
  const store = new SqliteSessionPersistence(join(dir, "session.sqlite"));
  const initial = await store.create({ sessionId: "s", createdAt: 1 }); await initial.flush(); await initial.close();
  const manager = new AgentManager(store, async () => {});
  const agent = await manager.load("s"); const session = agent.session;
  session.append({ type: "command/run", data: { commandId: "cmd", name: "compact", source: { kind: "user" } } });
  for (const [id, text] of [["old", "旧内容".repeat(2000)], ["tail", "尾部"]] as const) session.append({ type: "user/message", surfaceOp: "append", data: { id, role: "user", source: { kind: "user" }, turn: 1, requestId: id, content: [{ type: "text", text }] } });
  await session.flush();
  const before = session.deriveSurfaceNodes();
  const runtime = new LlmRuntime({ mock: { async *generate() { yield { type: "block-start", index: 0, blockType: "text" }; yield { type: "block-end", index: 0, block: { type: "text", text: "摘要" } }; yield { type: "finish", reason: { kind: "stop" } }; } } });
  const failure = new Error("模拟提交失败");
  const exec = DatabaseSync.prototype.exec; const prepare = DatabaseSync.prototype.prepare;
  let hits = 0;
  const mock = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "COMMIT" && this.isTransaction && hits === 0) {
      const rows = prepare.call(this, "SELECT event_json FROM mh_events WHERE session_id=? AND seq>=? ORDER BY seq").all("s", 4);
      if (rows.length === 3 && rows.some(row => String(row.event_json).includes('"compaction/summary"'))) { hits++; throw failure; }
    }
    return exec.call(this, sql);
  });
  try {
    const result = await agent.runMaintenance(async signal => {
      const settled = await agent.settleCompaction({ session, signal, turn: null, storageOpen: () => agent.storageOpen, blockStorage: error => agent.blockStorage(error), identity: { compactionId: "c", sourceCommandId: "cmd" } }, { runtime, businessModel: runtime.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 });
      assert.equal(agent.state, "maintenance");
      const readStore = new SqliteSessionPersistence(join(dir, "session.sqlite"), { readOnly: true });
      const reader = await readStore.open("s", "read"); assert.ok(reader);
      try { assert.equal((await reader.read()).filter(e => e.type === "compaction/end").length, 0, JSON.stringify(settled)); }
      finally { await reader.close(); await readStore.close(); }
      return settled;
    });
    assert.equal(result.status, "unsettled");
    assert.equal(result.storageFailure?.value, failure);
    assert.equal(result.intent, undefined);
    assert.equal(hits, 1);
    assert.equal(agent.storageOpen, false);
    assert.notDeepEqual(session.deriveSurfaceNodes(), before);
    const accepted = session.snapshot().events.at(-1);
    assert.ok(accepted?.type === "compaction/end" && accepted.data.status === "succeeded");
    await agent.recoverStorage();
    const persisted = await store.open("s", "read");
    assert.ok(persisted);
    try {
      const events = await persisted.read();
      assert.deepEqual(events.filter(e => e.type === "compaction/end"), [accepted]);
      assert.ok(events.some(e => e.type === "command/done" && e.data.kind === "success"));
    } finally { await persisted.close(); }
    assert.equal(hits, 1);
  } finally { mock.mock.restore(); await manager.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const mode of ["publish", "generation"] as const) test(`真实 Turn 的 ${mode} 存储故障锁存原因并留待恢复`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "active-storage-fault-"));
  const store = new SqliteSessionPersistence(join(dir, "session.sqlite"));
  const initial = await store.create({ sessionId: "s", createdAt: 1 });
  await initial.flush();
  await initial.close();
  const external = new Error("外部故障");
  const original = new Error("摘要原错");
  let businessCalls = 0;
  let outcome: CompactionSettlementResult | undefined;
  const summary = new LlmRuntime({ mock: { async *generate() {
    if (mode === "generation") {
      manager.get("s")?.blockStorage(external);
      throw original;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "摘要" } };
    yield { type: "finish", reason: { kind: "stop" } };
  } } });
  const business = new LlmRuntime({ mock: { async *generate() {
    businessCalls++;
    yield { type: "finish", reason: { kind: "stop" } };
  } } });
  const driver = createModelTurnDriver({
    runtime: business,
    config: () => ({ provider: "mock", model: "m" }),
    systemPrompt: () => "",
    preStep: async context => {
      const agent = manager.get("s");
      assert.ok(agent);
      outcome = await agent.settleCompaction(context, {
        runtime: summary, businessModel: summary.prepare({ provider: "mock", model: "m" }),
        businessTools: [], retainTokens: 0,
      });
    },
  });
  const manager = new AgentManager(store, driver);
  try {
    const agent = await manager.load("s");
    agent.session.append({ type: "user/message", surfaceOp: "append", data: { id: "old", role: "user", source: { kind: "user" }, turn: 77, requestId: "old", content: [{ type: "text", text: "旧内容".repeat(2000) }] } });
    await agent.session.flush();
    const off = agent.onObservation(notice => {
      if (mode === "publish" && notice.type === "event" && notice.event.type === "compaction/end") agent.blockStorage(external);
    });
    try {
      agent.prompt({ requestId: "r", content: [{ type: "text", text: "尾部" }] });
      await agent.waitForIdle();
    } finally { off(); }
    assert.equal(businessCalls, 0);
    assert.equal(outcome?.status, "unsettled");
    assert.equal(outcome.storageFailure?.value, external);
    if (mode === "generation") assert.deepEqual(outcome.original, { present: true, value: original });
    assert.equal(agent.storageOpen, false);
    assert.equal(agent.session.snapshot().events.some(e => e.type === "turn/end"), false);
    await agent.recoverStorage();
    const events = agent.session.snapshot().events;
    assert.equal(events.filter(e => e.type === "turn/end").length, 1);
    const end = events.find(e => e.type === "compaction/end");
    assert.equal(end?.data.status, mode === "publish" ? "succeeded" : "failed");
  } finally {
    await manager.close(); await store.close(); await rm(dir, { recursive: true, force: true });
  }
});
