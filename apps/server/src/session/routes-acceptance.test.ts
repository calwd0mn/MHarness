import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import Fastify from "fastify";
import { z } from "zod";
import { SqliteSessionPersistence } from "@mharness/session/server";
import { AgentManager } from "../agent/manager.ts";
import { ApprovalService } from "../approval/service.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { ReActAgent } from "../agent/react-agent.ts";
import { createEventSessionApp } from "../app.ts";
import { injectCompactionSqliteFault } from "./compaction-settlement-sqlite-fixture.ts";
import { compactResponseSchema, rawSessionHistorySchema } from "@mharness/session/contracts";
import { Session, type SessionPersistence } from "@mharness/session/server";
import { SessionCommandController } from "../commands.ts";
import { defineLocalTool, ToolRegistry } from "../tools/registry.ts";
import { defineLocalToolOutput } from "../tools/result.ts";
import { registerSessionRoutes } from "./routes.ts";
import { SessionDirectory } from "./directory.ts";

test("创建提交前可见，失败后撤回且查询不加载 Agent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-directory-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const app = Fastify();
  t.after(async () => { await app.close(); await persistence.close(); await rm(dir, { recursive: true, force: true }); });
  let unblock!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const create = persistence.create.bind(persistence);
  t.mock.method(persistence, "create", async (header: Parameters<typeof create>[0]) => {
    const handle = await create(header);
    t.mock.method(handle, "flush", async () => { entered(); await gate; throw new Error("flush fault"); });
    return handle;
  });
  const directory = new SessionDirectory();
  registerSessionRoutes(app, "/api/sessions", persistence, {
    prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }),
  }, { get: () => { throw new Error("不应加载 Agent"); }, onLoaded: () => () => {} }, () => directory);
  const post = app.inject({ method: "POST", url: "/api/sessions", payload: {} });
  await reached;
  const during = await app.inject({ method: "GET", url: "/api/sessions" });
  assert.equal(during.statusCode, 200);
  assert.equal(during.json().revision, 1);
  assert.equal(during.json().sessions.length, 1);
  const pendingId: string = during.json().sessions[0].sessionId;
  assert.equal((await app.inject({ method: "GET", url: `/api/sessions/${pendingId}` })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/sessions" })).json().revision, 1);
  unblock();
  assert.equal((await post).statusCode, 500);
  const after = await app.inject({ method: "GET", url: "/api/sessions" });
  assert.deepEqual(after.json(), { revision: 2, sessions: [] });
});

test("历史 GET 缺失不会裁决未知创建结果", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-unknown-directory-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const app = Fastify();
  t.after(async () => { await app.close(); await persistence.close(); await rm(dir, { recursive: true, force: true }); });
  const create = persistence.create.bind(persistence);
  t.mock.method(persistence, "create", async (header: Parameters<typeof create>[0]) => {
    const handle = await create(header);
    t.mock.method(handle, "flush", async () => { throw new Error("flush fault"); });
    handle.creationVerifier = () => async () => "unknown";
    return handle;
  });
  const directory = new SessionDirectory();
  registerSessionRoutes(app, "/api/sessions", persistence, {
    prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }),
  }, { get: () => undefined, onLoaded: () => () => {} }, () => directory);
  const response = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
  assert.equal(response.statusCode, 503);
  const { sessionId } = response.json() as { sessionId: string };
  const open = persistence.open.bind(persistence);
  const fault = t.mock.method(persistence, "open", async () => { throw new Error("read fault"); });
  assert.equal((await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` })).statusCode, 500);
  assert.equal(directory.snapshot().revision, 1);
  fault.mock.restore();
  assert.equal((await open(sessionId, "read")), undefined);
  assert.equal((await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` })).statusCode, 404);
  assert.equal(directory.snapshot().revision, 1);
  assert.equal(directory.snapshot().sessions.length, 1);
});

test("服务重启从已提交头恢复目录且重置版本", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-directory-restart-"));
  const path = join(dir, "events.sqlite");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const first = await createEventSessionApp(path);
  const created = await first.inject({ method: "POST", url: "/api/sessions", payload: {} });
  const { sessionId } = created.json() as { sessionId: string };
  assert.equal((await first.inject({ method: "GET", url: "/api/sessions" })).json().revision, 1);
  await first.close();
  const second = await createEventSessionApp(path);
  try {
    const snapshot = (await second.inject({ method: "GET", url: "/api/sessions" })).json();
    assert.equal(snapshot.revision, 0);
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.sessions[0].sessionId, sessionId);
    assert.equal(snapshot.sessions[0].blank, true);
  } finally { await second.close(); }
});

test("旧分支的无效父 ID 不阻断服务重启后的目录", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-directory-legacy-parent-"));
  const path = join(dir, "events.sqlite");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const persistence = new SqliteSessionPersistence(path);
  const parentSession = "parent\u0000old";
  const branch = new Session({ sessionId: "branch", createdAt: 2, isSeeded: true, parentSession },
    { seed: { kind: "fork", events: [] } });
  try {
    const ordinaryHandle = await persistence.create({ sessionId: "ordinary", createdAt: 1 });
    try { await ordinaryHandle.flush(); } finally { await ordinaryHandle.close(); }
    const branchHandle = await persistence.create(branch.header, { inheritedEventCount: branch.inheritedEventCount });
    try { await branchHandle.append(branch.snapshot().events); } finally { await branchHandle.close(); }
  } finally { await persistence.close(); }

  const app = await createEventSessionApp(path);
  try {
    const response = await app.inject({ method: "GET", url: "/api/sessions" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { revision: 0, sessions: [
      { sessionId: "branch", createdAt: 2, updatedAt: 2, running: false, blank: false },
      { sessionId: "ordinary", createdAt: 1, updatedAt: 1, running: false, blank: false },
    ] });
  } finally { await app.close(); }

  const reopened = new SqliteSessionPersistence(path, { readOnly: true });
  try {
    const saved = await reopened.stat("branch");
    assert.equal(saved?.header.parentSession, parentSession);
  } finally { await reopened.close(); }
});

test("创建会话按实际提交结果响应，关闭失败单独记录", async (t) => {
  for (const scenario of [
    { name: "提交成功后关闭失败", commit: true, flushFails: false, closeFails: true, statFails: false, status: 201 },
    { name: "提交报错但已写入", commit: true, flushFails: true, closeFails: false, statFails: false, status: 201 },
    { name: "确认未写入", commit: false, flushFails: true, closeFails: true, statFails: false, status: 500 },
    { name: "暂时无法核实", commit: true, flushFails: true, closeFails: false, statFails: true, status: 503 },
  ]) {
    await t.test(scenario.name, async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "mharness-create-"));
      const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
      const app = Fastify();
      t.after(async () => {
        await app.close();
        await persistence.close();
        await rm(dir, { recursive: true, force: true });
      });
      const logged = t.mock.method(app.log, "error");
      const create = persistence.create.bind(persistence);
      let createdId: string | undefined;
      t.mock.method(persistence, "create", async (header: Parameters<typeof create>[0]) => {
        createdId = header.sessionId;
        const handle = await create(header);
        const flush = handle.flush.bind(handle);
        const close = handle.close.bind(handle);
        t.mock.method(handle, "flush", async () => {
          if (scenario.commit) await flush();
          if (scenario.flushFails) throw new Error("flush fault");
        });
        t.mock.method(handle, "close", async () => {
          await close();
          if (scenario.closeFails) throw new Error("close fault");
        });
        if (scenario.statFails) handle.creationVerifier = () => async () => "unknown";
        return handle;
      });
      const directory = new SessionDirectory();
      registerSessionRoutes(app, "/api/sessions", persistence, {
        prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }),
      }, { get: () => undefined, onLoaded: () => () => {} }, () => directory);

      const response = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
      assert.ok(createdId);
      assert.equal(response.statusCode, scenario.status);
      assert.equal(logged.mock.calls.some((call) => call.arguments[1] === "关闭新会话句柄失败"), scenario.closeFails);
      assert.deepEqual(response.json(), scenario.status === 201 ? { sessionId: createdId }
        : scenario.status === 503 ? { code: "session_creation_unknown", sessionId: createdId }
        : { code: "session_creation_failed" });
      assert.equal(directory.snapshot().revision, scenario.status === 500 ? 2 : 1);
      assert.equal(directory.snapshot().sessions.length, scenario.status === 500 ? 0 : 1);
      const recovered = await app.inject({ method: "GET", url: `/api/sessions/${createdId}` });
      assert.equal(recovered.statusCode, scenario.commit ? 200 : 404);
      assert.equal(directory.snapshot().revision, scenario.status === 500 ? 2 : 1);
      assert.equal((await persistence.list()).length, Number(scenario.commit));
    });
  }
});

