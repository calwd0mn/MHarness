import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Session, SqliteSessionPersistence, readPersistedSessionHistory, type SessionAppendInput } from "@mharness/session/server";
import { followFrameSchema, rawSessionEventFrameSchema, rawSessionHistorySchema } from "@mharness/session/contracts";
import { commitCompactionBatch, runCompactionAttempt, type CompactionAttemptContext, type CompactionAttemptIdentity } from "./compaction-lifecycle.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { LlmError } from "../model/adapter.ts";
import { AgentManager } from "./manager.ts";
import { createModelTurnDriver, type StepHookContext } from "./model-turn.ts";
import { followSession } from "../session/follow.ts";
import { AgentError, type RunTurn } from "./react-agent.ts";

const summaryInput = { systemPrompt: "摘要", messages: [], tools: [] } as const;
function summaryModel(onCall: () => void = () => {}) {
  return new LlmRuntime({ mock: { async *generate() { onCall(); yield { type: "finish", reason: { kind: "stop" } }; } } }).prepare({ provider: "mock", model: "m" });
}

function prompt(requestId: string) {
  return { requestId, content: [{ type: "text" as const, text: requestId }] };
}

function deferred<TResult>() {
  let resolve!: (value: TResult) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<TResult>((accept, rejectPromise) => {
    resolve = accept;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function persistedAgent(testContext: TestContext, runTurn: RunTurn) {
  const dir = await mkdtemp(join(tmpdir(), "compact-agent-"));
  const path = join(dir, "db.sqlite");
  const store = new SqliteSessionPersistence(path);
  const manager = new AgentManager(store, runTurn);
  testContext.after(async () => {
    try { await manager.close(); } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
  });
  const header = { sessionId: "s", createdAt: 1 };
  const seed = new Session(header);
  seed.append({ type: "turn/start", data: { turn: 1 } });
  seed.append({ type: "user/message", surfaceOp: "append", data: {
    ...prompt("old"), id: "old", turn: 1, role: "user", source: { kind: "user" },
  } });
  seed.append({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  const handle = await store.create(header);
  try { await handle.append(seed.snapshot().events); } finally { await handle.close(); }
  const agent = await manager.load("s");
  const read = () => readPersistedSessionHistory(store, "s");
  return { path, manager, agent, read };
}

function followFrame(frame: IteratorResult<string>) {
  assert.ok(!frame.done);
  return followFrameSchema.parse(JSON.parse(frame.value.slice("data: ".length)));
}

for (const scope of ["独立维护", "Turn 内"] as const) {
  for (const outcome of ["成功", "取消"] as const) {
    test(`${scope}摘要在 start 后生成，${outcome}终态确认后才退出原占用`, { timeout: 8000 }, async (testContext) => {
      const inTurn = scope === "Turn 内";
      const cancel = outcome === "取消";
      const entered = deferred<AbortSignal>();
      const abort = deferred<void>();
      const modelGate = deferred<void>();
      const cleaning = deferred<void>();
      const cleanupGate = deferred<void>();
      const settlementEntered = deferred<void>();
      const settlementGate = deferred<void>();
      let summaryCalls = 0;
      let businessCalls = 0;
      let hookSignal: AbortSignal | undefined;
      let committedAtBusiness: string[] | undefined;
      const runtime = new LlmRuntime({
        summary: {
          async *generate(_request, signal) {
            summaryCalls++;
            const onAbort = () => abort.resolve();
            signal.addEventListener("abort", onAbort);
            entered.resolve(signal);
            try {
              await modelGate.promise;
              signal.throwIfAborted();
              yield { type: "finish", reason: { kind: "stop" } };
            } finally {
              signal.removeEventListener("abort", onAbort);
              cleaning.resolve();
              await cleanupGate.promise;
            }
          },
        },
        business: {
          async *generate() {
            businessCalls++;
            committedAtBusiness = (await read())?.records.map(({ event }) => event.type);
            yield { type: "block-start", index: 0, blockType: "text" };
            yield { type: "text-delta", index: 0, text: "业务回复" };
            yield { type: "block-end", index: 0, block: { type: "text", text: "业务回复" } };
            yield { type: "finish", reason: { kind: "stop" } };
          },
        },
      });
      const summary = runtime.prepare({ provider: "summary", model: "m" });
      const summarize = async (context: CompactionAttemptContext) => {
        hookSignal = context.signal;
        const result = await runCompactionAttempt(context,
          () => ({ kind: "ready", input: summaryInput, model: summary }));
        settlementEntered.resolve();
        await settlementGate.promise;
        if (cancel) {
          assert.equal(result.status, "generation-failed");
          assert.equal(result.error, context.signal.reason);
        } else {
          assert.equal(result.status, "generated");
          assert.deepEqual(result.value.finishReason, { kind: "stop" });
        }
        const committed = await commitCompactionBatch(context, (firstSeq) => cancel
          ? [{ type: "compaction/end", data: { ...result.attempt, status: "cancelled", reason: "user" } }]
          : batch(firstSeq, result.attempt, { start: 1, end: 1 }));
        assert.equal(committed.status, "committed");
      };
      const { path, manager, agent, read } = await persistedAgent(testContext, createModelTurnDriver({
        runtime, config: () => ({ provider: "business", model: "m" }), systemPrompt: () => "业务",
        preStep: summarize,
      }));
      const reader = new DatabaseSync(path, { readOnly: true });
      const readCount = () => reader.prepare("SELECT COUNT(*) AS count FROM mh_events WHERE session_id = 's'").get()?.count;
      const observed: string[] = [];
      const off = agent.onObservation((notice) => observed.push(notice.type === "event" ? notice.event.type : notice.type));
      const follow = followSession(manager, read, "s", new AbortController().signal);
      const request = prompt("new");
      const expectedStart = inTurn ? 5 : 3;
      let startCommitChecked = false;
      const exec = DatabaseSync.prototype.exec;
      const monitor = testContext.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
        if (sql === "COMMIT" && this.isTransaction && agent.session.stagedOccupied && readCount() === expectedStart) {
          startCommitChecked = true;
          assert.equal(agent.session.seq, expectedStart);
          assert.ok(!observed.includes("compaction/start"));
          assert.equal(summaryCalls, 0);
        }
        exec.call(this, sql);
      });
      let operation: Promise<void> | undefined;
      try {
        assert.equal(followFrame(await follow.next()).type, "snapshot");
        if (inTurn) {
          agent.prompt(request);
          operation = agent.waitForIdle();
        } else {
          operation = agent.runMaintenance((signal) => summarize({
            session: agent.session, turn: null, signal, storageOpen: () => agent.storageOpen,
            blockStorage: (error) => agent.blockStorage(error),
          }));
        }
        const signal = await Promise.race([
          entered.promise,
          operation.then(() => assert.fail("原占用在摘要启动前退出")),
        ]);
        monitor.mock.restore();
        assert.equal(startCommitChecked, true);
        assert.equal(signal, hookSignal);
        assert.equal(agent.session.stagedOccupied, false);
        assert.equal(agent.state, inTurn ? "running" : "maintenance");
        const before = (await read())?.records.map(({ event }) => event);
        const start = before?.at(-1);
        assert.equal(start?.type, "compaction/start");
        assert.equal(start.seq, expectedStart);
        assert.equal(start.data.turn, inTurn ? 2 : null);
        if (inTurn) assert.deepEqual(before?.slice(3).map(({ type }) => type), ["turn/start", "user/message", "compaction/start"]);
        for (let seq = 3; seq <= expectedStart; seq++) {
          const frame = followFrame(await follow.next());
          assert.deepEqual(frame, { type: "event", event: before?.[seq] });
        }
        const reconnect = followSession(manager, read, "s", new AbortController().signal);
        try {
          const frame = followFrame(await reconnect.next());
          assert.equal(frame.type, "snapshot");
          assert.deepEqual(frame.records.map(({ event }) => event), before);
          assert.deepEqual(frame.assistantStream, { revision: 0 });
        } finally { await reconnect.return(undefined); }
        await follow.return(undefined);
        assert.equal(signal.aborted, false);
        assert.deepEqual(agent.prompt(inTurn ? request : prompt("old")), { accepted: true });
        assert.throws(() => agent.prompt(prompt("busy")), { code: "agent_busy" });
        await assert.rejects(agent.runMaintenance(async () => {}), { code: "agent_busy" });
        if (cancel) { agent.cancel(); await abort.promise; }
        modelGate.resolve();
        await cleaning.promise;
        assert.equal(agent.state, inTurn ? "running" : "maintenance");
        cleanupGate.resolve();
        await settlementEntered.promise;
        assert.equal(agent.state, inTurn ? "running" : "maintenance");
        assert.equal((await read())?.records.at(-1)?.event.type, "compaction/start");
        assert.equal(businessCalls, 0);
        settlementGate.resolve();
        await operation;
        await agent.session.flush();
        assert.equal(agent.state, "idle");
        assert.equal(summaryCalls, 1);
        const events = (await read())?.records.map(({ event }) => event);
        assert.ok(events);
        const end = events.find((event) => event.type === "compaction/end");
        assert.deepEqual(end?.data, cancel ? { ...start.data, status: "cancelled", reason: "user" } : { ...start.data, status: "succeeded" });
        assert.deepEqual(events.slice(expectedStart + 1).map(({ type }) => type), [
          ...(cancel ? [] : ["compaction/summary", "user/message"]), "compaction/end",
          ...(inTurn ? cancel ? ["turn/end"] : ["step/start", "request/header", "assistant/message", "step/end", "turn/end"] : []),
        ]);
        assert.equal(businessCalls, inTurn && !cancel ? 1 : 0);
        if (inTurn && !cancel) assert.ok(committedAtBusiness?.includes("compaction/end"));
        if (inTurn && cancel) assert.deepEqual(events.at(-1)?.data, { turn: 2, reason: { kind: "aborted", reason: "user" } });
      } finally {
        monitor.mock.restore();
        modelGate.resolve();
        cleanupGate.resolve();
        settlementGate.resolve();
        await operation?.catch(() => {});
        await follow.return(undefined);
        off();
        reader.close();
      }
    });
  }
}

test("同步捕获后抢占 start，确认后 Adapter 仅使用已捕获值", async () => {
  const session = new Session({ sessionId: "s", createdAt: 1 });
  const commit = deferred<void>();
  session.bindCheckpoint(async () => {}, async (_events, finish) => {
    await commit.promise;
    const result = { status: "committed" } as const;
    finish(result);
    return result;
  });
  let system = "captured";
  let captures = 0;
  let atCaptureMicrotask: { occupied: boolean; seq: number } | undefined;
  const sent: string[] = [];
  const prepared = new LlmRuntime({ mock: {
    async *generate(request) {
      sent.push(request.systemPrompt);
      yield { type: "finish", reason: { kind: "stop" } };
    },
  } }).prepare({ provider: "mock", model: "m" });
  const operation = runCompactionAttempt(
    { session, turn: null, signal: new AbortController().signal, storageOpen: () => true, blockStorage: () => assert.fail() },
    () => {
      captures++;
      queueMicrotask(() => {
        atCaptureMicrotask = { occupied: session.stagedOccupied, seq: session.seq };
        system = "changed";
      });
      return { kind: "ready", input: Object.freeze({ systemPrompt: system, messages: [], tools: [] }), model: prepared };
    },
  );
  try {
    await Promise.resolve();
    assert.equal(system, "changed");
    assert.deepEqual(atCaptureMicrotask, { occupied: true, seq: 0 });
    assert.deepEqual(sent, []);
  } finally { commit.resolve(); }
  const result = await operation;
  assert.equal(result.status, "generated");
  assert.deepEqual(result.value.finishReason, { kind: "stop" });
  assert.equal(captures, 1);
  assert.deepEqual(sent, ["captured"]);
  const events = session.snapshot().events;
  assert.deepEqual(events.map((event) => event.type), ["compaction/start"]);
  assert.deepEqual(events[0]?.data, result.attempt);
});

test("无范围、捕获异常和预先取消都不暂存 start", async () => {
  const session = new Session({ sessionId: "s", createdAt: 1 });
  const controller = new AbortController();
  let captures = 0;
  let stages = 0;
  const failure = new Error("capture failed");
  const context = { session, turn: null, signal: controller.signal, storageOpen: () => true, blockStorage: () => assert.fail() };
  const capture = () => {
    captures++;
    return { kind: "no-range" } as const;
  };
  session.bindCheckpoint(async () => {}, async () => { stages++; throw new Error("unexpected staged write"); });
  assert.deepEqual(await runCompactionAttempt(context, capture), { status: "no-range" });
  await assert.rejects(runCompactionAttempt(context, () => { throw failure; }), (error) => error === failure);
  controller.abort(failure);
  await assert.rejects(runCompactionAttempt(context, capture), (error) => error === failure);
  assert.deepEqual({ captures, stages, events: session.seq }, { captures: 1, stages: 0, events: 0 });
});

test("等待 start 确认期间关闭准入，确认后不消费模型流", async () => {
  const session = new Session({ sessionId: "blocked-before-model", createdAt: 1 });
  const commit = deferred<void>();
  const entered = deferred<void>();
  let open = true;
  let adapterCalls = 0;
  const prepared = summaryModel(() => { adapterCalls++; });
  session.bindCheckpoint(async () => {}, async (_events, finish) => {
    entered.resolve();
    await commit.promise;
    const result = { status: "committed" } as const;
    finish(result);
    return result;
  });
  const operation = runCompactionAttempt(
    { session, turn: null, signal: new AbortController().signal, storageOpen: () => open, blockStorage: () => { open = false; } },
    () => ({ kind: "ready", input: summaryInput, model: prepared }),
  );
  await entered.promise;
  assert.equal(adapterCalls, 0);
  open = false;
  commit.resolve();
  const result = await operation;
  assert.equal(result.status, "generation-failed");
  assert.ok(result.error instanceof Error && "code" in result.error && result.error.code === "storage_blocked");
  assert.equal(adapterCalls, 0);
  assert.deepEqual(session.snapshot().events.map((event) => event.type), ["compaction/start"]);
  assert.deepEqual(session.snapshot().events[0]?.data, result.attempt);
});

test("摘要入口组装模型输出及用量", async () => {
  const session = new Session({ sessionId: "summary-output", createdAt: 1 });
  session.bindCheckpoint(async () => {}, async (_events, finish) => {
    const result = { status: "committed" } as const;
    finish(result);
    return result;
  });
  let calls = 0;
  const prepared = new LlmRuntime({ mock: { async *generate() {
    calls++;
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "摘要" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "摘要" } };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
    yield { type: "finish", reason: { kind: "stop" } };
  } } }).prepare({ provider: "mock", model: "m" });
  const result = await runCompactionAttempt(
    { session, turn: null, signal: new AbortController().signal, storageOpen: () => true, blockStorage: () => assert.fail() },
    () => ({ kind: "ready", input: summaryInput, model: prepared }),
  );
  assert.equal(result.status, "generated");
  assert.equal(calls, 1);
  assert.deepEqual(result.value, { blocks: [{ type: "text", text: "摘要" }], finishReason: { kind: "stop" }, usage: { inputTokens: 10, outputTokens: 2 } });
});

test("等待确认期间取消，保留提交的 start 且不启动生成", async () => {
  const session = new Session({ sessionId: "s", createdAt: 1 });
  const controller = new AbortController();
  const commit = deferred<void>();
  let calls = 0;
  session.bindCheckpoint(async () => {}, async (_events, finish) => {
    await commit.promise;
    const result = { status: "committed" } as const;
    finish(result);
    return result;
  });
  const operation = runCompactionAttempt(
    { session, turn: null, signal: controller.signal, storageOpen: () => true, blockStorage: () => assert.fail() },
    () => ({ kind: "ready", input: summaryInput, model: summaryModel(() => { calls++; }) }),
  );
  try {
    assert.equal(session.stagedOccupied, true);
    controller.abort();
  } finally { commit.resolve(); }
  const result = await operation;
  assert.equal(result.status, "generation-failed");
  assert.equal(result.error, controller.signal.reason);
  assert.equal(calls, 0);
  const events = session.snapshot().events;
  assert.deepEqual(events.map(({ type }) => type), ["compaction/start"]);
  assert.deepEqual(events[0]?.data, result.attempt);
});

test("SQLite 确认 start 后关闭存储门，Adapter 不启动", async (testContext) => {
  const { agent, read } = await persistedAgent(testContext, async () => {});
  const original = new Error("gate closed on publish");
  const starts: unknown[] = [];
  const off = agent.onObservation((notice) => {
    if (notice.type === "event" && notice.event.type === "compaction/start") {
      starts.push(notice.event);
      agent.blockStorage(original);
    }
  });
  testContext.after(off);
  let adapterCalls = 0;
  const prepared = new LlmRuntime({ mock: {
    async *generate() { adapterCalls++; yield { type: "finish", reason: { kind: "stop" } }; },
  } }).prepare({ provider: "mock", model: "m" });
  const result = await agent.runMaintenance(async (signal) => {
    const result = await runCompactionAttempt(
      { session: agent.session, turn: null, signal, storageOpen: () => agent.storageOpen, blockStorage: (error) => agent.blockStorage(error) },
      () => ({ kind: "ready", input: { systemPrompt: "", messages: [], tools: [] }, model: prepared }),
    );
    assert.equal(signal.aborted, false);
    return result;
  });
  assert.equal(result.status, "generation-failed");
  assert.ok(result.error instanceof Error && "code" in result.error && result.error.code === "storage_blocked");
  const persisted = (await read())?.records.slice(3).map(({ event }) => event);
  assert.equal(persisted?.length, 1);
  assert.deepEqual(starts, persisted);
  assert.deepEqual(persisted[0]?.data, result.attempt);
  assert.equal(agent.storageOpen, false);
  assert.equal(adapterCalls, 0);
});

for (const mode of ["回滚", "待核对"] as const) {
  test(`SQLite start ${mode}时维护退出且不生成摘要`, async (testContext) => {
    const { path, agent, read } = await persistedAgent(testContext, async () => {});
    const prefix = await read();
    const observe: string[] = [];
    const off = agent.onObservation((notice) => { if (notice.type === "event") observe.push(notice.event.type); });
    testContext.after(off);
    const failure = new Error("start commit loss");
    const db = new DatabaseSync(path);
    const exec = DatabaseSync.prototype.exec;
    let writer: DatabaseSync | undefined;
    let enabled = mode === "待核对";
    const fault = testContext.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE") writer = this;
      if (enabled && writer === this && (sql === "COMMIT" || sql === "ROLLBACK")) throw failure;
      exec.call(this, sql);
    });
    if (mode === "回滚") db.exec("CREATE TRIGGER fail_start BEFORE INSERT ON mh_events WHEN NEW.seq = 3 BEGIN SELECT RAISE(ABORT, 'start failure'); END");
    let calls = 0;
    try {
      const result = await agent.runMaintenance((signal) => runCompactionAttempt(
        { session: agent.session, turn: null, signal, storageOpen: () => agent.storageOpen, blockStorage: (error) => agent.blockStorage(error) },
        () => ({ kind: "ready", input: summaryInput, model: summaryModel(() => { calls++; }) }),
      ));
      assert.equal(result.status, "start-not-confirmed");
      assert.equal(result.commit.status, mode === "回滚" ? "rolled-back" : "pending-reconciliation");
      assert.equal(agent.state, "idle");
      assert.equal(calls, 0);
      if (mode === "回滚") {
        assert.equal(agent.storageOpen, true);
        db.exec("DROP TRIGGER fail_start");
        await agent.session.flush();
      } else {
        assert.equal(result.commit.error, failure);
        assert.equal(agent.session.stagedOccupied, true);
        assert.equal(agent.storageOpen, false);
        assert.throws(() => agent.prompt(prompt("new")), { code: "storage_blocked", cause: failure });
        await assert.rejects(agent.runMaintenance(async () => {}), { code: "storage_blocked", cause: failure });
        assert.deepEqual(agent.prompt(prompt("old")), { accepted: true });
      }
      assert.deepEqual(await read(), prefix);
      assert.deepEqual(observe, []);
      assert.deepEqual(agent.snapshot().records, prefix?.records);
    } finally {
      enabled = false;
      fault.mock.restore();
      db.close();
    }
  });
}

