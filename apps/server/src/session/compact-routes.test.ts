import { SessionDirectory } from "./directory.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { SqliteSessionPersistence, readPersistedSessionHistory } from "@mharness/session/server";
import { registerSessionRoutes } from "./routes.ts";
import { followSession } from "./follow.ts";
import { AgentError } from "../agent/react-agent.ts";
import { createEventSessionApp } from "../app.ts";

const compactionId = "2dfe7336-a43e-4fcb-9530-1880d94588ce";

test("压缩路由等待终态，解析错误和内部错误使用安全响应", async () => {
  const app = Fastify();
  const dir = await mkdtemp(join(tmpdir(), "mharness-compact-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  let calls = 0;
  registerSessionRoutes(app, "/api/sessions", persistence, {
    prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }),
    compact: async () => { calls++; return { compactionId, commandId: "cmd", status: "succeeded" }; },
  }, { get: () => undefined, onLoaded: () => () => {} }, () => new SessionDirectory());
  try {
    const response = await app.inject({ method: "POST", url: "/api/sessions/s/compact", payload: { compactionId } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { compactionId, commandId: "cmd", status: "succeeded" });
    for (const payload of ["{", ""]) {
      const invalid = await app.inject({ method: "POST", url: "/api/sessions/s/compact", headers: { "content-type": "application/json" }, payload });
      assert.equal(invalid.statusCode, 400);
      assert.deepEqual(invalid.json(), { commandId: null, result: { kind: "error", text: "压缩请求无效" } });
    }
    assert.equal(calls, 1);
  } finally {
    await app.close();
    await persistence.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("压缩路由映射明确拒绝并脱敏异常和无效结果", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-compact-errors-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const app = Fastify();
  registerSessionRoutes(app, "/api/sessions", persistence, {
    prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }),
    compact: async ({ sessionId }) => {
      if (sessionId === "conflict") return { code: "compaction_id_conflict" };
      if (sessionId === "busy") return { commandId: "busy-cmd", result: { kind: "error", text: "忙碌" } };
      if (sessionId === "missing") throw new AgentError("session/not-found");
      if (sessionId === "blocked") throw new AgentError("storage_blocked");
      if (sessionId === "secret") throw new Error("private-compact-secret");
      if (sessionId === "parser") throw Object.assign(new Error("private-compact-secret"), { code: "FST_ERR_CTP_BODY_TOO_LARGE" });
      if (sessionId === "json") throw Object.assign(new Error("private-compact-secret"), { code: "FST_ERR_CTP_INVALID_JSON_BODY" });
      return { compactionId: "c78a67b6-0f09-47da-bcdd-e794cd0f4f0f", commandId: "cmd", status: "succeeded" };
    },
  }, { get: () => undefined, onLoaded: () => () => {} }, () => new SessionDirectory());
  try {
    for (const [id, status, code] of [["conflict", 409, "compaction_id_conflict"], ["missing", 404, "session/not-found"], ["blocked", 503, "storage_blocked"], ["secret", 500, "compaction_internal_error"], ["wrong", 500, "compaction_internal_error"], ["parser", 500, "compaction_internal_error"], ["json", 500, "compaction_internal_error"]] as const) {
      const response = await app.inject({ method: "POST", url: `/api/sessions/${id}/compact`, payload: { compactionId } });
      assert.equal(response.statusCode, status);
      assert.deepEqual(response.json(), { code });
      assert.doesNotMatch(response.body, /private-compact-secret|stack/i);
    }
    const busy = await app.inject({ method: "POST", url: "/api/sessions/busy/compact", payload: { compactionId } });
    assert.equal(busy.statusCode, 409);
    assert.deepEqual(busy.json(), { commandId: "busy-cmd", result: { kind: "error", text: "忙碌" } });
    const invalid = await app.inject({ method: "POST", url: "/api/sessions/s/compact", payload: { compactionId, content: [] } });
    assert.deepEqual(invalid.json(), { commandId: null, result: { kind: "error", text: "压缩请求无效" } });
    const message = await app.inject({ method: "POST", url: "/api/sessions/s/messages", headers: { "content-type": "application/json" }, payload: "{" });
    assert.equal(message.statusCode, 400);
    assert.notDeepEqual(message.json(), { code: "invalid_request" });
  } finally { await app.close(); await persistence.close(); await rm(dir, { recursive: true, force: true }); }
});

test("压缩路由等待处理器完成", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-compact-wait-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const app = Fastify();
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  registerSessionRoutes(app, "/api/sessions", persistence, {
    prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }),
    compact: async (request) => {
      assert.deepEqual(request, { sessionId: "s", compactionId });
      entered?.(); await gate;
      return { compactionId, commandId: "cmd", status: "cancelled" };
    },
  }, { get: () => undefined, onLoaded: () => () => {} }, () => new SessionDirectory());
  try {
    let completed = false;
    const response = Promise.resolve(app.inject({ method: "POST", url: "/api/sessions/s/compact", payload: { compactionId } })).then((value) => { completed = true; return value; });
    await started;
    assert.equal(completed, false);
    release?.();
    assert.deepEqual((await response).json(), { compactionId, commandId: "cmd", status: "cancelled" });
  } finally { release?.(); await app.close(); await persistence.close(); await rm(dir, { recursive: true, force: true }); }
});