test("维护任务占用期间会话取消传递信号并等待任务退出", { timeout: 8000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-maintenance-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const manager = new AgentManager(persistence, async () => {});
  const app = Fastify();
  registerSessionRoutes(app, "/api/sessions", persistence, new SessionCommandController(manager), manager, () => new SessionDirectory());
  let release: (() => void) | undefined;
  try {
    const handle = await persistence.create({ sessionId: "s", createdAt: 1 });
    await handle.flush();
    await handle.close();
    const missing = await app.inject({ method: "POST", url: "/api/sessions/s/cancel" });
    assert.equal(missing.statusCode, 404);
    assert.equal(manager.get("s"), undefined);
    const agent = await manager.load("s");
    let observed = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const work = agent.runMaintenance(async (signal) => {
      signal.addEventListener("abort", () => { observed = true; });
      await gate;
    });
    await Promise.resolve();
    const busy = await app.inject({ method: "POST", url: "/api/sessions/s/messages", payload: {
      requestId: "new", content: [{ type: "text", text: "test" }],
    } });
    assert.equal(busy.statusCode, 409);
    assert.deepEqual(busy.json(), { code: "agent_busy" });
    const cancelled = await app.inject({ method: "POST", url: "/api/sessions/s/cancel" });
    assert.equal(cancelled.statusCode, 202);
    assert.deepEqual(cancelled.json(), { accept: true });
    assert.equal(observed, true);
    assert.equal(agent.state, "maintenance");
    release?.();
    await work;
    assert.equal(agent.state, "idle");
  } finally {
    release?.();
    await app.close();
    await manager.close();
    await persistence.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("命令路由校验请求并映射受理、忙碌和未知会话", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-route-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const app = Fastify();
  const calls: unknown[] = [];
  const { AgentError } = await import("../agent/react-agent.ts");
  registerSessionRoutes(app, "/api/sessions", persistence, {
    prompt: async (request) => {
      calls.push(request);
      if (request.requestId === "busy") throw new AgentError("agent_busy");
      if (request.sessionId === "missing") throw new AgentError("session/not-found");
      return { accepted: true };
    },
    cancel: async (id) => {
      calls.push(id);
      if (id === "missing") throw new AgentError("session/not-found");
      return { accept: true };
    },
  }, { get: () => undefined, onLoaded: () => () => {} }, () => new SessionDirectory());
  try {
    const content = [{ type: "text", text: "hello" }];
    const post = (id: string, requestId: string) => app.inject({ method: "POST", url: `/api/sessions/${id}/messages`, payload: { requestId, content } });
    for (const requestId of ["first", "first"]) {
      const response = await post("s", requestId);
      assert.equal(response.statusCode, 202);
      assert.deepEqual(response.json(), { accepted: true });
    }
    assert.deepEqual(calls[0], { sessionId: "s", requestId: "first", content });
    const busy = await post("s", "busy");
    assert.equal(busy.statusCode, 409);
    assert.deepEqual(busy.json(), { code: "agent_busy" });
    assert.equal((await post("missing", "x")).statusCode, 404);
    const before = calls.length;
    assert.equal((await app.inject({ method: "POST", url: "/api/sessions/s/messages", payload: { requestId: "x", content: [] } })).statusCode, 400);
    assert.equal(calls.length, before);
    assert.equal((await app.inject({ method: "POST", url: "/api/sessions/missing/cancel" })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/api/sessions/s/cancel" })).statusCode, 202);
  } finally {
    await app.close();
    await persistence.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("真实 SSE 首帧快照读取失败只发送一个安全终止帧", { timeout: 8000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-sse-fault-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const app = Fastify();
  const manager = new AgentManager(persistence, async () => {});
  registerSessionRoutes(app, "/api/sessions", persistence, new SessionCommandController(manager), manager, () => new SessionDirectory());
  try {
    persistence.open = async () => { throw new Error("private-storage-secret"); };
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${origin}/api/sessions/s/follow`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.doesNotMatch(body, /private-storage-secret/);
    const frames = body.trim().split("\n\n");
    assert.equal(frames.length, 1);
    assert.match(frames[0] ?? "", /^data: /);
    assert.equal(JSON.parse((frames[0] ?? "").slice(6)).type, "error");
  } finally {
    await app.close();
    await manager.close();
    await persistence.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("响应丢失并并发重发同一编号只执行一次真实模型请求", { timeout: 8000 }, async () => {
  const { createEventSessionApp } = await import("../app.ts");
  const { createModelTurnDriver } = await import("../agent/model-turn.ts");
  const { createMockAdapter } = await import("../model/providers/mock.ts");
  const { LlmRuntime } = await import("../model/runtime.ts");
  const dir = await mkdtemp(join(tmpdir(), "mharness-retry-model-"));
  let calls = 0;
  const driver = createModelTurnDriver({
    runtime: new LlmRuntime({ mock: createMockAdapter(() => {
      calls++;
      return [{ delayMs: 100, chunk: { type: "text", delta: "answer" } }, { chunk: { type: "finish", reason: { kind: "stop" } } }];
    }) }),
    config: () => ({ provider: "mock", model: "test" }), systemPrompt: () => "",
  });
  const app = await createEventSessionApp(join(dir, "events.sqlite"), false, driver);
  try {
    const created = await app.inject({ method: "POST", url: "/api/sessions" });
    const { sessionId } = created.json() as { sessionId: string };
    const url = `/api/sessions/${sessionId}`;
    const payload = { requestId: "lost", content: [{ type: "text", text: "hello" }] };
    await app.inject({ method: "POST", url: `${url}/messages`, payload });
    const retries = await Promise.all(Array.from({ length: 3 }, () => app.inject({ method: "POST", url: `${url}/messages`, payload })));
    for (const response of retries) {
      assert.equal(response.statusCode, 202);
      assert.deepEqual(response.json(), { accepted: true });
    }
    for (let i = 0; i < 100; i++) {
      const history = (await app.inject({ method: "GET", url })).json() as { records: { event: { type: string } }[] };
      if (history.records.some(({ event }) => event.type === "turn/end")) {
        assert.equal(history.records.filter(({ event }) => event.type === "user/message").length, 1);
        assert.equal(history.records.filter(({ event }) => event.type === "turn/start").length, 1);
        assert.equal(calls, 1);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("Turn 未完成");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("follow 可见未刷新的正式回答，独立读取及重启只恢复已提交前缀", { timeout: 8000 }, async () => {
  const { Session } = await import("@mharness/session/server");
  const { ReActAgent } = await import("../agent/react-agent.ts");
  const { createModelTurnDriver } = await import("../agent/model-turn.ts");
  const { createMockAdapter } = await import("../model/providers/mock.ts");
  const { LlmRuntime } = await import("../model/runtime.ts");
  const { followSession } = await import("./follow.ts");
  const { createEventSessionApp } = await import("../app.ts");
  const dir = await mkdtemp(join(tmpdir(), "mharness-prefix-"));
  const path = join(dir, "events.sqlite");
  const storage = new SqliteSessionPersistence(path);
  const handle = await storage.create({ sessionId: "s", createdAt: 1 });
  await handle.flush();
  const session = new Session(handle.header);
  session.bindCheckpoint(async () => { await handle.append(session.snapshot().events); await handle.flush(); });
  let calls = 0;
  const driver = createModelTurnDriver({
    runtime: new LlmRuntime({ mock: createMockAdapter(() => {
      calls++;
      return [{ chunk: { type: "text", delta: "live" } }, { chunk: { type: "finish", reason: { kind: "stop" } } }];
    }) }),
    config: () => ({ provider: "mock", model: "test" }), systemPrompt: () => "",
  });
  const agent = new ReActAgent(session, driver, handle);
  try {
    agent.prompt({ requestId: "r", content: [{ type: "text", text: "hello" }] });
    await agent.waitForIdle();
    const stream = followSession({ get: () => agent, onLoaded: () => () => {} }, async () => undefined, "s", new AbortController().signal);
    const first = await stream.next();
    assert.match(first.value ?? "", /"type":"assistant\/message"/);
    await stream.return(undefined);
    const observer = new SqliteSessionPersistence(path, { readOnly: true });
    try {
      const read = await observer.open("s", "read");
      const committed = await read?.read();
      assert.ok(committed?.some((event) => event.type === "request/header"));
      assert.equal(committed?.some((event) => event.type === "assistant/message"), false);
      await read?.close();
    } finally { await observer.close(); }
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const script = `
      const { SqliteSessionPersistence } = await import("@mharness/session/server");
      const storage = new SqliteSessionPersistence(process.argv[1], { readOnly: true });
      const handle = await storage.open("s", "read");
      process.stdout.write(JSON.stringify((await handle.read()).map((event) => event.type)));
      await handle.close();
      await storage.close();
    `;
    const child = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path]);
    const types: unknown = JSON.parse(child.stdout);
    assert.ok(Array.isArray(types));
    assert.ok(types.includes("request/header"));
    assert.equal(types.includes("assistant/message"), false);
    assert.equal(calls, 1);
  } finally {
    await agent.stop();
    await handle.close();
    await storage.close();
  }
  const reopened = await createEventSessionApp(path, false, driver);
  try {
    const history = (await reopened.inject({ method: "GET", url: "/api/sessions/s" })).json() as { records: { event: { type: string } }[] };
    assert.equal(history.records.some(({ event }) => event.type === "assistant/message"), false);
    assert.equal(history.records.at(-1)?.event.type, "turn/end");
    assert.equal(calls, 1);
  } finally {
    await reopened.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("模型结算追加失败后实时流发布 abandoned 而不引用事件", async () => {
  const { Session } = await import("@mharness/session/server");
  const { createModelTurnDriver } = await import("../agent/model-turn.ts");
  const { createMockAdapter } = await import("../model/providers/mock.ts");
  const { LlmRuntime } = await import("../model/runtime.ts");
  const session = new Session({ sessionId: "s", createdAt: 1 });
  session.bindCheckpoint(async () => {});
  const append = session.append.bind(session);
  session.append = (input) => {
    if (input.type === "assistant/message") throw new Error("append failed");
    return append(input);
  };
  const notices: import("../agent/model-turn.ts").ExecutionNotice[] = [];
  await createModelTurnDriver({
    runtime: new LlmRuntime({ mock: createMockAdapter(() => [
      { chunk: { type: "text", delta: "partial" } }, { chunk: { type: "finish", reason: { kind: "stop" } } },
    ]) }), config: () => ({ provider: "mock", model: "test" }), systemPrompt: () => "",
  })({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: (notice) => notices.push(notice), blockStorage: () => {} });
  assert.equal(notices.filter((notice) => notice.type === "assistant/start").length, 1);
  const ends = notices.filter((notice) => notice.type === "assistant/end");
  assert.equal(ends.length, 1);
  assert.ok(ends[0]?.type === "assistant/end");
  assert.deepEqual(ends[0].outcome, { kind: "abandoned" });
  assert.equal(session.snapshot().events.some((event) => event.type === "assistant/message"), false);
});

test("创建、历史和 follow 不加载 Agent", { timeout: 8000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-read-only-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const manager = new AgentManager(persistence, async () => {});
  const app = Fastify();
  registerSessionRoutes(app, "/api/sessions", persistence, new SessionCommandController(manager), manager, () => new SessionDirectory());
  const controller = new AbortController();
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const created = await app.inject({ method: "POST", url: "/api/sessions" });
    assert.equal(created.statusCode, 201);
    const { sessionId } = created.json() as { sessionId: string };
    assert.equal(manager.get(sessionId), undefined);
    assert.equal((await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` })).statusCode, 200);
    assert.equal(manager.get(sessionId), undefined);
    const response = await fetch(`${origin}/api/sessions/${sessionId}/follow`, { signal: controller.signal });
    assert.ok(response.body);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /"type":"snapshot"/);
    assert.equal(manager.get(sessionId), undefined);
    await reader.cancel();
  } finally {
    controller.abort();
    await app.close();
    await manager.close();
    await persistence.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const failSettlement of [false, true]) {
  test(`真实 SSE 发布 ${failSettlement ? "abandoned" : "committed"} 结算`, { timeout: 8000 }, async () => {
    const { followFrameSchema } = await import("@mharness/session/contracts");
    const { createModelTurnDriver } = await import("../agent/model-turn.ts");
    const { createMockAdapter } = await import("../model/providers/mock.ts");
    const { LlmRuntime } = await import("../model/runtime.ts");
    const dir = await mkdtemp(join(tmpdir(), "mharness-sse-settlement-"));
    const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
    const driver = createModelTurnDriver({
      runtime: new LlmRuntime({ mock: createMockAdapter(() => [
        { chunk: { type: "text", delta: "answer" } },
        { chunk: { type: "finish", reason: { kind: "stop" } } },
      ]) }),
      config: () => ({ provider: "mock", model: "test" }), systemPrompt: () => "",
    });
    const manager = new AgentManager(persistence, async (context) => {
      const append = context.session.append.bind(context.session);
      if (failSettlement) {
        context.session.append = (input) => {
          if (input.type === "assistant/message") throw new Error("settlement failure");
          return append(input);
        };
      }
      try { await driver(context); } finally { context.session.append = append; }
    });
    const app = Fastify();
    registerSessionRoutes(app, "/api/sessions", persistence, new SessionCommandController(manager), manager, () => new SessionDirectory());
    const controller = new AbortController();
    try {
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const created = await app.inject({ method: "POST", url: "/api/sessions" });
      const { sessionId } = created.json() as { sessionId: string };
      const response = await fetch(`${origin}/api/sessions/${sessionId}/follow`, { signal: controller.signal });
      assert.ok(response.body);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      const next = async () => {
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary >= 0) {
            const item = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (item.startsWith("data: ")) return followFrameSchema.parse(JSON.parse(item.slice(6)) as unknown);
            continue;
          }
          const chunk = await reader.read();
          if (chunk.done) throw new Error("SSE 提前关闭");
          buffer += chunk.value;
        }
      };
      assert.equal((await next()).type, "snapshot");
      const submitted = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: {
        requestId: "r", content: [{ type: "text", text: "hello" }],
      } });
      assert.equal(submitted.statusCode, 202);
      const frames = [];
      for (;;) {
        const frame = await next();
        frames.push(frame);
        if (frame.type === "event" && frame.event.type === "turn/end") break;
      }
      const starts = frames.filter((frame) => frame.type === "assistant-stream" && frame.frame.type === "start");
      const ends = frames.filter((frame) => frame.type === "assistant-stream" && frame.frame.type === "end");
      assert.equal(starts.length, 1);
      assert.equal(ends.length, 1);
      const end = ends[0];
      assert.ok(end?.type === "assistant-stream" && end.frame.type === "end");
      const settlementIndex = frames.findIndex((frame) => frame.type === "event" && frame.event.type === "assistant/message");
      if (failSettlement) {
        assert.deepEqual(end.frame.outcome, { kind: "abandoned" });
        assert.equal(settlementIndex, -1);
      } else {
        assert.ok(settlementIndex >= 0 && settlementIndex < frames.indexOf(end));
        const settlement = frames[settlementIndex];
        assert.ok(settlement?.type === "event" && settlement.event.type === "assistant/message");
        assert.deepEqual(end.frame.outcome, { kind: "committed", eventType: "assistant/message", seq: settlement.event.seq });
      }
      await reader.cancel();
    } finally {
      controller.abort();
      await app.close();
      await manager.close();
      await persistence.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

async function followReader(origin: string, url: string, signal: AbortSignal) {
  const { followFrameSchema } = await import("@mharness/session/contracts");
  const response = await fetch(`${origin}${url}/follow`, { signal });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return { reader, async next() {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const item = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (item.startsWith("data: ")) return followFrameSchema.parse(JSON.parse(item.slice(6)) as unknown);
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE 提前关闭");
      buffer += chunk.value;
    }
  } };
}

const compactSessionId = "manual";
const compactId = "34f5deaf-ba47-4d75-8724-f8a717c8ffb4";
const busyCompactId = "ffaa3758-5851-4e40-a47a-d03477d0a6fe";
const nextCompactId = "5db0b004-cbc8-4dfe-93b1-c2f7a155fb9f";
const compactUrl = `/api/sessions/${compactSessionId}`;

async function seedCompactHistory(path: string) {
  const storage = new SqliteSessionPersistence(path);
  const session = new Session({ sessionId: compactSessionId, createdAt: 1 });
  for (const [id, text] of [["old", "旧内容".repeat(2000)], ["tail", "保留尾部"]] as const) {
    session.append({ type: "user/message", surfaceOp: "append", data: {
      id, role: "user", source: { kind: "user" }, turn: 1, requestId: id, content: [{ type: "text", text }],
    } });
  }
  try {
    const handle = await storage.create(session.header);
    await handle.append(session.snapshot().events);
    await handle.close();
  } finally { await storage.close(); }
}

function configureCompactTransport(t: import("node:test").TestContext) {
  const oldProvider = process.env.MHARNESS_MODEL_PROVIDER;
  const oldKey = process.env.DEEPSEEK_API_KEY;
  process.env.MHARNESS_MODEL_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "test-manual-key";
  t.after(() => {
    if (oldProvider === undefined) delete process.env.MHARNESS_MODEL_PROVIDER; else process.env.MHARNESS_MODEL_PROVIDER = oldProvider;
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey;
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("同一会话按需加载并跨轮复用，关闭等待活动退出后释放写入权", { timeout: 12_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "session-lifecycle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  const load = t.mock.method(AgentManager.prototype, "load");
  const asking = deferred();
  const toolStarted = deferred();
  const toolCancelled = deferred();
  const releaseTool = deferred();
  const secondStarted = deferred();
  const secondCancelled = deferred();
  const releaseSecond = deferred();
  let approvalId: string | undefined;
  const approvals = new ApprovalService((asked) => {
    approvalId = asked.data.id;
    asking.resolve();
    return new Promise(() => {});
  });
  const registry = new ToolRegistry();
  const input = z.strictObject({});
  registry.register(defineLocalTool<typeof input, Promise<number>>({
    name: "write", version: "1", description: "write", input,
    sideEffect: "side-effect", approvalPolicy: "ask", cancellationGuarantee: "cooperative-exit", timeoutMs: 15_000,
    output: defineLocalToolOutput({ schema: z.number(), render: (_args, value) => [{ type: "text", text: String(value) }] }),
    async handler(_args, signal) {
      signal.addEventListener("abort", toolCancelled.resolve, { once: true });
      toolStarted.resolve();
      await releaseTool.promise;
      return 7;
    },
  }));
  const { createModelTurnDriver } = await import("../agent/model-turn.ts");
  const { createMockAdapter } = await import("../model/providers/mock.ts");
  const drive = createModelTurnDriver({
    runtime: new LlmRuntime({ mock: createMockAdapter(() => [
      { chunk: { type: "tool_call", index: 0, callId: "write", name: "write", argumentsDelta: "{}" } },
      { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
    ]) }),
    config: () => ({ provider: "mock", model: "m" }),
    systemPrompt: () => "",
    toolRegistry: registry,
    approvalService: approvals,
    async preStep({ turn, signal }) {
      if (turn !== 2) return;
      signal.addEventListener("abort", secondCancelled.resolve, { once: true });
      secondStarted.resolve();
      await releaseSecond.promise;
    },
  });
  const app = await createEventSessionApp(path, false, drive, { approvalService: approvals });
  const follow = new AbortController();
  let closing: Promise<unknown> | undefined;
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const created = await app.inject({ method: "POST", url: "/api/sessions" });
    assert.equal(created.statusCode, 201);
    const { sessionId } = created.json<{ sessionId: string }>();
    const url = `/api/sessions/${sessionId}`;
    const request = (requestId: string) => ({ requestId, content: [{ type: "text" as const, text: requestId }] });
    const prompt = (requestId: string) => app.inject({ method: "POST", url: `${url}/messages`, payload: request(requestId) });
    const cancel = () => app.inject({ method: "POST", url: `${url}/cancel` });
    const history = async () => rawSessionHistorySchema.parse((await app.inject({ method: "GET", url })).json()).records.map(({ event }) => event);

    assert.deepEqual(await history(), []);
    const subscription = await followReader(origin, url, follow.signal);
    assert.deepEqual(await subscription.next(), {
      type: "snapshot", sessionId, inheritedEventCount: 0, cursor: -1, records: [], assistantStream: { revision: 0 },
    });
    await subscription.reader.cancel();
    const unmounted = await cancel();
    assert.equal(unmounted.statusCode, 404);
    assert.deepEqual(unmounted.json(), { code: "session/not-found" });
    assert.equal(load.mock.callCount(), 0);

    const first = await prompt("first");
    assert.equal(first.statusCode, 202);
    assert.deepEqual(first.json(), { accepted: true });
    assert.equal(load.mock.callCount(), 1);
    const agent = await load.mock.calls[0]?.result;
    assert.ok(agent);
    await asking.promise;
    assert.ok(approvalId);
    const waiting = await prompt("while-approval");
    assert.equal(waiting.statusCode, 409);
    assert.deepEqual(waiting.json(), { code: "agent_busy" });
    const allowed = await app.inject({
      method: "POST", url: `${url}/approvals/${approvalId}/decision`, payload: { outcome: "allowed-once" },
    });
    assert.equal(allowed.statusCode, 200);
    await toolStarted.promise;
    const cancelled = await cancel();
    assert.equal(cancelled.statusCode, 202);
    assert.deepEqual(cancelled.json(), { accept: true });
    await toolCancelled.promise;
    const settling = await prompt("while-cancelling");
    assert.equal(settling.statusCode, 409);
    assert.deepEqual(settling.json(), { code: "agent_busy" });
    releaseTool.resolve();
    await agent.waitForIdle();
    const idle = await cancel();
    assert.equal(idle.statusCode, 202);
    assert.deepEqual(idle.json(), { accept: true });
    const firstHistory = agent.session.snapshot().events;

    const second = await prompt("second");
    assert.equal(second.statusCode, 202);
    assert.deepEqual(second.json(), { accepted: true });
    assert.equal(await load.mock.calls.at(-1)?.result, agent);
    await secondStarted.promise;
    assert.deepEqual(agent.session.snapshot().events.slice(0, firstHistory.length), firstHistory);

    const commands = app.getDecorator<SessionCommandController>("sessionCommands");
    let closed = false;
    closing = app.close().then(() => { closed = true; });
    void closing.catch(() => {});
    await secondCancelled.promise;
    await assert.rejects(commands.prompt({ sessionId, ...request("while-closing") }), { code: "agent_closed" });
    const storage = new SqliteSessionPersistence(path);
    try {
      await assert.rejects(storage.open(sessionId, "write"), { name: "OwnershipConflictError" });
      assert.equal(closed, false);
      releaseSecond.resolve();
      await closing;
      await assert.rejects(commands.cancel(sessionId), { code: "session/not-found" });
      const handle = await storage.open(sessionId, "write");
      assert.ok(handle);
      const events = await handle.read();
      assert.deepEqual(events, agent.session.snapshot().events);
      assert.deepEqual(events.slice(0, firstHistory.length), firstHistory);
      assert.deepEqual(events.flatMap((event) =>
        event.type === "user/message" && "requestId" in event.data ? [event.data.requestId] : []), ["first", "second"]);
      assert.deepEqual(events.filter((event) => event.type === "turn/end").map((event) => event.data), [
        { turn: 1, reason: { kind: "aborted", reason: "user" } },
        { turn: 2, reason: { kind: "aborted", reason: "user" } },
      ]);
      await handle.close();
    } finally { await storage.close(); }
  } finally {
    follow.abort();
    releaseTool.resolve();
    releaseSecond.resolve();
    await (closing ?? app.close());
  }
});

const compactProviderResponse = (content = "简短摘要") => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
);

for (const withPrefix of [true, false]) test(
  withPrefix ? "手动零预算只摘要末尾完整工具组之前的前缀" : "末尾工具组退到开头时手动压缩不调用摘要模型",
  async t => {
    const dir = await mkdtemp(join(tmpdir(), "mharness-compact-tool-tail-"));
    configureCompactTransport(t);
    const previousWindow = process.env.MHARNESS_MODEL_CONTEXT_WINDOW;
    process.env.MHARNESS_MODEL_CONTEXT_WINDOW = "100000";
    t.after(async () => {
      if (previousWindow === undefined) delete process.env.MHARNESS_MODEL_CONTEXT_WINDOW;
      else process.env.MHARNESS_MODEL_CONTEXT_WINDOW = previousWindow;
      await rm(dir, { recursive: true, force: true });
    });
    const path = join(dir, "events.sqlite");
    const seed = new Session({ sessionId: compactSessionId, createdAt: 1 });
    const oldText = "可压缩的旧历史".repeat(160);
    const prefix = withPrefix ? seed.append({ type: "user/message", surfaceOp: "append", data: {
      id: "old", role: "user", source: { kind: "user" }, turn: 1, requestId: "old", content: [{ type: "text", text: oldText }],
    } }) : undefined;
    const turn = 2, step = 1;
    const callIds = ["first", "second"];
    const oversizedResult = "x".repeat(8193);
    seed.append({ type: "turn/start", data: { turn } });
    seed.append({ type: "step/start", data: { turn, step } });
    seed.append({ type: "assistant/message", surfaceOp: "append", data: {
      turn, step, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true,
      message: { id: "tool-declaration", role: "assistant", source: { provider: "deepseek", model: "deepseek-v4-pro" },
        content: callIds.map(id => ({ type: "tool-call" as const, id, name: "read", arguments: "{}" })) },
    } });
    for (const callId of callIds) {
      const call = seed.append({ type: "tool/call", data: { turn, step, callId, name: "read", arguments: "{}" } });
      seed.append({ type: "tool/result", surfaceOp: "append", sourceEventSeqs: [call.seq], data: {
        turn, step, message: { id: `result-${callId}`, role: "user", source: { kind: "tool", callId },
          content: [{ type: "tool-result", toolCallId: callId, isError: false, content: [{ type: "text", text: callId === "first" ? oversizedResult : callId }] }] },
      } });
    }
    seed.append({ type: "step/end", data: { turn, step } });
    seed.append({ type: "turn/end", data: { turn, reason: { kind: "completed" } } });
    const events = seed.snapshot().events;
    const store = new SqliteSessionPersistence(path);
    try {
      const handle = await store.create(seed.header);
      try { await handle.append(events); } finally { await handle.close(); }
    } finally { await store.close(); }

    const requests: { messages: unknown[] }[] = [];
    const app = await createEventSessionApp(path, false, undefined, { modelFetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as { messages: unknown[] });
      return compactProviderResponse();
    } });
    try {
      const response = await app.inject({ method: "POST", url: `${compactUrl}/compact`, payload: { compactionId: compactId } });
      assert.equal(response.statusCode, 200);
      const result = compactResponseSchema.parse(response.json());
      const history = await app.inject({ method: "GET", url: compactUrl });
      assert.equal(history.statusCode, 200);
      const persisted = rawSessionHistorySchema.parse(history.json()).records.map(({ event }) => event);
      if (!prefix) {
        assert.equal(result.status, "no_safe_range");
        assert.equal(requests.length, 0);
        assert.deepEqual(persisted.slice(events.length).map(event => event.type), ["command/run", "command/done"]);
        return;
      }
      assert.equal(result.status, "succeeded");
      assert.deepEqual(requests.map(request => request.messages.slice(1)), [[{ role: "user", content: oldText }]]);
      assert.equal(persisted.some(event => event.type === "compaction/prune"), false);
      const summary = persisted.find(event => event.type === "compaction/summary");
      assert.ok(summary);
      assert.deepEqual(summary.data.shadowedSeqs, [prefix.seq]);
      const restored = new Session(seed.header, { seed: { kind: "restore", events: persisted, inheritedEventCount: 0 } });
      assert.deepEqual(restored.deriveSurfaceNodes().slice(1), seed.deriveSurfaceNodes().slice(1));
    } finally {
      await app.close();
    }
  },
);

test("生产压缩成功与忙碌拒绝按相同顺序持久化并交付两个 follow", { timeout: 12000 }, async t => {
  configureCompactTransport(t);
  const dir = await mkdtemp(join(tmpdir(), "mharness-compact-live-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  await seedCompactHistory(path);
  const entered = deferred();
  const release = deferred();
  const busyEntered = deferred();
  const abort = new AbortController();
  const leftConnection = new AbortController();
  const bodies: unknown[] = [];
  const recordBusy = ReActAgent.prototype.recordBusyCommand;
  t.mock.method(ReActAgent.prototype, "recordBusyCommand", function (this: ReActAgent, ...args: Parameters<typeof recordBusy>) {
    const pending = recordBusy.apply(this, args);
    busyEntered.resolve();
    return pending;
  });
  const app = await createEventSessionApp(path, false, undefined, { modelFetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as unknown);
    if (bodies.length === 1) {
      entered.resolve();
      await release.promise;
      return compactProviderResponse("第一段较长的历史摘要。".repeat(12));
    }
    return compactProviderResponse();
  } });
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const [left, right] = await Promise.all([followReader(origin, compactUrl, leftConnection.signal), followReader(origin, compactUrl, abort.signal)]);
    const initial = await left.next();
    assert.equal(initial.type, "snapshot");
    assert.deepEqual(await right.next(), initial);
    const post = (compactionId: string) => app.inject({ method: "POST", url: `${compactUrl}/compact`, payload: { compactionId } });
    const current = post(compactId).then(response => response);
    await entered.promise;
    const pendingBusy = post(busyCompactId).then(response => response);
    await busyEntered.promise;
    const during = rawSessionHistorySchema.parse((await app.inject({ method: "GET", url: compactUrl })).json()).records;
    assert.deepEqual(during.slice(2).map(record => record.event.type), ["command/run", "compaction/start"]);
    release.resolve();
    const [done, busy] = await Promise.all([current, pendingBusy]);
    assert.equal(done.statusCode, 200);
    assert.equal(busy.statusCode, 409);
    const result = compactResponseSchema.parse(done.json());
    const rejected = busy.json<{ commandId: string; result: { kind: string; text: string } }>();
    assert.equal(result.compactionId, compactId);
    assert.equal(result.status, "succeeded");
    assert.notEqual(result.commandId, rejected.commandId);
    assert.equal(rejected.result.kind, "error");
    assert.equal(bodies.length, 1);
    assert.match(JSON.stringify(bodies[0]), /"thinking":\{"type":"disabled"\}/);
    assert.doesNotMatch(JSON.stringify(bodies[0]), /保留尾部/);
    const history = rawSessionHistorySchema.parse((await app.inject({ method: "GET", url: compactUrl })).json());
    const events = history.records.slice(2);
    assert.deepEqual(events.map(record => record.event.type), ["command/run", "compaction/start", "compaction/summary", "user/message", "compaction/end", "command/done", "command/run", "command/done"]);
    const [run, start, summary, checkpoint, end, complete, rejectedRun, rejectedDone] = events.map(record => record.event);
    assert.ok(run?.type === "command/run" && start?.type === "compaction/start" && summary?.type === "compaction/summary" &&
      checkpoint?.type === "user/message" && end?.type === "compaction/end" && complete?.type === "command/done" &&
      rejectedRun?.type === "command/run" && rejectedDone?.type === "command/done");
    assert.equal(run.data.commandId, result.commandId);
    assert.deepEqual(start.data, { compactionId: compactId, turn: null, sourceCommandId: result.commandId });
    assert.equal(summary.data.sourceCommandId, result.commandId);
    assert.ok("sourceCommandId" in checkpoint.data && checkpoint.data.sourceCommandId === result.commandId);
    assert.equal(end.data.sourceCommandId, result.commandId);
    assert.deepEqual(complete.data, { commandId: result.commandId, kind: "success", sourceEventSeq: summary.seq });
    assert.equal(rejectedRun.data.commandId, rejected.commandId);
    assert.deepEqual(rejectedDone.data, { commandId: rejected.commandId, ...rejected.result });
    for (const record of events) {
      assert.deepEqual(await left.next(), record);
      assert.deepEqual(await right.next(), record);
    }
    leftConnection.abort();
    const reconnect = await followReader(origin, compactUrl, abort.signal);
    const replay = await reconnect.next();
    assert.ok(replay.type === "snapshot");
    assert.deepEqual(replay.records, history.records);
    assert.equal(replay.cursor, history.cursor);
    const duplicate = await post(compactId);
    assert.equal(duplicate.statusCode, 409);
    assert.deepEqual(duplicate.json(), { code: "compaction_id_conflict" });
    assert.equal(bodies.length, 1);
    const second = await post(nextCompactId);
    assert.equal(second.statusCode, 200);
    const nextResult = compactResponseSchema.parse(second.json());
    assert.equal(nextResult.status, "succeeded");
    assert.notEqual(nextResult.commandId, result.commandId);
    assert.notEqual(nextResult.commandId, rejected.commandId);
    const finalHistory = rawSessionHistorySchema.parse((await app.inject({ method: "GET", url: compactUrl })).json());
    assert.deepEqual(finalHistory.records.slice(0, history.records.length), history.records);
    const nextRecords = finalHistory.records.slice(history.records.length);
    assert.deepEqual(nextRecords.map(record => record.event.type), ["command/run", "compaction/start", "compaction/summary", "user/message", "compaction/end", "command/done"]);
    for (const record of nextRecords) {
      assert.deepEqual(await reconnect.next(), record);
      assert.deepEqual(await right.next(), record);
    }
    assert.equal(bodies.length, 2);
  } finally {
    release.resolve();
    leftConnection.abort();
    abort.abort();
    const closing = app.close();
    app.server.closeAllConnections();
    await closing;
  }
});

test("生产压缩完成后可从共享日志恢复丢失的 HTTP 响应", { timeout: 12000 }, async t => {
  configureCompactTransport(t);
  const dir = await mkdtemp(join(tmpdir(), "mharness-compact-disconnect-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  await seedCompactHistory(path);
  const entered = deferred();
  const release = deferred();
  const requester = new AbortController();
  const observation = new AbortController();
  let calls = 0;
  const app = await createEventSessionApp(path, false, undefined, { modelFetch: async (_url, init) => {
    calls++;
    entered.resolve();
    await release.promise;
    assert.equal(init?.signal?.aborted, false);
    return compactProviderResponse();
  } });
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const follower = await followReader(origin, compactUrl, observation.signal);
    assert.equal((await follower.next()).type, "snapshot");
    const request = fetch(`${origin}${compactUrl}/compact`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ compactionId: compactId }), signal: requester.signal,
    });
    const lost = assert.rejects(request, { name: "AbortError" });
    await entered.promise;
    requester.abort();
    await lost;
    release.resolve();
    for (;;) {
      const frame = await follower.next();
      assert.equal(frame.type, "event");
      if (frame.type === "event" && frame.event.type === "command/done") {
        assert.equal(frame.event.data.kind, "success");
        break;
      }
    }
    const history = rawSessionHistorySchema.parse((await app.inject({ method: "GET", url: compactUrl })).json());
    const reconnected = await followReader(origin, compactUrl, observation.signal);
    const replay = await reconnected.next();
    assert.ok(replay.type === "snapshot");
    assert.deepEqual(replay.records, history.records);
    assert.equal(history.records.filter(record => record.event.type === "compaction/end").length, 1);
    assert.equal(calls, 1);
  } finally {
    release.resolve();
    requester.abort();
    observation.abort();
    const closing = app.close();
    app.server.closeAllConnections();
    await closing;
  }
});