test("维护压缩各自分配身份并在原占用封口", async (testContext) => {
  const { agent, read } = await persistedAgent(testContext, async () => {});
  const identities = [];
  for (const range of [{ start: 1, end: 1 }, { start: 5, end: 5 }]) {
    const identity = await agent.runMaintenance(async (signal) => {
      const context = { session: agent.session, turn: null, signal, storageOpen: () => agent.storageOpen, blockStorage: (error: unknown) => agent.blockStorage(error) };
      const result = await runCompactionAttempt(context, () => ({ kind: "ready", input: summaryInput, model: summaryModel() }));
      assert.equal(result.status, "generated");
      assert.equal(agent.state, "maintenance");
      assert.equal((await commitCompactionBatch(context, (seq) => batch(seq, result.attempt, range))).status, "committed");
      return result.attempt;
    });
    assert.ok(identity.compactionId);
    identities.push(identity);
  }
  assert.notEqual(identities[0]?.compactionId, identities[1]?.compactionId);
  const ends = (await read())?.records.flatMap(({ event }) => event.type === "compaction/end" ? [event.data] : []);
  assert.deepEqual(ends, identities.map((identity) => ({ ...identity, status: "succeeded" })));
});

test("摘要生成拒绝保留原始错误和已确认身份", async (testContext) => {
  const { agent, read } = await persistedAgent(testContext, async () => {});
  const failure = new Error("summary failed");
  const result = await agent.runMaintenance((signal) => runCompactionAttempt(
    { session: agent.session, turn: null, signal, storageOpen: () => agent.storageOpen, blockStorage: (error) => agent.blockStorage(error) },
    () => ({ kind: "ready", input: summaryInput, model: { ...summaryModel(), async *generate() { throw failure; } } }),
  ));
  assert.equal(result.status, "generation-failed");
  assert.equal(result.error, failure);
  const records = (await read())?.records.slice(3);
  assert.equal(records?.length, 1);
  assert.equal(records[0]?.event.type, "compaction/start");
  assert.deepEqual(records[0]?.event.data, result.attempt);
});