test("生产压缩无安全范围时持久结算命令且不运行 Turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-compact-unavailable-"));
  let calls = 0;
  const app = await createEventSessionApp(join(dir, "events.sqlite"), false, async () => { calls++; });
  try {
    const created = await app.inject({ method: "POST", url: "/api/sessions" });
    const { sessionId } = created.json() as { sessionId: string };
    const url = `/api/sessions/${sessionId}`;
    const args = " \t备注  ";
    const response = await app.inject({ method: "POST", url: `${url}/compact`, payload: { compactionId, args } });
    assert.equal(response.statusCode, 200);
    const { commandId } = response.json<{ commandId: string }>();
    assert.ok(commandId);
    assert.notEqual(commandId, compactionId);
    assert.deepEqual(response.json(), { compactionId, commandId, status: "no_safe_range" });
    const history = await app.inject({ method: "GET", url });
    assert.deepEqual(history.json().records.map(({ event }: { event: { type: string; data: unknown } }) => [event.type, event.data]), [
      ["command/run", { commandId, name: "compact", source: { kind: "user" }, args }],
      ["command/done", { commandId, kind: "success", text: "No compactable history yet." }],
    ]);
    assert.equal((await app.inject({ method: "POST", url: `${url}/cancel` })).statusCode, 202);
    assert.equal(calls, 0);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test("替身明确拒绝重复标识，不复用先前成功结果", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-compact-duplicate-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const app = Fastify();
  const seen = new Set<string>();
  registerSessionRoutes(app, "/api/sessions", persistence, {
    prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }),
    compact: async (request) => {
      if (seen.has(request.compactionId)) return { code: "compaction_id_conflict" };
      seen.add(request.compactionId);
      return { compactionId: request.compactionId, commandId: "cmd", status: "succeeded" };
    },
  }, { get: () => undefined, onLoaded: () => () => {} }, () => new SessionDirectory());
  try {
    const post = () => app.inject({ method: "POST", url: "/api/sessions/s/compact", payload: { compactionId } });
    assert.deepEqual((await post()).json(), { compactionId, commandId: "cmd", status: "succeeded" });
    const duplicate = await post();
    assert.equal(duplicate.statusCode, 409);
    assert.deepEqual(duplicate.json(), { code: "compaction_id_conflict" });
  } finally { await app.close(); await persistence.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const type of ["application/json;", "application/json; ; charset=utf-8", "application/json; charset=utf-8;"]) test(`允许空媒体类型参数：${type}`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-compact-media-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const app = Fastify();
  registerSessionRoutes(app, "/api/sessions", persistence, {
    prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }),
    compact: async () => ({ compactionId, commandId: "cmd", status: "succeeded" }),
  }, { get: () => undefined, onLoaded: () => () => {} }, () => new SessionDirectory());
  try {
    const response = await app.inject({ method: "POST", url: "/api/sessions/s/compact", headers: { "content-type": type }, payload: JSON.stringify({ compactionId }) });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { compactionId, commandId: "cmd", status: "succeeded" });
  } finally { await app.close(); await persistence.close(); await rm(dir, { recursive: true, force: true }); }
});