test("关闭应用先取消仍在等待 Provider 的生产压缩请求", { timeout: 10000 }, async t => {
  configureCompactTransport(t);
  const dir = await mkdtemp(join(tmpdir(), "mharness-compact-close-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  await seedCompactHistory(path);
  const entered = deferred();
  const abortObserved = deferred();
  const release = deferred();
  const app = await createEventSessionApp(path, false, undefined, { modelFetch: async (_url, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    signal.addEventListener("abort", abortObserved.resolve, { once: true });
    entered.resolve();
    await Promise.race([abortObserved.promise, release.promise]);
    signal.throwIfAborted();
    return compactProviderResponse();
  } });
  let closing: Promise<unknown> | undefined;
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const request = fetch(`${origin}${compactUrl}/compact`, {
      method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify({ compactionId: compactId }),
    }).then(async response => ({ status: response.status, body: await response.json() }));
    await entered.promise;
    closing = app.close();
    const { setTimeout } = await import("node:timers/promises");
    assert.equal(await Promise.race([abortObserved.promise.then(() => true), setTimeout(750, false, { ref: false })]), true);
    const result = await request;
    assert.equal(result.status, 200);
    assert.equal(compactResponseSchema.parse(result.body).status, "cancelled");
    await closing;
  } finally {
    release.resolve();
    await (closing ?? app.close());
  }
});

for (const scenario of ["cancel", "failed", "input-overflow", "unknown"] as const) test(`生产压缩在 ${scenario} 时准确交接 HTTP 与持久记录`, { timeout: 12000 }, async t => {
  configureCompactTransport(t);
  const dir = await mkdtemp(join(tmpdir(), "mharness-compact-outcome-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  await seedCompactHistory(path);
  let calls = 0;
  const entered = deferred();
  const release = deferred();
  const app = await createEventSessionApp(path, false, undefined, { modelFetch: async (_url, init) => {
    calls++;
    entered.resolve();
    if (scenario === "cancel") {
      const signal = init?.signal;
      assert.ok(signal);
      await Promise.race([release.promise, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]);
      signal.throwIfAborted();
    }
    if (scenario === "failed") return new Response("private failure", { status: 502 });
    if (scenario === "input-overflow") {
      return new Response(JSON.stringify({ error: { code: "context_length_exceeded" } }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
    return compactProviderResponse();
  } });
  let live: ReActAgent | undefined;
  const settle = ReActAgent.prototype.settleCompaction;
  t.mock.method(ReActAgent.prototype, "settleCompaction", function (this: ReActAgent, ...args: Parameters<ReActAgent["settleCompaction"]>) {
    live = this;
    return settle.apply(this, args);
  });
  const fault = scenario === "unknown" ? injectCompactionSqliteFault(t, { path, sessionId: compactSessionId, compactionId: compactId, kind: "success", firstSeq: 4, mode: "committed" }) : undefined;
  const read = async () => rawSessionHistorySchema.parse((await app.inject({ method: "GET", url: compactUrl })).json()).records.map(record => record.event);
  try {
    const post = app.inject({ method: "POST", url: `${compactUrl}/compact`, payload: { compactionId: compactId } }).then(response => response);
    await entered.promise;
    if (scenario === "cancel") assert.equal((await app.inject({ method: "POST", url: `${compactUrl}/cancel` })).statusCode, 202);
    const response = await post;
    const before = await read();
    if (scenario !== "unknown") {
      const outcome = scenario === "cancel" ? "cancelled" : "failed";
      assert.equal(response.statusCode, 200);
      assert.equal(compactResponseSchema.parse(response.json()).status, outcome);
      assert.deepEqual(before.slice(2).map(e => e.type), ["command/run", "compaction/start", "compaction/end", "command/done"]);
      const end = before.at(-2);
      assert.ok(end?.type === "compaction/end" && end.data.status === outcome);
      if (scenario === "input-overflow") {
        const done = before.at(-1);
        assert.ok(done?.type === "command/done" && done.data.kind === "error");
      }
      assert.doesNotMatch(JSON.stringify(before), /private failure|context_length_exceeded/);
    } else {
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { code: "storage_blocked" });
      assert.equal(before.some(event => event.type === "command/done"), false);
      assert.ok(fault && live);
      assert.equal(live.storageOpen, false);
      fault.release();
      await live.recoverStorage();
      const after = await read();
      const summary = after.find(event => event.type === "compaction/summary");
      const command = after.find(event => event.type === "command/run");
      assert.ok(summary && command);
      assert.deepEqual(after.slice(before.length).map(event => event.data), [{ commandId: command.data.commandId, kind: "success", sourceEventSeq: summary.seq }]);
      await live.recoverStorage();
      assert.deepEqual(await read(), after);
    }
    assert.equal(calls, 1);
  } finally {
    release.resolve();
    fault?.restore();
    await app.close();
  }
});

for (const phase of ["prepare", "adapter"] as const) test(`手动压缩 ${phase} 原错不被命令终态写入错误覆盖`, async t => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-compact-original-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  await seedCompactHistory(path);
  const store = new SqliteSessionPersistence(path);
  const manager = new AgentManager(store, async () => assert.fail("手动压缩不运行 Turn"));
  const original = phase === "prepare" ? new Error("原始准备错误") : undefined;
  const storage = new Error("命令终态写入失败");
  let calls = 0;
  const runtime = new LlmRuntime({ mock: { async *generate(): AsyncGenerator<never> { calls++; throw original; } } });
  const commands = new SessionCommandController(manager, () => {
    if (phase === "prepare") throw original;
    return { runtime, businessModel: runtime.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 };
  });
  try {
    const agent = await manager.load(compactSessionId);
    const append = agent.session.append.bind(agent.session);
    const failure = t.mock.method(agent.session, "append", (...args: Parameters<typeof append>) => {
      if (args[0].type === "command/done") throw storage;
      return append(...args);
    });
    assert.ok(commands.compact);
    const result = await commands.compact({ sessionId: compactSessionId, compactionId: compactId }).then(
      value => ({ resolved: true, value }),
      (error: unknown) => ({ resolved: false, error }),
    );
    assert.deepEqual(result, { resolved: false, error: original });
    assert.equal(agent.storageOpen, false);
    assert.equal(agent.session.snapshot().events.some(event => event.type === "command/done"), false);
    assert.equal(calls, phase === "prepare" ? 0 : 1);
    failure.mock.restore();
    await agent.recoverStorage();
    const final = agent.session.snapshot().events.at(-1);
    assert.ok(final?.type === "command/done" && final.data.kind === "error");
    assert.equal(calls, phase === "prepare" ? 0 : 1);
  } finally {
    try { await manager.close(); } finally { await store.close(); }
  }
});

test("真实启动应用的 fork 历史和 follow 保留原事件，继承编号可在子会话新受理", { timeout: 8000 }, async () => {
  const { rawSessionHistorySchema } = await import("@mharness/session/contracts");
  const { Session } = await import("@mharness/session/server");
  const { createEventSessionApp } = await import("../app.ts");
  const { createModelTurnDriver } = await import("../agent/model-turn.ts");
  const { createMockAdapter } = await import("../model/providers/mock.ts");
  const { LlmRuntime } = await import("../model/runtime.ts");
  const dir = await mkdtemp(join(tmpdir(), "mharness-fork-http-"));
  const path = join(dir, "events.sqlite");
  const seedStorage = new SqliteSessionPersistence(path);
  const parent = new Session({ sessionId: "parent", createdAt: 1 });
  parent.append({ type: "turn/start", data: { turn: 1 } });
  parent.append({ type: "step/start", data: { turn: 1, step: 1 } });
  parent.append({ type: "user/message", surfaceOp: "append", data: {
    turn: 1, role: "user", source: { kind: "user" }, id: "parent-user", requestId: "shared", content: [{ type: "text", text: "父消息" }],
  } });
  parent.append({ type: "request/header", data: { reason: "initial", header: { config: { provider: "mock", model: "test" }, system: "sys", tools: [] } } });
  parent.append({ type: "assistant/message", surfaceOp: "append", data: {
    turn: 1, step: 1, message: { id: "parent-assistant", role: "assistant", source: { provider: "mock", model: "test" }, content: [{ type: "text", text: "父回答" }] },
    finishReason: { kind: "stop" }, stream: [], includeInModelContext: true,
  } });
  parent.append({ type: "step/end", data: { turn: 1, step: 1 } });
  parent.append({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  const seed = parent.snapshot().events;
  const calls: Array<{ role: string; text: string }[]> = [];
  const driver = createModelTurnDriver({
    runtime: new LlmRuntime({ mock: createMockAdapter((request) => {
      calls.push(request.messages.map(({ role, text }) => ({ role, text })));
      return [{ chunk: { type: "text", delta: "子回答" } }, { chunk: { type: "finish", reason: { kind: "stop" } } }];
    }) }),
    config: () => ({ provider: "mock", model: "test" }), systemPrompt: () => "sys",
  });
  const controller = new AbortController();
  let app: Awaited<ReturnType<typeof createEventSessionApp>> | undefined;
  try {
    const handle = await seedStorage.create(parent.header);
    await handle.append(seed);
    await handle.close();
    await seedStorage.close();
    app = await createEventSessionApp(path, false, driver);
    assert.throws(() => app!.getDecorator("sessionCommands"), /会话恢复尚未完成/);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const commands = app.getDecorator<SessionCommandController>("sessionCommands");
    const { sessionId } = await commands.fork({ sessionId: "parent", atSeq: 2 });
    assert.equal(calls.length, 0);
    const directory = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
    assert.equal(directory.revision, 1);
    const child = directory.sessions.find((item: { sessionId: string }) => item.sessionId === sessionId);
    assert.equal(child.parentSessionId, "parent");
    assert.equal(child.blank, false);
    assert.equal(child.updatedAt, Math.max(child.createdAt, seed[2].time));
    const url = `/api/sessions/${sessionId}`;
    const get = await app.inject({ method: "GET", url });
    assert.equal(get.statusCode, 200);
    const initial = rawSessionHistorySchema.parse(get.json());
    assert.equal(initial.inheritedEventCount, seed.length);
    assert.deepEqual(initial.records.slice(0, seed.length).map(({ event }) => event), seed);
    assert.equal(initial.records.at(-1)?.event.type, "session/end-seed");
    assert.equal(initial.cursor, seed.length);
    const { reader, next } = await followReader(origin, url, controller.signal);
    const snapshot = await next();
    assert.ok(snapshot.type === "snapshot");
    assert.deepEqual(snapshot.records, initial.records);
    assert.equal(snapshot.inheritedEventCount, initial.inheritedEventCount);
    assert.equal(snapshot.cursor, initial.cursor);
    const submit = (text: string) => app!.inject({ method: "POST", url: `${url}/messages`, payload: {
      requestId: "shared", content: [{ type: "text", text }],
    } });
    assert.deepEqual((await submit("子消息")).json(), { accepted: true });
    assert.deepEqual((await submit("重发内容")).json(), { accepted: true });
    const own = [];
    for (;;) {
      const frame = await next();
      assert.notEqual(frame.type, "error");
      if (frame.type !== "event") continue;
      assert.equal(frame.event.seq, initial.cursor + own.length + 1);
      own.push(frame);
      if (frame.event.type === "turn/end") break;
    }
    assert.deepEqual(own[0].event.data, { turn: 2 });
    assert.deepEqual(own.flatMap(({ event }) => event.type === "request/header" ? [event.data.reason] : []), ["resume"]);
    assert.deepEqual(calls, [[{ role: "user", text: "父消息" }, { role: "assistant", text: "父回答" }, { role: "user", text: "子消息" }]]);
    await reader.cancel();
    await app.close();
    app = await createEventSessionApp(path, false, driver);
    const restored = rawSessionHistorySchema.parse((await app.inject({ method: "GET", url })).json());
    assert.deepEqual(restored.records, [...initial.records, ...own]);
    assert.deepEqual((await submit("重开后重发")).json(), { accepted: true });
    assert.equal(calls.length, 1);
  } finally {
    controller.abort();
    await app?.close();
    await seedStorage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP 受理不等待首步，重发去重且新请求保持忙碌", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-prestep-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const manager = new AgentManager(persistence, async ({ session, turn, step }) => {
    entered(); await gate;
    session.append({ type: "step/start", data: { turn, step } });
    session.append({ type: "step/end", data: { turn, step } });
    session.append({ type: "turn/end", data: { turn, reason: { kind: "completed" } } });
  });
  const app = Fastify();
  registerSessionRoutes(app, "/api/sessions", persistence, new SessionCommandController(manager), manager, () => new SessionDirectory());
  try {
    const handle = await persistence.create({ sessionId: "s", createdAt: 1 }); await handle.flush(); await handle.close();
    const post = (requestId: string, text: string) => app.inject({ method: "POST", url: "/api/sessions/s/messages", payload: { requestId, content: [{ type: "text", text }] } });
    const response = await post("r", "原文"); assert.equal(response.statusCode, 202); assert.deepEqual(response.json(), { accepted: true });
    await waiting;
    const agent = manager.get("s"); assert.ok(agent);
    assert.deepEqual(agent.session.snapshot().events.map((event) => event.type), ["turn/start", "user/message"]);
    assert.equal((await post("r", "重发")).statusCode, 202);
    const busy = await post("next", "新文"); assert.equal(busy.statusCode, 409); assert.deepEqual(busy.json(), { code: "agent_busy" });
    assert.equal(agent.session.snapshot().events.filter((event) => event.type === "user/message").length, 1);
    release(); await agent.waitForIdle();
  } finally { release(); await app.close(); await manager.close(); await persistence.close(); await rm(dir, { recursive: true, force: true }); }
});

test("真实 SSE 在 pre-step 等待时交付受理前缀并在开步后发布业务流", { timeout: 8000 }, async () => {
  const { followFrameSchema } = await import("@mharness/session/contracts");
  const { createModelTurnDriver } = await import("../agent/model-turn.ts");
  const { createMockAdapter } = await import("../model/providers/mock.ts");
  const { LlmRuntime } = await import("../model/runtime.ts");
  const dir = await mkdtemp(join(tmpdir(), "mharness-sse-gate-")); const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  let release!: () => void; let entered!: () => void; let calls = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; }); const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const driver = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { calls++; return [{ chunk: { type: "text", delta: "答" } }, { chunk: { type: "finish", reason: { kind: "stop" } } }]; }) }),
    config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", preStep: async () => { entered(); await gate; } });
  const manager = new AgentManager(persistence, driver); const app = Fastify();
  registerSessionRoutes(app, "/api/sessions", persistence, new SessionCommandController(manager), manager, () => new SessionDirectory());
  const controller = new AbortController();
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const created = await app.inject({ method: "POST", url: "/api/sessions" }); const { sessionId } = created.json() as { sessionId: string };
    const connect = async () => {
      const response = await fetch(`${origin}/api/sessions/${sessionId}/follow`, { signal: controller.signal }); assert.ok(response.body);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader(); let buffer = "";
      return { reader, next: async () => { for (;;) { const boundary = buffer.indexOf("\n\n"); if (boundary >= 0) { const item = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); if (item.startsWith("data: ")) return followFrameSchema.parse(JSON.parse(item.slice(6)) as unknown); continue; } const chunk = await reader.read(); if (chunk.done) throw new Error("SSE 提前关闭"); buffer += chunk.value; } } };
    };
    const first = await connect(); assert.equal((await first.next()).type, "snapshot");
    assert.equal((await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { requestId: "r", content: [{ type: "text", text: "你好" }] } })).statusCode, 202);
    await waiting;
    const one = await first.next(); const two = await first.next();
    assert.ok(one.type === "event" && one.event.type === "turn/start" && one.event.seq === 0);
    assert.ok(two.type === "event" && two.event.type === "user/message" && two.event.seq === 1); assert.equal(calls, 0);
    const second = await connect(); const snapshot = await second.next();
    assert.ok(snapshot.type === "snapshot" && snapshot.cursor === 1 && !snapshot.assistantStream.activeAttempt);
    assert.deepEqual(snapshot.records.map((record) => record.event.type), ["turn/start", "user/message"]);
    release(); const frames = []; for (;;) { const frame = await first.next(); frames.push(frame); if (frame.type === "assistant-stream" && frame.frame.type === "start") break; }
    assert.deepEqual(frames.map((frame) => frame.type === "event" ? frame.event.type : frame.type), ["step/start", "request/header", "assistant-stream"]);
    assert.equal(calls, 1); await first.reader.cancel(); await second.reader.cancel();
    const agent = manager.get(sessionId); assert.ok(agent); await agent.waitForIdle();
  } finally { release(); controller.abort(); await app.close(); await manager.close(); await persistence.close(); await rm(dir, { recursive: true, force: true }); }
});