for (const mode of ["仍占位", "普通 flush 已确认"] as const) {
  test(`Turn 待核对且${mode}时保留原错误与未闭合范围`, { timeout: 8000 }, async (testContext) => {
    const dir = await mkdtemp(join(tmpdir(), "compact-turn-fault-"));
    const store = new SqliteSessionPersistence(join(dir, "db.sqlite"));
    const header = { sessionId: "s", createdAt: 1 };
    const handle = await store.create(header);
    await handle.flush(); await handle.close();
    const pending = deferred<unknown>();
    const release = deferred<void>();
    const rejected = deferred<unknown>();
    const fault = new Error("start commit response lost");
    const secondFault = new Error("later hook failure");
    const openStep = mode === "仍占位";
    let faultEnabled = false;
    let loseRead = false;
    let businessCalls = 0;
    let summaryCalls = 0;
    const exec = DatabaseSync.prototype.exec;
    const prepare = DatabaseSync.prototype.prepare;
    let writer: DatabaseSync | undefined;
    testContext.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE") writer = this;
      if (faultEnabled && this === writer && sql === "COMMIT") {
        if (!openStep) { exec.call(this, sql); loseRead = true; faultEnabled = false; }
        throw fault;
      }
      if (faultEnabled && this === writer && sql === "ROLLBACK") throw new Error("rollback blocked");
      exec.call(this, sql);
    });
    testContext.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (loseRead && sql.startsWith("SELECT header_json, inherited_count, event_count")) {
        loseRead = false;
        throw new Error("first reconciliation read lost");
      }
      return prepare.call(this, sql);
    });
    const hook = async (context: StepHookContext) => {
      await context.session.flush();
      faultEnabled = true;
      const result = await runCompactionAttempt(context, () => ({ kind: "ready", input: summaryInput, model: summaryModel(() => { summaryCalls++; }) }));
      assert.equal(result.status, "start-not-confirmed");
      assert.equal(result.commit.status, "pending-reconciliation");
      pending.resolve(result.commit.error);
      await release.promise;
      context.blockStorage(secondFault);
    };
    const driver = createModelTurnDriver({
      runtime: new LlmRuntime({ mock: {
        async *generate() { businessCalls++; throw new LlmError("CONTEXT_WINDOW_EXCEEDED"); },
      } }),
      config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "",
      ...(openStep ? { recoverOverflow: async (context) => { await hook(context); return true; } } : { preStep: hook }),
    });
    const manager = new AgentManager(store, async (context) => {
      try { await driver(context); rejected.resolve(undefined); }
      catch (error) { rejected.resolve(error); pending.reject(error); throw error; }
      finally { pending.resolve(undefined); }
    });
    testContext.after(async () => {
      faultEnabled = false;
      release.resolve();
      try { await manager.close(); } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
    });
    const agent = await manager.load("s");
    const observed: string[] = [];
    const off = agent.onObservation((notice) => { if (notice.type === "event") observed.push(notice.event.type); });
    testContext.after(off);
    const append = testContext.mock.method(agent.session, "append");
    const request = { requestId: "r", content: [{ type: "text" as const, text: "用户输入" }] };
    const read = () => readPersistedSessionHistory(store, "s");
    agent.prompt(request);
    assert.equal(await pending.promise, fault);
    assert.equal(agent.session.stagedOccupied, true);
    assert.equal(agent.storageOpen, false);
    const before = agent.session.snapshot().events.map((event) => event.type);
    const persisted = (await read())?.records.map(({ event }) => event.type);
    assert.deepEqual(persisted, openStep ? before : [...before, "compaction/start"]);
    assert.deepEqual(observed, before);
    const follow = followSession(manager, read, "s", new AbortController().signal);
    testContext.after(async () => { await follow.return(undefined); });
    const first = followFrame(await follow.next());
    assert.equal(first.type, "snapshot");
    assert.deepEqual(first.records.map(({ event }) => event.type), before);
    if (!openStep) {
      await agent.session.flush();
      assert.equal(agent.session.stagedOccupied, false);
      assert.equal(agent.storageOpen, false);
      assert.deepEqual(observed, [...before, "compaction/start"]);
      assert.deepEqual(followFrame(await follow.next()), agent.snapshot().records.at(-1));
    }
    release.resolve();
    const error = await rejected.promise;
    await agent.waitForIdle();
    const attemptedEnds = append.mock.calls.map(({ arguments: [input] }) => input.type).filter((type) => type === "step/end" || type === "turn/end");
    assert.deepEqual({ error, attemptedEnds }, { error: fault, attemptedEnds: [] });
    assert.throws(() => agent.prompt({ ...request, requestId: "next" }), (failure) => failure instanceof Error && failure.cause === fault);
    await assert.rejects(agent.runMaintenance(async () => {}), (failure) => failure instanceof Error && failure.cause === fault);
    assert.deepEqual(agent.prompt(request), { accepted: true });
    assert.equal(summaryCalls, 0);
    assert.equal(businessCalls, openStep ? 1 : 0);
    assert.deepEqual(agent.session.snapshot().events.map((event) => event.type), persisted);
    assert.deepEqual(observed, persisted);
    assert.deepEqual((await read())?.records.map(({ event }) => event.type), persisted);
    const lastFollow = followSession(manager, read, "s", new AbortController().signal);
    try {
      const reconnect = followFrame(await lastFollow.next());
      assert.equal(reconnect.type, "snapshot");
      assert.deepEqual(reconnect.records.map(({ event }) => event.type), persisted);
      assert.deepEqual(reconnect.assistantStream, first.assistantStream);
    } finally { await lastFollow.return(undefined); }
  });
}