test("压缩入口拒绝媒体类型与无效正文且不调用命令", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-compact-entry-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const handle = await persistence.create({ sessionId: "s", createdAt: 1 });
  await handle.append([{ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }]);
  await handle.close();
  const app = Fastify({ bodyLimit: 128 });
  let calls = 0;
  const manager = { get: () => undefined, onLoaded: () => () => {} };
  registerSessionRoutes(app, "/api/sessions", persistence, {
    prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }),
    compact: async () => { calls++; return { compactionId, commandId: "cmd", status: "succeeded" }; },
  }, manager, () => new SessionDirectory());
  const abort = new AbortController();
  const follow = followSession(manager, () => readPersistedSessionHistory(persistence, "s"), "s", abort.signal);
  try {
    const before = await readPersistedSessionHistory(persistence, "s");
    assert.match((await follow.next()).value ?? "", /"cursor":0/);
    for (const [type, payload, status] of [["text/plain", "{}", 415], ["application/other", "{}", 415], ["application/json; charset=", JSON.stringify({ compactionId }), 415], ["application/json; invalid", JSON.stringify({ compactionId }), 415], ["application/json; charset =utf-8", JSON.stringify({ compactionId }), 415], ["application/json; charset= utf-8", JSON.stringify({ compactionId }), 415], ["application/json", "{", 400], ["application/json", "", 400], ["application/json", "{}", 400], ["application/json", JSON.stringify({ compactionId, extra: "x".repeat(200) }), 413]] as const) {
      const response = await app.inject({ method: "POST", url: "/api/sessions/s/compact", headers: { "content-type": type }, payload });
      assert.equal(response.statusCode, status);
      assert.deepEqual(Object.keys(response.json()).sort(), ["commandId", "result"]);
      assert.equal(response.json().commandId, null);
      assert.equal(response.json().result.kind, "error");
      assert.equal(typeof response.json().result.text, "string");
    }
    const invalidPath = await app.inject({ method: "POST", url: "/api/sessions/%00/compact", payload: { compactionId } });
    assert.equal(invalidPath.statusCode, 400);
    assert.deepEqual(invalidPath.json(), { commandId: null, result: { kind: "error", text: "压缩请求无效" } });
    assert.equal(calls, 0);
    assert.deepEqual(await readPersistedSessionHistory(persistence, "s"), before);
    const next = follow.next();
    assert.equal(await Promise.race([next.then(() => "event"), new Promise<string>((resolve) => setTimeout(() => resolve("quiet"), 20))]), "quiet");
    const accepted = await app.inject({ method: "POST", url: "/api/sessions/s/compact", headers: { "content-type": "application/json; charset=utf-8" }, payload: JSON.stringify({ compactionId }) });
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(accepted.json(), { compactionId, commandId: "cmd", status: "succeeded" });
    for (const type of ['application/json; profile="a;;b"', "application/json;", "application/json; ; charset=utf-8", "application/json; charset=utf-8;"]) {
      const accepted = await app.inject({ method: "POST", url: "/api/sessions/s/compact", headers: { "content-type": type }, payload: JSON.stringify({ compactionId }) });
      assert.equal(accepted.statusCode, 200, type);
      assert.deepEqual(accepted.json(), { compactionId, commandId: "cmd", status: "succeeded" });
    }
    assert.equal(calls, 5);
  } finally { abort.abort(); await follow.return(undefined); await app.close(); await persistence.close(); await rm(dir, { recursive: true, force: true }); }
});