test("目录 GET 读取已提交清单并传播读取失败", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-list-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const app = Fastify();
  t.after(async () => { await app.close(); await persistence.close(); await rm(dir, { recursive: true, force: true }); });
  const handle = await persistence.create({ sessionId: "cold", createdAt: 10 });
  await handle.flush(); await handle.close();
  registerSessionRoutes(app, "/api/sessions", persistence, { prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }) },
    { get: () => undefined, onLoaded: () => () => {} }, () => new SessionDirectory());
  const response = await app.inject({ method: "GET", url: "/api/sessions" });
  assert.deepEqual(response.json(), { revision: 0, sessions: [{ sessionId: "cold", createdAt: 10, updatedAt: 10, running: false, blank: false }] });
  t.mock.method(persistence, "list", async () => { throw new Error("list fault"); });
  assert.equal((await app.inject({ method: "GET", url: "/api/sessions" })).statusCode, 500);
});

test("目录 GET 对同 ID 身份冲突采用已提交的冷摘要", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-identity-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const app = Fastify();
  t.after(async () => { await app.close(); await persistence.close(); await rm(dir, { recursive: true, force: true }); });
  persistence.upgradeDirectoryMetadata();
  const header = { sessionId: "same", createdAt: 10 };
  const handle = await persistence.create(header);
  await handle.flush();
  await handle.close();

  const online = new Session({ ...header, createdAt: 20 });
  online.append({ type: "turn/start", time: 21, data: { turn: 1 } });
  const agent = new ReActAgent(online, async () => {}, handle);
  t.mock.getter(agent, "state", () => "running");
  const diagnostic = t.mock.method(console, "error", () => {});
  const directory = new SessionDirectory();
  registerSessionRoutes(app, "/api/sessions", persistence,
    { prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }) },
    { get: () => agent, onLoaded: () => () => {} }, () => directory);

  const response = await app.inject({ method: "GET", url: "/api/sessions" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { revision: 0, sessions: [{ ...header, updatedAt: 10, running: false, blank: true }] });
  assert.equal(diagnostic.mock.calls.length, 1);
});