function prefix(session: Session): void {
  for (const turn of [1, 2]) session.append({ type: "user/message", surfaceOp: "append", data: {
    id: `u${turn}`, role: "user", turn, requestId: `r${turn}`, source: { kind: "user" }, content: [{ type: "text", text: `消息${turn}` }],
  } });
  session.append({ type: "compaction/start", data: { compactionId: "c", turn: null } });
}

function batch(firstSeq: number, attempt: CompactionAttemptIdentity = { compactionId: "c", turn: null }, range = { start: 0, end: 1 }, messageId = "summary"): readonly SessionAppendInput[] {
  const { start, end } = range;
  const shadowedSeqs = start === end ? [start] : [start, end];
  return [
    { type: "compaction/summary", data: { compactionId: attempt.compactionId, ...(attempt.sourceCommandId === undefined ? {} : { sourceCommandId: attempt.sourceCommandId }), summary: "摘要", shadowedRange: range, shadowedSeqs, route: { provider: "p", model: "m" } } },
    { type: "user/message", surfaceOp: { op: "replace", ...range }, sourceEventSeqs: [firstSeq, ...shadowedSeqs], data: {
      id: messageId, role: "user", source: { kind: "compact", compactionId: attempt.compactionId }, ...(attempt.sourceCommandId === undefined ? {} : { sourceCommandId: attempt.sourceCommandId }), content: [{ type: "text", text: "摘要" }],
    } },
    { type: "compaction/end", data: { ...attempt, status: "succeeded" } },
  ];
}

