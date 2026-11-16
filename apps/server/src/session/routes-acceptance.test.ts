import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import Fastify from "fastify";
import { SqliteSessionPersistence } from "@mharness/session/server";
import { AgentManager } from "../agent/manager.ts";
import { SessionCommandController } from "../commands.ts";
import { registerSessionRoutes } from "./routes.ts";

test("维护任务占用期间会话取消传递信号并等待任务退出", { timeout: 8000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-maintenance-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const manager = new AgentManager(persistence, async () => {});
  const app = Fastify();
  registerSessionRoutes(app, "/api/sessions", persistence, new SessionCommandController(manager), manager);
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
  }, { get: () => undefined, onLoaded: () => () => {} });
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
  registerSessionRoutes(app, "/api/sessions", persistence, new SessionCommandController(manager), manager);
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
  registerSessionRoutes(app, "/api/sessions", persistence, new SessionCommandController(manager), manager);
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
    registerSessionRoutes(app, "/api/sessions", persistence, new SessionCommandController(manager), manager);
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