test("已提交但未发布 Agent 的分支由目录 GET 补齐且不推进版本", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-unpublished-fork-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const manager = new AgentManager(persistence, async () => {});
  const directory = new SessionDirectory();
  const app = Fastify();
  let committed!: () => void;
  let releasePublication!: () => void;
  const reached = new Promise<void>((resolve) => { committed = resolve; });
  const gate = new Promise<void>((resolve) => { releasePublication = resolve; });
  t.after(async () => {
    releasePublication();
    await app.close(); await manager.close(); await persistence.close(); await rm(dir, { recursive: true, force: true });
  });
  manager.onSessionCreated((session) => directory.register(session));
  const create = persistence.create.bind(persistence);
  t.mock.method(persistence, "create", async (...args: Parameters<typeof create>) => {
    const handle = await create(...args);
    const append = handle.append.bind(handle);
    t.mock.method(handle, "append", async (...batch: Parameters<typeof append>) => {
      await append(...batch);
      committed();
      await gate;
    });
    return handle;
  });
  const load = t.mock.method(manager, "load", async () => { throw new Error("目录查询不应加载 Agent"); });
  registerSessionRoutes(app, "/api/sessions", persistence, new SessionCommandController(manager), manager, () => directory);
  const header = { sessionId: "child", createdAt: 42, isSeeded: true, parentSession: "parent" } as const;
  const fork = manager.initializeFork(header, async () => []);
  try {
    await Promise.race([reached, fork.then(() => { throw new Error("未拦截分支发布"); })]);
    assert.equal(manager.get(header.sessionId), undefined);
    const response = await app.inject({ method: "GET", url: "/api/sessions" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { revision: 0, sessions: [
      { sessionId: "child", createdAt: 42, updatedAt: 42, running: false, blank: false, parentSessionId: "parent" },
    ] });
    assert.equal(manager.get(header.sessionId), undefined);
    assert.equal(load.mock.calls.length, 0);
    assert.equal(directory.snapshot().revision, 0);
  } finally {
    releasePublication();
    await fork;
  }
  assert.ok(manager.get(header.sessionId));
  assert.equal(directory.snapshot().revision, 1);
});