test("手动身份贯穿真实 SQLite 的开始、摘要、checkpoint 和终态", async (testContext) => {
  const { agent, read } = await persistedAgent(testContext, async () => {});
  const identity = { compactionId: "fixed-compaction", sourceCommandId: "command-1" };
  let persistedBeforeGeneration = false;
  const result = await agent.runMaintenance(async (signal) => {
    const context = { session: agent.session, turn: null, signal, identity, storageOpen: () => agent.storageOpen, blockStorage: (error: unknown) => agent.blockStorage(error) };
    const model = new LlmRuntime({ mock: { async *generate() {
      const start = (await read())?.records.at(-1)?.event;
      assert.equal(start?.type, "compaction/start");
      assert.deepEqual(start.data, { ...identity, turn: null });
      persistedBeforeGeneration = true;
      yield { type: "finish", reason: { kind: "stop" } };
    } } }).prepare({ provider: "mock", model: "m" });
    const attempt = await runCompactionAttempt(context, () => ({ kind: "ready", input: summaryInput, model }));
    assert.equal(attempt.status, "generated");
    assert.equal(persistedBeforeGeneration, true);
    assert.deepEqual(attempt.attempt, { ...identity, turn: null });
    assert.ok(Object.isFrozen(attempt.attempt));
    const commit = await commitCompactionBatch(context, (firstSeq) => batch(firstSeq, attempt.attempt, { start: 1, end: 1 }));
    assert.equal(commit.status, "committed");
    return attempt;
  });
  const history = await read();
  assert.ok(history);
  const records = history.records.slice(3).map(({ event }) => event);
  assert.deepEqual(records.map((event) => event.type), ["compaction/start", "compaction/summary", "user/message", "compaction/end"]);
  for (const event of records) {
    assert.ok(event.type === "compaction/start" || event.type === "compaction/summary" || event.type === "user/message" || event.type === "compaction/end");
    if (event.type === "user/message") {
      assert.ok(event.data.source.kind === "compact");
      assert.ok("sourceCommandId" in event.data);
      assert.equal(event.data.sourceCommandId, identity.sourceCommandId);
      assert.equal(event.data.source.compactionId, result.attempt.compactionId);
    } else {
      assert.equal(event.data.sourceCommandId, identity.sourceCommandId);
      assert.equal(event.data.compactionId, result.attempt.compactionId);
    }
  }
  const restored = new Session(agent.session.header, { seed: { kind: "restore", inheritedEventCount: 0, events: history.records.map(({ event }) => event) } });
  assert.deepEqual(restored.snapshot().events, agent.session.snapshot().events);
});

