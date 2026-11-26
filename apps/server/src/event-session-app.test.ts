import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSessionResponseSchema, rawSessionEventFrameSchema, rawSessionHistorySchema, type RawSessionEventFrame } from "@mharness/session/contracts";
import { Session, SqliteSessionPersistence } from "@mharness/session/server";
import { AgentManager } from "./agent/manager.ts";
import { createEventSessionApp } from "./app.ts";
import { makeCompactionRecoveryFixtures } from "../../../packages/session/src/compaction-recovery-fixtures.ts";

test("启动恢复真实压缩夹具并在重开时保持幂等", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-compaction-startup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  const fixture = makeCompactionRecoveryFixtures().independentInterrupted;
  const storage = new SqliteSessionPersistence(path);
  try {
    const handle = await storage.create(fixture.header, { inheritedEventCount: fixture.inheritedEventCount });
    await handle.append(fixture.events);
    await handle.close();
  } finally { await storage.close(); }
  let turns = 0;
  for (let i = 0; i < 2; i++) {
    const app = await createEventSessionApp(path, false, async () => { turns++; });
    try {
      await app.ready();
      const response = await app.inject({ method: "GET", url: `/api/sessions/${fixture.header.sessionId}` });
      const history = rawSessionHistorySchema.parse(response.json());
      const events = history.records.map(record => record.event);
      assert.deepEqual(events.slice(0, fixture.events.length), fixture.events);
      assert.deepEqual(events.slice(fixture.events.length).map(event => event.type), ["compaction/end", "command/done"]);
      assert.deepEqual(events.at(-2)?.data, { compactionId: "I1", turn: null, sourceCommandId: "I", status: "interrupted", reason: { kind: "process_interrupted" } });
      assert.equal(turns, 0);
    } finally { await app.close(); }
  }
});

test("启动恢复只关闭压缩和实际打开的范围，并保留已确认的替换", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-compaction-turn-startup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  const fixtures = makeCompactionRecoveryFixtures();
  const cases = [
    { fixture: fixtures.preStepInterrupted, compactionId: "P1", step: undefined, surface: [1, 4, 8], generation: 0 },
    { fixture: fixtures.prunedInterrupted, compactionId: "R1", step: 2, surface: [1, 4, 8, 10, 18], generation: 1 },
    { fixture: fixtures.secondSummaryInterrupted, compactionId: "S2", step: undefined, surface: [11, 8], generation: 1 },
  ] as const;
  const storage = new SqliteSessionPersistence(path);
  try {
    for (const { fixture } of cases) {
      const handle = await storage.create(fixture.header);
      try {
        await handle.append(fixture.events);
      } finally {
        await handle.close();
      }
    }
  } finally {
    await storage.close();
  }

  let turns = 0;
  const runTurn = async () => { turns++; assert.fail("启动恢复不应执行 Turn"); };
  const confirmed = new Map<string, RawSessionEventFrame["event"][]>();
  for (let attempt = 0; attempt < 2; attempt++) {
    const app = await createEventSessionApp(path, false, runTurn);
    try {
      await app.ready();
      for (const { fixture, compactionId, step, surface, generation } of cases) {
        const { sessionId } = fixture.header;
        const response = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
        assert.equal(response.statusCode, 200, sessionId);
        const history = rawSessionHistorySchema.parse(response.json());
        const events = history.records.map(record => record.event);
        assert.deepEqual(events.slice(0, fixture.events.length), fixture.events, sessionId);
        const repaired = events.slice(fixture.events.length).map(({ type, data }) => ({ type, data }));
        assert.deepEqual(repaired, [
          { type: "compaction/end", data: { compactionId, turn: 2, status: "interrupted", reason: { kind: "process_interrupted" } } },
          ...(step === undefined ? [] : [{ type: "step/end", data: { turn: 2, step } }]),
          { type: "turn/end", data: { turn: 2, reason: { kind: "interrupted" } } },
        ], sessionId);
        const previous = confirmed.get(sessionId);
        if (previous) assert.deepEqual(events, previous, sessionId);
        else confirmed.set(sessionId, events);

        const expectedMessages = surface.map(seq => {
          const event = fixture.events[seq];
          assert.ok(event?.type === "user/message" || event?.type === "assistant/message" || event?.type === "tool/result");
          return event.type === "user/message" ? event.data : event.data.message;
        });
        const session = new Session(fixture.header, {
          seed: { kind: "restore", events, inheritedEventCount: history.inheritedEventCount },
        });
        assert.deepEqual(session.deriveSurfaceNodes().map(node => node.seq), surface, sessionId);
        assert.deepEqual(session.deriveMessages(), expectedMessages, sessionId);
        assert.equal(session.replaceGeneration, generation, sessionId);
      }
    } finally {
      await app.close();
    }
  }
  assert.equal(turns, 0);
});