test("并发创建确认后，旧清单请求重读并覆盖注册版本", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-handoff-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const app = Fastify();
  t.after(async () => { await app.close(); await persistence.close(); await rm(dir, { recursive: true, force: true }); });
  const directory = new SessionDirectory();
  const list = persistence.list.bind(persistence);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  t.mock.method(persistence, "list", async () => {
    const result = await list();
    if (++calls === 1) { entered(); await gate; }
    return result;
  });
  registerSessionRoutes(app, "/api/sessions", persistence, { prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }) },
    { get: () => undefined, onLoaded: () => () => {} }, () => directory);
  const first = app.inject({ method: "GET", url: "/api/sessions" });
  await reached;
  const created = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
  assert.equal(created.statusCode, 201);
  release();
  const snapshot = (await first).json();
  assert.equal(calls, 2);
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].sessionId, created.json().sessionId);
});

test("未知创建结果由后台核实并撤回，无需历史请求", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-verify-background-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const app = Fastify();
  t.after(async () => { await app.close(); await persistence.close(); await rm(dir, { recursive: true, force: true }); });
  const create = persistence.create.bind(persistence);
  t.mock.method(persistence, "create", async (header: Parameters<typeof create>[0]) => {
    const handle = await create(header);
    t.mock.method(handle, "flush", async () => { throw new Error("flush fault"); });
    handle.creationVerifier = () => verify;
    return handle;
  });
  let calls = 0;
  const verify = async (): Promise<"failed" | "unknown"> => ++calls === 1 ? "unknown" : "failed";
  const directory = new SessionDirectory();
  registerSessionRoutes(app, "/api/sessions", persistence, { prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }) },
    { get: () => undefined, onLoaded: () => () => {} }, () => directory);
  const response = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
  assert.equal(response.statusCode, 503);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(directory.snapshot(), { revision: 2, sessions: [] });
});