test("手动生成失败保留身份，自动生成省略命令关联，旧日志可重放", async () => {
  const session = new Session({ sessionId: "identity", createdAt: 1 });
  session.bindCheckpoint(async () => {}, async (_events, finish) => {
    const result = { status: "committed" } as const;
    finish(result);
    return result;
  });
  const controller = new AbortController();
  const signal = controller.signal;
  const context = { session, turn: null, signal, storageOpen: () => true, blockStorage: () => assert.fail() };
  const error = new Error("generation failed");
  const model = new LlmRuntime({ mock: { async *generate() { controller.abort(error); yield { type: "finish", reason: { kind: "stop" } }; } } }).prepare({ provider: "mock", model: "m" });
  const failed = await runCompactionAttempt({ ...context, identity: { compactionId: "fixed", sourceCommandId: "cmd" } }, () => ({ kind: "ready", input: summaryInput, model }));
  assert.equal(failed.status, "generation-failed");
  assert.equal(failed.error, error);
  assert.deepEqual(failed.attempt, { compactionId: "fixed", sourceCommandId: "cmd", turn: null });
  const automatic = await runCompactionAttempt({ ...context, signal: new AbortController().signal }, () => ({ kind: "ready", input: summaryInput, model: summaryModel() }));
  assert.equal(automatic.status, "generated");
  assert.notEqual(automatic.attempt.compactionId, "fixed");
  assert.equal(Object.hasOwn(automatic.attempt, "sourceCommandId"), false);
  const old = new Session({ sessionId: "old", createdAt: 1 });
  old.bindCheckpoint(async () => {}, async (_events, finish) => {
    const result = { status: "committed" } as const;
    finish(result);
    return result;
  });
  prefix(old);
  assert.equal((await commitCompactionBatch({ session: old, storageOpen: () => true, blockStorage: () => assert.fail() }, batch)).status, "committed");
  const restored = new Session(old.header, { seed: { kind: "restore", inheritedEventCount: 0, events: old.snapshot().events } });
  assert.deepEqual(restored.snapshot().events, old.snapshot().events);
});