test("畸形路径编码仅在压缩 POST 边界返回安全拒绝", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-compact-url-"));
  let calls = 0;
  const app = await createEventSessionApp(join(dir, "events.sqlite"), false, async () => { calls++; });
  const defaults = Fastify();
  defaults.post("/api/sessions/:sessionId/messages", async () => ({}));
  try {
    const created = await app.inject({ method: "POST", url: "/api/sessions" });
    const { sessionId } = created.json() as { sessionId: string };
    const before = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    for (const id of ["%FF", "bad%"]) {
      const response = await app.inject({ method: "POST", url: `/api/sessions/${id}/compact`, payload: { compactionId } });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { commandId: null, result: { kind: "error", text: "压缩请求无效" } });
      const other = await app.inject({ method: "POST", url: `/api/sessions/${id}/messages`, payload: {} });
      const baseline = await defaults.inject({ method: "POST", url: `/api/sessions/${id}/messages`, payload: {} });
      assert.equal(other.statusCode, baseline.statusCode);
      assert.deepEqual(other.json(), baseline.json());
    }
    const after = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    assert.deepEqual(after.json(), before.json());
    assert.equal(calls, 0);
  } finally { await defaults.close(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const id of ["%FF", "x".repeat(101)]) test(`编码静态段与异常 ID ${id === "%FF" ? "解码" : "长度"} 保持局部拒绝`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-compact-boundary-"));
  let calls = 0;
  const app = await createEventSessionApp(join(dir, "events.sqlite"), false, async () => { calls++; });
  const defaults = Fastify();
  defaults.post("/api/sessions/:sessionId/messages", async () => ({}));
  defaults.post("/api/sessions/:sessionId/cancel", async () => ({}));
  defaults.get("/api/sessions/:sessionId/compact", async () => ({}));
  try {
    for (const url of [`/api/sessions/${id}/compact`, `/api/sessions/${id}/co%6Dpact`, `/api/%73essions/${id}/compact`]) {
      const response = await app.inject({ method: "POST", url, payload: { compactionId } });
      assert.equal(response.statusCode, 400, url);
      assert.deepEqual(response.json(), { commandId: null, result: { kind: "error", text: "压缩请求无效" } });
    }
    for (const [method, suffix] of [["POST", "messages"], ["POST", "cancel"], ["GET", "compact"]] as const) {
      const url = `/api/sessions/${id}/${suffix}`;
      const response = await app.inject({ method, url });
      const baseline = await defaults.inject({ method, url });
      assert.equal(response.statusCode, baseline.statusCode);
      assert.deepEqual(response.json(), baseline.json());
    }
    assert.equal(calls, 0);
  } finally { await defaults.close(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const id of ["%FF", "x".repeat(101)]) test(`绝对请求目标对异常 ID ${id === "%FF" ? "解码" : "长度"} 仅在压缩入口安全拒绝`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-compact-absolute-"));
  let calls = 0;
  const app = await createEventSessionApp(join(dir, "events.sqlite"), false, async () => { calls++; });
  const defaults = Fastify();
  defaults.post("/api/sessions/:sessionId/messages", async () => ({}));
  defaults.post("/api/sessions/:sessionId/compact", async () => ({}));
  try {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const defaultAddress = await defaults.listen({ port: 0, host: "127.0.0.1" });
    const post = (server: string, path: string) => new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const destination = new URL(server);
      const req = httpRequest({ hostname: destination.hostname, port: destination.port, method: "POST", path: path.startsWith("http://") ? path : `${server}${path}`, headers: { "content-type": "application/json" } }, res => {
        let body = "";
        res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) as unknown }));
      });
      req.on("error", reject); req.end(JSON.stringify({ compactionId }));
    });
    const valid = await post(address, "/api/%73essions/s/co%6Dpact");
    assert.deepEqual(valid, { status: 404, body: { code: "session/not-found" } });
    const response = await post(address, `/api/%73essions/${id}/co%6Dpact`);
    assert.deepEqual(response, { status: 400, body: { commandId: null, result: { kind: "error", text: "压缩请求无效" } } });
    const path = `/api/sessions/${id}/messages`;
    const other = await post(address, path);
    const baseline = await post(defaultAddress, path);
    assert.deepEqual(other, baseline);
    const malformed = `http://[bad]/api/sessions/${id}/compact`;
    assert.deepEqual(await post(address, malformed), await post(defaultAddress, malformed));
    assert.equal(calls, 0);
  } finally { await defaults.close(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});