test("缺少目录依赖时路由装配失败", () => {
  const app = Fastify();
  assert.throws(() => registerSessionRoutes(app, "/api/sessions", {} as SessionPersistence,
    { prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }) },
    { get: () => undefined, onLoaded: () => () => {} }, undefined as unknown as () => SessionDirectory), /目录/);
});

test("应用关闭后迟到的创建核实结果不会改变目录", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-verify-close-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const app = Fastify();
  t.after(async () => { await app.close(); await persistence.close(); await rm(dir, { recursive: true, force: true }); });
  const create = persistence.create.bind(persistence);
  t.mock.method(persistence, "create", async (header: Parameters<typeof create>[0]) => {
    const handle = await create(header);
    t.mock.method(handle, "flush", async () => { throw new Error("flush fault"); });
    handle.creationVerifier = () => verify;
    return handle;
  });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const verify = async (): Promise<"failed" | "unknown"> => {
    if (++calls === 1) return "unknown";
    if (calls === 2) { entered(); await gate; }
    return "failed";
  };
  const directory = new SessionDirectory();
  registerSessionRoutes(app, "/api/sessions", persistence, { prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }) },
    { get: () => undefined, onLoaded: () => () => {} }, () => directory);
  assert.equal((await app.inject({ method: "POST", url: "/api/sessions", payload: {} })).statusCode, 503);
  await reached;
  await app.close();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(directory.snapshot().revision, 1);
  assert.equal(directory.snapshot().sessions.length, 1);
});

test("提交前开始的历史缺失结果迟到时不撤回待核实项", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-delayed-history-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const app = Fastify();
  t.after(async () => { await app.close(); await persistence.close(); await rm(dir, { recursive: true, force: true }); });
  const create = persistence.create.bind(persistence);
  let id = "";
  let prepared!: () => void;
  let resume!: () => void;
  const ready = new Promise<void>((resolve) => { prepared = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  t.mock.method(persistence, "create", async (header: Parameters<typeof create>[0]) => {
    id = header.sessionId;
    const handle = await create(header);
    t.mock.method(handle, "flush", async () => { prepared(); await gate; throw new Error("flush fault"); });
    handle.creationVerifier = () => async () => "unknown";
    return handle;
  });
  let releaseRead!: () => void;
  let readEntered!: () => void;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const readReady = new Promise<void>((resolve) => { readEntered = resolve; });
  const open = persistence.open.bind(persistence);
  t.mock.method(persistence, "open", async (...args: Parameters<typeof open>) => {
    const result = await open(...args);
    readEntered(); await readGate;
    return result;
  });
  const directory = new SessionDirectory();
  registerSessionRoutes(app, "/api/sessions", persistence, { prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }) },
    { get: () => undefined, onLoaded: () => () => {} }, () => directory);
  const post = app.inject({ method: "POST", url: "/api/sessions", payload: {} });
  await ready;
  const history = app.inject({ method: "GET", url: `/api/sessions/${id}` });
  await readReady;
  resume();
  assert.equal((await post).statusCode, 503);
  releaseRead();
  assert.equal((await history).statusCode, 404);
  assert.equal(directory.snapshot().revision, 1);
  assert.equal(directory.snapshot().sessions.length, 1);
});

test("创建控制器合并同一意图并拒绝同标识不同身份", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-create-controller-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  t.after(async () => { await persistence.close(); await rm(dir, { recursive: true, force: true }); });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  let creates = 0;
  const create = persistence.create.bind(persistence);
  t.mock.method(persistence, "create", async (...args: Parameters<typeof create>) => {
    creates++;
    const handle = await create(...args);
    const flush = handle.flush.bind(handle);
    t.mock.method(handle, "flush", async () => { entered(); await gate; await flush(); });
    return handle;
  });
  const { SessionCreationController } = await import("../commands.ts");
  const directory = new SessionDirectory();
  const controller = new SessionCreationController(persistence, () => directory);
  const header = { sessionId: "same", createdAt: 1 };
  const first = controller.create(header);
  await reached;
  const second = controller.create(header);
  assert.equal((await controller.create({ ...header, createdAt: 2 })).status, "conflict");
  release();
  assert.equal((await first).status, "committed");
  assert.equal((await second).status, "committed");
  assert.equal(creates, 1);
  assert.equal(directory.snapshot().revision, 1);
  controller.close();
});