test("暂存批次确认后完整发布，协议保留原始事件", async () => {
  const session = new Session({ sessionId: "s", createdAt: 1 });
  let finishCommit: (() => void) | undefined;
  let checkpoints = 0;
  let staged = 0;
  session.bindCheckpoint(async () => { checkpoints++; }, async (_events, finish) => {
    staged++;
    await new Promise<void>((resolve) => { finishCommit = resolve; });
    const result = { status: "committed" } as const;
    finish(result);
    return result;
  });
  prefix(session);
  const before = session.snapshot();
  const oldMessages = session.deriveMessages();
  const observed: number[] = [];
  session.on("session/event", (event) => {
    observed.push(event.seq);
    assert.equal(session.seq, 6);
    assert.equal(session.deriveMessages().length, 1);
    assert.equal(session.replaceGeneration, 1);
  });
  const pending = commitCompactionBatch({ session, storageOpen: () => true, blockStorage: () => assert.fail() }, batch);
  assert.equal(staged, 1);
  assert.deepEqual(session.snapshot(), before);
  assert.deepEqual(session.deriveMessages(), oldMessages);
  assert.equal(session.replaceGeneration, 0);
  assert.deepEqual(observed, []);
  finishCommit?.();
  assert.equal((await pending).status, "committed");
  assert.deepEqual(observed, [3, 4, 5]);
  await session.flush(); await session.flush();
  assert.equal(checkpoints, 2);
  assert.deepEqual(observed, [3, 4, 5]);
  const records = session.snapshot().events.map((event) => ({ type: "event" as const, event }));
  for (const frame of records) {
    assert.deepEqual(rawSessionEventFrameSchema.parse(frame), frame);
    assert.deepEqual(followFrameSchema.parse(frame), frame);
  }
  assert.deepEqual(rawSessionHistorySchema.parse({ sessionId: "s", inheritedEventCount: 0, cursor: 5, records }).records, records);
  for (const invalid of [
    { type: "compaction/start", data: { compactionId: "c" } },
    { type: "compaction/start", data: { compactionId: "c", turn: 0 } },
    { type: "compaction/end", data: { compactionId: "c", turn: null, status: "failed" } },
    { type: "compaction/end", data: { compactionId: "c", turn: null, status: "succeeded", reason: "bad" } },
    { type: "compaction/end", data: { compactionId: "c", sourceCommandId: "", turn: null, status: "failed", reason: "bad" } },
  ]) assert.equal(rawSessionEventFrameSchema.safeParse({ type: "event", event: { ...invalid, seq: 0, time: 1 } }).success, false);
  for (const event of [
    { type: "compaction/start", data: { compactionId: "d", turn: 2 } },
    { type: "compaction/end", data: { compactionId: "d", turn: 2, status: "cancelled", reason: "cancelled" } },
    { type: "compaction/end", data: { compactionId: "d", sourceCommandId: "cmd", turn: null, status: "failed", reason: "failed" } },
  ]) assert.equal(rawSessionEventFrameSchema.safeParse({ type: "event", event: { ...event, seq: 0, time: 1 } }).success, true);
});

test("确认回滚不发布且不关闭存储准入", async () => {
  const session = new Session({ sessionId: "s", createdAt: 1 });
  const failure = new Error("rollback");
  session.bindCheckpoint(async () => {}, async (_events, finish) => {
    const result = { status: "rolled-back", error: failure } as const;
    finish(result);
    return result;
  });
  prefix(session);
  const before = session.snapshot();
  const messages = session.deriveMessages();
  const result = await commitCompactionBatch({ session, storageOpen: () => true, blockStorage: () => assert.fail() }, batch);
  assert.deepEqual(result, { status: "rolled-back", error: failure });
  assert.deepEqual(session.snapshot(), before);
  assert.deepEqual(session.deriveMessages(), messages);
  assert.equal(session.replaceGeneration, 0);
});

test("真实 SQLite 在提交前保持旧前缀，失败时整批回滚", async (testContext) => {
  const dir = await mkdtemp(join(tmpdir(), "compact-sqlite-"));
  const path = join(dir, "db.sqlite");
  const store = new SqliteSessionPersistence(path);
  const reader = new DatabaseSync(path, { readOnly: true });
  const injection = new DatabaseSync(path);
  testContext.after(async () => { reader.close(); injection.close(); await store.close(); await rm(dir, { recursive: true, force: true }); });
  for (const id of ["success", "rollback"]) {
    const header = { sessionId: id, createdAt: 1 };
    const handle = await store.create(header);
    await handle.flush();
    const session = new Session(header);
    store.bindWriter(handle, session);
    prefix(session);
    await session.flush();
    const before = session.snapshot();
    const oldMessages = session.deriveMessages();
    const observed: number[] = [];
    session.on("session/event", (event) => observed.push(event.seq));
    if (id === "rollback") injection.exec("CREATE TRIGGER fail_compact BEFORE INSERT ON mh_events WHEN NEW.session_id = 'rollback' AND NEW.seq = 4 BEGIN SELECT RAISE(ABORT, 'failure'); END");
    const original = DatabaseSync.prototype.exec;
    let writer: DatabaseSync | undefined;
    let sawCommit = false;
    const monitor = testContext.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE") writer = this;
      if (this === writer && sql === "COMMIT") {
        sawCommit = true;
        assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM mh_events WHERE session_id = ?").get(id)?.count, 3);
        assert.deepEqual(session.snapshot(), before);
        assert.deepEqual(session.deriveMessages(), oldMessages);
        assert.equal(session.replaceGeneration, 0);
        assert.deepEqual(observed, []);
      }
      return original.call(this, sql);
    });
    try {
      const result = await commitCompactionBatch({ session, storageOpen: () => true, blockStorage: () => assert.fail() }, batch);
      assert.equal(result.status, id === "success" ? "committed" : "rolled-back");
      assert.equal(sawCommit, id === "success");
    } finally { monitor.mock.restore(); }
    if (id === "rollback") injection.exec("DROP TRIGGER fail_compact");
    await session.flush(); await store.flush();
    const history = await readPersistedSessionHistory(store, id);
    assert.ok(history);
    assert.deepEqual(history.records.map((record) => record.event), session.snapshot().events);
    assert.equal(history.records.length, id === "success" ? 6 : 3);
    assert.deepEqual(observed, id === "success" ? [3, 4, 5] : []);
    assert.equal(session.replaceGeneration, id === "success" ? 1 : 0);
    if (id === "rollback") assert.deepEqual(session.deriveMessages(), oldMessages);
    await handle.close();
  }
});