test("启动遇到压缩关联冲突时拒绝就绪并保留原前缀", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-compaction-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  const fixture = makeCompactionRecoveryFixtures().settledWithoutDone.succeeded;
  const events = fixture.events.map(event => event.type === "compaction/end" ? { ...event, data: { ...event.data, turn: 1 } } : event);
  const storage = new SqliteSessionPersistence(path);
  try {
    const handle = await storage.create(fixture.header);
    await handle.append(events);
    await handle.close();
  } finally { await storage.close(); }
  const app = await createEventSessionApp(path);
  try { await assert.rejects(async () => { await app.ready(); }, /K1-succeeded/); } finally { await app.close(); }
  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  try {
    const reader = await observer.open(fixture.header.sessionId, "read");
    assert.ok(reader);
    assert.deepEqual(await reader.read(), events);
    await reader.close();
  } finally { await observer.close(); }
});

test("启动修复事务回滚后释放写入权，后续启动只修复一次", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-startup-rollback-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  const fixture = makeCompactionRecoveryFixtures().independentInterrupted;
  const storage = new SqliteSessionPersistence(path);
  try {
    const handle = await storage.create(fixture.header);
    await handle.append(fixture.events);
    await handle.close();
  } finally { await storage.close(); }
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TRIGGER reject_startup BEFORE INSERT ON mh_events WHEN NEW.seq = ${fixture.events.length + 1} BEGIN SELECT RAISE(ABORT, 'startup failure'); END`);
    let turns = 0;
    const failed = await createEventSessionApp(path, false, async () => { turns++; });
    try { await assert.rejects(async () => { await failed.ready(); }, /startup failure/); } finally { await failed.close(); }
    const observer = new SqliteSessionPersistence(path, { readOnly: true });
    try {
      const reader = await observer.open(fixture.header.sessionId, "read");
      assert.ok(reader);
      assert.deepEqual(await reader.read(), fixture.events);
      await reader.close();
    } finally { await observer.close(); }
    db.exec("DROP TRIGGER reject_startup");
    for (let i = 0; i < 2; i++) {
      const app = await createEventSessionApp(path, false, async () => { turns++; });
      try {
        await app.ready();
        const response = await app.inject({ method: "GET", url: `/api/sessions/${fixture.header.sessionId}` });
        const events = rawSessionHistorySchema.parse(response.json()).records.map(record => record.event);
        assert.deepEqual(events.slice(0, fixture.events.length), fixture.events);
        assert.deepEqual(events.slice(fixture.events.length).map(event => event.type), ["compaction/end", "command/done"]);
        assert.equal(turns, 0);
      } finally { await app.close(); }
    }
  } finally { db.close(); }
});

test("新版 HTTP 创建提交空 header，启动修复后按原始事件读取", async (t) => {
  const load = t.mock.method(AgentManager.prototype, "load");
  const dir = await mkdtemp(join(tmpdir(), "mharness-online-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  const seed = new SqliteSessionPersistence(path);
  try {
    const handle = await seed.create({ sessionId: "interrupted", createdAt: 0 });
    await handle.append([{ type: "turn/start", seq: 0, time: 10, data: { turn: 1 } }]);
    await handle.close();
  } finally {
    await seed.close();
  }

  const app = await createEventSessionApp(path);
  try {
    await app.ready();
    assert.equal(load.mock.callCount(), 0);
    const history = await app.inject({ method: "GET", url: "/api/sessions/interrupted" });
    assert.equal(history.statusCode, 200);
    const recovered = rawSessionHistorySchema.parse(history.json());
    assert.equal(recovered.cursor, 1);
    assert.deepEqual(recovered.records[0]?.event, { type: "turn/start", seq: 0, time: 10, data: { turn: 1 } });
    assert.deepEqual(recovered.records[1]?.event.data, { turn: 1, reason: { kind: "interrupted" } });
    const cancelled = await app.inject({ method: "POST", url: "/api/sessions/interrupted/cancel" });
    assert.equal(cancelled.statusCode, 404);
    assert.deepEqual(cancelled.json(), { code: "session/not-found" });
    assert.equal(load.mock.callCount(), 0);

    const creation = await app.inject({ method: "POST", url: "/api/sessions" });
    assert.equal(creation.statusCode, 201);
    const { sessionId } = createSessionResponseSchema.parse(creation.json());
    const observer = new SqliteSessionPersistence(path, { readOnly: true });
    try {
      assert.equal((await observer.stat(sessionId))?.eventCount, 0);
    } finally {
      await observer.close();
    }
    const empty = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    assert.deepEqual(rawSessionHistorySchema.parse(empty.json()), { sessionId, inheritedEventCount: 0, cursor: -1, records: [] });
    await assert.rejects(createEventSessionApp(path), { name: "OwnershipConflictError" });
  } finally {
    await app.close();
  }

  const reopened = await createEventSessionApp(path);
  try {
    const history = await reopened.inject({ method: "GET", url: "/api/sessions/interrupted" });
    assert.equal(rawSessionHistorySchema.parse(history.json()).cursor, 1);
  } finally {
    await reopened.close();
  }
});

test("SQLite、HTTP 与浏览器契约保留事件的原始 JSON 键", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-wire-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  const storage = new SqliteSessionPersistence(path);
  const session = new Session({ sessionId: "会话🧪", createdAt: 0 });
  const validatedArgs = { nested: { ["__proto__"]: { kept: true }, constructor: 42 } };
  let operation: Extract<RawSessionEventFrame["event"], { type: "tool/operation" }>;
  try {
    const handle = await storage.create(session.header);
    await handle.flush();
    storage.bindWriter(handle, session);
    session.append({ type: "turn/start", data: { turn: 1 } });
    session.append({ type: "step/start", data: { turn: 1, step: 1 } });
    session.append({
      type: "assistant/message", surfaceOp: "append", data: {
        turn: 1, step: 1, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true,
        message: { id: "a", role: "assistant", source: { provider: "p", model: "m" }, content: [
          { type: "tool-call", id: "call", name: "read", arguments: JSON.stringify(validatedArgs) },
        ] },
      },
    });
    session.append({ type: "tool/call", data: {
      turn: 1, step: 1, callId: "call", name: "read", arguments: JSON.stringify(validatedArgs),
    } });
    operation = session.append({ type: "tool/operation", data: {
      turn: 1, step: 1, callId: "call", operationId: "op", toolName: "read", toolVersion: "1", validatedArgs,
    } });
    await session.flush();
    assert.deepEqual((await handle.read(operation.seq, 1))[0], operation);
  } finally {
    await storage.close();
  }

  const app = await createEventSessionApp(path);
  try {
    const response = await app.inject({ method: "GET", url: `/api/sessions/${encodeURIComponent(session.header.sessionId)}` });
    assert.equal(response.statusCode, 200);
    const raw: { records: unknown[] } = response.json();
    assert.deepEqual(raw.records[operation.seq], { type: "event", event: operation });
    const history = rawSessionHistorySchema.parse(raw);
    assert.equal(history.cursor, 7);
    assert.deepEqual(history.records[operation.seq]?.event, operation);
    assert.deepEqual(rawSessionEventFrameSchema.parse(raw.records[operation.seq]).event, operation);
    assert.deepEqual(history.records.at(-1)?.event.data, { turn: 1, reason: { kind: "interrupted" } });
    const invalid = await app.inject({ method: "GET", url: "/api/sessions/bad%00id" });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("不同端口的独立进程不能抢占在线库，持有者退出后可恢复遗留记录", { timeout: 15_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-instance-"));
  const path = join(dir, "events.sqlite");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const moduleUrl = new URL("./app.ts", import.meta.url).href;
  const script = `
    const [path, port, role] = process.argv.slice(1);
    const { createEventSessionApp } = await import(${JSON.stringify(moduleUrl)});
    const { SqliteSessionPersistence } = await import("@mharness/session/server");
    try {
      const app = await createEventSessionApp(path);
      const url = await app.listen({ host: "127.0.0.1", port: Number(port) });
      if (role === "owner") {
        const storage = new SqliteSessionPersistence(path);
        const writer = await storage.create({ sessionId: "active", createdAt: 0 });
        await writer.append([{ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }]);
      }
      process.send({ url });
    } catch (error) {
      process.send({ error: error.name }, () => process.exit(1));
    }
  `;
  const start = (port: number, role: string) => spawn(
    process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path, String(port), role],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const owner = start(0, "owner");
  let competitor: ReturnType<typeof start> | undefined;
  const message = (child: ReturnType<typeof start>) => Promise.race([
    once(child, "message"),
    once(child, "exit").then(([code, signal]) => {
      throw new Error(`测试后端提前退出: ${code ?? signal}`);
    }),
  ]);
  try {
    const [ownerMessage]: unknown[] = await message(owner);
    assert.ok(ownerMessage && typeof ownerMessage === "object" && "url" in ownerMessage && typeof ownerMessage.url === "string");
    const ownerPort = Number(new URL(ownerMessage.url).port);
    competitor = start(ownerPort === 65535 ? 65534 : ownerPort + 1, "competitor");
    const competitorExit = once(competitor, "exit");
    const [competition]: unknown[] = await message(competitor);
    assert.deepEqual(competition, { error: "OwnershipConflictError" });
    assert.equal((await competitorExit)[0], 1);
    const observer = new SqliteSessionPersistence(path, { readOnly: true });
    try {
      const handle = await observer.open("active", "read");
      assert.deepEqual((await handle?.read())?.map(({ type }) => type), ["turn/start"]);
    } finally {
      await observer.close();
    }

    const exited = once(owner, "exit");
    owner.kill();
    await exited;
    const replacement = await createEventSessionApp(path);
    try {
      const response = await replacement.inject({ method: "GET", url: "/api/sessions/active" });
      const history = rawSessionHistorySchema.parse(response.json());
      assert.deepEqual(history.records.map(({ event }) => event.type), ["turn/start", "turn/end"]);
      assert.deepEqual(history.records[1]?.event.data, { turn: 1, reason: { kind: "interrupted" } });
    } finally {
      await replacement.close();
    }
  } finally {
    for (const child of [owner, competitor]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }
  }
});

test("生产关闭先失效在途创建核实再关闭 Agent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-create-production-close-"));
  let app: Awaited<ReturnType<typeof createEventSessionApp>> | undefined;
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(async () => {
    release();
    try { await app?.close(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
  let checks = 0;
  const originalCreate = SqliteSessionPersistence.prototype.create;
  t.mock.method(SqliteSessionPersistence.prototype, "create", async function (this: SqliteSessionPersistence, ...args: Parameters<typeof originalCreate>) {
    const handle = await originalCreate.apply(this, args);
    t.mock.method(handle, "flush", async () => { throw new Error("flush fault"); });
    handle.creationVerifier = () => async () => {
      checks++;
      if (checks === 1) return "unknown";
      entered();
      await gate;
      return "failed";
    };
    return handle;
  });
  const { SessionCommandController } = await import("./commands.ts");
  const originalController = SessionCommandController.prototype.creationController;
  let controller: ReturnType<typeof originalController> | undefined;
  let creationStopped = false;
  let stoppedAtFirstAgentClose: boolean | undefined;
  let snapshot: (() => ReturnType<ReturnType<Parameters<typeof originalController>[1]>["snapshot"]>) | undefined;
  t.mock.method(SessionCommandController.prototype, "creationController", function (this: InstanceType<typeof SessionCommandController>, persistence: Parameters<typeof originalController>[0], directory: Parameters<typeof originalController>[1]) {
    const current = originalController.call(this, persistence, directory);
    if (!controller) {
      const close = current.close.bind(current);
      t.mock.method(current, "close", () => { close(); creationStopped = true; });
    }
    controller = current;
    snapshot = () => directory().snapshot();
    return controller;
  });
  const originalClose = AgentManager.prototype.close;
  t.mock.method(AgentManager.prototype, "close", async function (this: AgentManager) {
    stoppedAtFirstAgentClose ??= creationStopped;
    release();
    await Promise.resolve();
    await Promise.resolve();
    return originalClose.call(this);
  });
  app = await createEventSessionApp(join(dir, "events.sqlite"));
  await app.ready();
  const response = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
  assert.equal(response.statusCode, 503);
  const { sessionId } = response.json();
  await reached;
  assert.ok(snapshot);
  const before = snapshot();
  assert.ok(controller);
  const attempt = controller;
  const original = await attempt.create({ sessionId, createdAt: before.sessions[0]!.createdAt });
  assert.equal(original.status, "unknown");
  await app.close();
  assert.equal(stoppedAtFirstAgentClose, true, "关停 Agent 前必须先停止创建核实");
  assert.deepEqual(snapshot(), before);
  assert.equal((await attempt.create({ sessionId, createdAt: before.sessions[0]!.createdAt })).status, "unknown");
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(checks, 2);
});

test("真实 HTTP 列表包含实时摘要及其版本", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-http-"));
  let now = 1_700_000_000_000;
  t.mock.method(Date, "now", () => now);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const app = await createEventSessionApp(join(dir, "events.sqlite"), false, async () => { await gate; });
  t.after(async () => { finish(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  await app.ready();
  const created = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
  const { sessionId } = createSessionResponseSchema.parse(created.json());
  const initial = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
  assert.equal(initial.sessions[0].blank, true);
  now += 1_000;
  const sent = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { requestId: "r", content: [{ type: "text", text: "hello" }] } });
  assert.equal(sent.statusCode, 202);
  const snapshot = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
  assert.equal(snapshot.revision, initial.revision + 3);
  assert.equal(snapshot.sessions[0].blank, false);
  assert.equal(snapshot.sessions[0].running, true);
  assert.ok(snapshot.sessions[0].updatedAt >= initial.sessions[0].createdAt);
});