test("未知创建重复调用共享结果与核实任务，失败后允许重试", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-create-retry-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  t.after(async () => { await persistence.close(); await rm(dir, { recursive: true, force: true }); });
  const create = persistence.create.bind(persistence);
  let creates = 0;
  let checks = 0;
  t.mock.method(persistence, "create", async (...args: Parameters<typeof create>) => {
    creates++;
    const handle = await create(...args);
    if (creates === 1) {
      t.mock.method(handle, "flush", async () => { throw new Error("flush fault"); });
      handle.creationVerifier = () => async () => ++checks === 1 ? "unknown" : "failed";
    }
    return handle;
  });
  const { SessionCreationController } = await import("../commands.ts");
  const directory = new SessionDirectory();
  const controller = new SessionCreationController(persistence, () => directory);
  t.after(() => controller.close());
  const header = { sessionId: "same", createdAt: 1 };
  assert.equal((await controller.create(header)).status, "unknown");
  assert.equal((await controller.create(header)).status, "unknown");
  assert.equal(creates, 1);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(checks, 2);
  assert.equal(directory.snapshot().revision, 2);
  assert.equal((await controller.create(header)).status, "committed");
  assert.equal(creates, 2);
  assert.equal(directory.snapshot().revision, 3);
});

test("后台确认提交后同意图返回已提交结果", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-create-confirm-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  t.after(async () => { await persistence.close(); await rm(dir, { recursive: true, force: true }); });
  const create = persistence.create.bind(persistence);
  t.mock.method(persistence, "create", async (...args: Parameters<typeof create>) => {
    const handle = await create(...args);
    const flush = handle.flush.bind(handle);
    t.mock.method(handle, "flush", async () => { await flush(); throw new Error("丢失回执"); });
    let checks = 0;
    handle.creationVerifier = () => async () => ++checks === 1 ? "unknown" : "committed";
    return handle;
  });
  const { SessionCreationController } = await import("../commands.ts");
  const directory = new SessionDirectory();
  const controller = new SessionCreationController(persistence, () => directory);
  t.after(() => controller.close());
  const header = { sessionId: "same", createdAt: 1 };
  assert.equal((await controller.create(header)).status, "unknown");
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal((await controller.create(header)).status, "committed");
  assert.equal(directory.snapshot().revision, 1);
});

test("真实请求跨越关闭进入未知后不再调度核实", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-create-network-close-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const app = Fastify();
  t.after(async () => { await app.close(); await persistence.close(); await rm(dir, { recursive: true, force: true }); });
  let entered!: () => void;
  let release!: () => void;
  let closingEntered!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const closingReached = new Promise<void>((resolve) => { closingEntered = resolve; });
  let checks = 0;
  const create = persistence.create.bind(persistence);
  t.mock.method(persistence, "create", async (...args: Parameters<typeof create>) => {
    const handle = await create(...args);
    t.mock.method(handle, "flush", async () => { entered(); await gate; throw new Error("flush fault"); });
    handle.creationVerifier = () => async () => { checks++; return "unknown"; };
    return handle;
  });
  const directory = new SessionDirectory();
  registerSessionRoutes(app, "/api/sessions", persistence, { prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }) },
    { get: () => undefined, onLoaded: () => () => {} }, () => directory);
  app.addHook("preClose", async () => { closingEntered(); });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const post = fetch(`${address}/api/sessions`, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: "{}" });
  await reached;
  const closing = app.close();
  await closingReached;
  release();
  assert.equal((await post).status, 503);
  await closing;
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(checks, 1);
  assert.equal(directory.snapshot().revision, 1);
});

test("真实 GET 挂起时合并在线运行与维护状态及活动时间且不加载或写入", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mh-directory-live-network-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  for (const id of ["running", "maintenance"]) {
    const handle = await persistence.create({ sessionId: id, createdAt: 1 });
    await handle.flush(); await handle.close();
  }
  let releaseWork!: () => void;
  const workGate = new Promise<void>((resolve) => { releaseWork = resolve; });
  const manager = new AgentManager(persistence, async () => { await workGate; });
  const running = await manager.load("running");
  const maintenance = await manager.load("maintenance");
  const app = Fastify();
  t.after(async () => { releaseWork(); await app.close(); await manager.close(); await persistence.close(); await rm(dir, { recursive: true, force: true }); });
  const directory = await SessionDirectory.restore(persistence);
  registerSessionRoutes(app, "/api/sessions", persistence, new SessionCommandController(manager), manager, () => directory);
  let entered!: () => void;
  let releaseList!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { releaseList = resolve; });
  const list = persistence.list.bind(persistence);
  t.mock.method(persistence, "list", async () => { const snapshot = await list(); entered(); await gate; return snapshot; });
  const load = t.mock.method(manager, "load", async () => { throw new Error("GET 不应加载"); });
  const open = t.mock.method(persistence, "open", async () => { throw new Error("GET 不应读取事件"); });
  const create = t.mock.method(persistence, "create", async () => { throw new Error("GET 不应写入"); });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const request = fetch(`${address}/api/sessions`, { headers: { connection: "close" } });
  await reached;
  const work = maintenance.runMaintenance(async () => { await workGate; });
  await running.prompt({ requestId: "r", content: [{ type: "text", text: "你好" }] });
  releaseList();
  const response = await request;
  assert.equal(response.status, 200);
  const body = await response.json() as { revision: number; sessions: Array<{ sessionId: string; running: boolean; blank: boolean; updatedAt: number }> };
  assert.equal(body.revision, 0);
  const active = body.sessions.find((item) => item.sessionId === "running");
  const maintained = body.sessions.find((item) => item.sessionId === "maintenance");
  assert.equal(active?.running, true);
  assert.equal(active?.blank, false);
  assert.ok((active?.updatedAt ?? 0) > 1);
  assert.equal(maintained?.running, false);
  assert.equal(load.mock.calls.length, 0);
  assert.equal(open.mock.calls.length, 0);
  assert.equal(create.mock.calls.length, 0);
  releaseWork();
  await work;
});

test("创建已提交时锁释放故障不改变 201，恢复后首次消息取得写入权", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await mkdtemp(join(tmpdir(), "mharness-create-lock-retry-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const manager = new AgentManager(persistence, async () => {});
  const app = Fastify();
  const commands = new SessionCommandController(manager);
  registerSessionRoutes(app, "/api/sessions", persistence, commands, manager, () => new SessionDirectory());
  const exec = DatabaseSync.prototype.exec;
  const close = DatabaseSync.prototype.close;
  let lock: InstanceType<typeof DatabaseSync> | undefined;
  let fail = true;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: InstanceType<typeof DatabaseSync>, sql: string) {
    exec.call(this, sql);
    if (sql === "PRAGMA busy_timeout = 0; BEGIN IMMEDIATE" && !lock) lock = this;
  });
  t.mock.method(DatabaseSync.prototype, "close", function (this: InstanceType<typeof DatabaseSync>) {
    if (fail && this === lock) throw new Error("lock close fault");
    return close.call(this);
  });
  try {
    const created = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    assert.equal(created.statusCode, 201);
    const { sessionId } = created.json() as { sessionId: string };
    fail = false;
    await new Promise(resolve => setTimeout(resolve, 600));
    const response = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: {
      requestId: "first", content: [{ type: "text", text: "hello" }],
    } });
    assert.equal(response.statusCode, 202);
  } finally {
    fail = false;
    await app.close(); await manager.close(); await persistence.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("创建准备失败时控制器保留同一尝试直到旧锁释放", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { SessionCreationController } = await import("../commands.ts");
  const dir = await mkdtemp(join(tmpdir(), "mharness-prepare-lock-controller-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const controller = new SessionCreationController(persistence, () => new SessionDirectory());
  const abort = new AbortController();
  const exec = DatabaseSync.prototype.exec;
  const close = DatabaseSync.prototype.close;
  let lock: InstanceType<typeof DatabaseSync> | undefined;
  let fail = true;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: InstanceType<typeof DatabaseSync>, sql: string) {
    exec.call(this, sql);
    if (sql === "PRAGMA busy_timeout = 0; BEGIN IMMEDIATE" && !lock) { lock = this; abort.abort(); }
  });
  t.mock.method(DatabaseSync.prototype, "close", function (this: InstanceType<typeof DatabaseSync>) {
    if (fail && this === lock) throw new Error("lock close fault");
    return close.call(this);
  });
  const create = persistence.create.bind(persistence);
  const override = t.mock.method(persistence, "create", (value: Parameters<typeof create>[0]) => create(value, { signal: abort.signal }));
  const fixed = { sessionId: "same", createdAt: 1 };
  try {
    const first = await controller.create(fixed);
    assert.equal(first.status, "unknown");
    assert.equal(await controller.create(fixed), first);
    await assert.rejects(create(fixed), { name: "OwnershipConflictError" });
    fail = false;
    override.mock.restore();
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal((await controller.create(fixed)).status, "committed");
  } finally { fail = false; controller.close(); await persistence.close(); await rm(dir, { recursive: true, force: true }); }
});

test("已提交同 ID 的准备失败核实不移除目录项", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { SessionCreationController } = await import("../commands.ts");
  const dir = await mkdtemp(join(tmpdir(), "mh-existing-create-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const fixed = { sessionId: "same", createdAt: 1 };
  const existing = await persistence.create(fixed); await existing.flush(); await existing.close();
  const directory = await SessionDirectory.restore(persistence);
  const before = directory.snapshot();
  const controller = new SessionCreationController(persistence, () => directory);
  const exec = DatabaseSync.prototype.exec; const close = DatabaseSync.prototype.close;
  let lock: InstanceType<typeof DatabaseSync> | undefined; let fail = true;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: InstanceType<typeof DatabaseSync>, sql: string) {
    exec.call(this, sql); if (sql === "PRAGMA busy_timeout = 0; BEGIN IMMEDIATE") lock = this;
  });
  t.mock.method(DatabaseSync.prototype, "close", function (this: InstanceType<typeof DatabaseSync>) {
    if (fail && this === lock) throw new Error("lock close fault"); return close.call(this);
  });
  try {
    assert.equal((await controller.create(fixed)).status, "unknown");
    fail = false;
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.deepEqual(directory.snapshot(), before);
  } finally { fail = false; controller.close(); await persistence.close(); await rm(dir, { recursive: true, force: true }); }
});