test("未知暂存结果先关闭准入并保留原始错误", async () => {
  const session = new Session({ sessionId: "s", createdAt: 1 });
  const failure = new Error("unknown commit");
  let open = true;
  let reported: unknown;
  let builds = 0;
  session.bindCheckpoint(async () => {}, async () => ({ status: "pending-reconciliation", error: failure }));
  const context = { session, storageOpen: () => open, blockStorage: (error: unknown) => { open = false; reported = error; } };
  const result = await commitCompactionBatch(context, () => {
    builds++;
    return [{ type: "compaction/start", data: { compactionId: "c", turn: null } }];
  });
  assert.equal(result.status, "pending-reconciliation");
  assert.equal(reported, failure);
  assert.equal(open, false);
  assert.equal(session.seq, 0);
  await assert.rejects(commitCompactionBatch(context, () => { builds++; return []; }), { code: "storage_blocked" });
  assert.equal(builds, 1);
});

for (const hookName of ["preStep", "recoverOverflow"] as const) {
  test(`Turn ${hookName} 待核对经 flush 释放后仍拒绝第二次压缩`, async () => {
    const session = new Session({ sessionId: "s", createdAt: 1 });
    const fault = new Error("pending");
    let finishPending: (() => void) | undefined;
    let writes = 0;
    let summaryCalls = 0;
    let first: Awaited<ReturnType<typeof runCompactionAttempt>> | undefined;
    let occupiedBeforeFlush: boolean | undefined;
    let occupiedAfterFlush: boolean | undefined;
    let second: { status: "resolved" } | { status: "rejected"; error: unknown } | undefined;
    const reports: unknown[] = [];
    session.bindCheckpoint(async () => { finishPending?.(); finishPending = undefined; }, async (_events, finish) => {
      writes++;
      if (writes > 1) {
        const result = { status: "committed" } as const;
        finish(result);
        return result;
      }
      finishPending = () => finish({ status: "committed" });
      return { status: "pending-reconciliation", error: fault };
    });
    const hook = async (context: StepHookContext) => {
      first = await runCompactionAttempt(context, () => ({ kind: "ready", input: summaryInput, model: summaryModel(() => { summaryCalls++; }) }));
      occupiedBeforeFlush = session.stagedOccupied;
      await session.flush();
      occupiedAfterFlush = session.stagedOccupied;
      try {
        await runCompactionAttempt(context, () => ({ kind: "ready", input: summaryInput, model: summaryModel(() => { summaryCalls++; }) }));
        second = { status: "resolved" };
      } catch (error) { second = { status: "rejected", error }; }
    };
    const driver = createModelTurnDriver({
      runtime: new LlmRuntime({ mock: { async *generate() { throw new LlmError("CONTEXT_WINDOW_EXCEEDED"); } } }),
      config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "",
      ...(hookName === "preStep" ? { preStep: hook } : { recoverOverflow: async (context) => { await hook(context); return true; } }),
    });
    session.append({ type: "turn/start", data: { turn: 1 } });
    await assert.rejects(driver({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: (error) => reports.push(error) }), (error) => error === fault);
    assert.equal(first?.status, "start-not-confirmed");
    assert.equal(first.commit.status, "pending-reconciliation");
    assert.equal(first.commit.error, fault);
    assert.equal(occupiedBeforeFlush, true);
    assert.equal(occupiedAfterFlush, false);
    assert.deepEqual(reports, [fault]);
    const types = session.snapshot().events.map((event) => event.type);
    assert.deepEqual({
      second: second?.status,
      code: second?.status === "rejected" && second.error instanceof AgentError ? second.error.code : undefined,
      writes, summaryCalls, starts: types.filter((type) => type === "compaction/start").length,
    }, { second: "rejected", code: "storage_blocked", writes: 1, summaryCalls: 0, starts: 1 });
    assert.equal(types.includes("step/end"), false);
    assert.equal(types.includes("turn/end"), false);
    assert.equal(types.includes("step/start"), hookName === "recoverOverflow");
  });
}

test("同一 preStep 内压缩结算后仍允许再次压缩", async () => {
  const session = new Session({ sessionId: "s", createdAt: 1 });
  let writes = 0;
  let summaryCalls = 0;
  let surfaceSeq = 1;
  session.bindCheckpoint(async () => {}, async (_events, finish) => {
    writes++;
    const result = { status: "committed" } as const;
    finish(result);
    return result;
  });
  const driver = createModelTurnDriver({
    runtime: new LlmRuntime({ mock: { async *generate() { yield { type: "finish", reason: { kind: "stop" } }; } } }),
    config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "",
    preStep: async (context) => {
      for (let index = 0; index < 2; index++) {
        const result = await runCompactionAttempt(context, () => ({ kind: "ready", input: summaryInput, model: summaryModel(() => { summaryCalls++; }) }));
        assert.equal(result.status, "generated");
        const range = { start: surfaceSeq, end: surfaceSeq };
        assert.equal((await commitCompactionBatch(context, (seq) => {
          surfaceSeq = seq + 1;
          return batch(seq, result.attempt, range, `summary-${result.attempt.compactionId}`);
        })).status, "committed");
      }
    },
  });
  session.append({ type: "turn/start", data: { turn: 1 } });
  session.append({ type: "user/message", surfaceOp: "append", data: { id: "u", role: "user", turn: 1, requestId: "r", source: { kind: "user" }, content: [{ type: "text", text: "消息" }] } });
  await driver({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => assert.fail() });
  assert.equal(writes, 4);
  assert.equal(summaryCalls, 2);
  const events = session.snapshot().events;
  const starts = events.flatMap((event) => event.type === "compaction/start" ? [event.data] : []);
  const ends = events.flatMap((event) => event.type === "compaction/end" ? [event.data] : []);
  assert.equal(starts.length, 2);
  assert.deepEqual(ends, starts.map((start) => ({ ...start, status: "succeeded" })));
});
