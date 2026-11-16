import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { followFrameSchema, rawSessionHistorySchema } from "@mharness/session/contracts";
import { SqliteSessionPersistence } from "@mharness/session/server";
import { ReActAgent } from "../agent/react-agent.ts";
import { followSession } from "../session/follow.ts";
import { registerSessionRoutes } from "../session/routes.ts";
import { z } from "zod";
import { Session } from "@mharness/session/server";
import { defineLocalTool, ToolRegistry } from "./registry.ts";
import { prepareToolOperation } from "./operation.ts";

function fixture(policy: "allow" | "deny" | "ask" = "allow", version = "1") {
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register(defineLocalTool({ name: "read", version, description: "read", input: z.strictObject({ nested: z.strictObject({ x: z.number() }) }), timeoutMs: 1000, approvalPolicy: policy, handler: () => { executions++; } }));
  return { registry, executions: () => executions };
}
function declare(session: Session, step: number, callId: string, args = '{"nested":{"x":1}}') {
  session.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true, message: { id: `a${step}-${callId}`, role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "tool-call", id: callId, name: "read", arguments: args }] } } });
  session.append({ type: "tool/call", data: { turn: 1, step, callId, name: "read", arguments: args } });
  return { turn: 1, step, callId };
}

test("有效操作绑定不可变参数，重传复用，新调用独立且不派发", () => {
  const session = new Session({ sessionId: "s", createdAt: 0 });
  const { registry, executions } = fixture();
  const id = declare(session, 1, "a");
  const one = prepareToolOperation(session, registry, id);
  assert.equal(one.kind, "ready");
  if (one.kind !== "ready") throw new Error("expected ready");
  assert.equal(one.decision, "allow");
  assert.equal(Object.isFrozen(one.operation.data.validatedArgs), true);
  assert.throws(() => { (one.operation.data.validatedArgs as { nested: { x: number } }).nested.x = 2; }, TypeError);
  assert.equal(Object.isFrozen(one.call.args), true);
  assert.equal(Object.isFrozen((one.call.args as { nested: object }).nested), true);
  assert.deepEqual(one.operation.data.validatedArgs, { nested: { x: 1 } });
  const repeat = prepareToolOperation(session, registry, id);
  assert.equal(repeat.kind, "ready");
  if (repeat.kind !== "ready") throw new Error("expected ready");
  assert.equal(repeat.operation.data.operationId, one.operation.data.operationId);
  const newCall = prepareToolOperation(session, registry, declare(session, 2, "a"));
  assert.equal(newCall.kind, "ready");
  if (newCall.kind !== "ready") throw new Error("expected ready");
  assert.notEqual(newCall.operation.data.operationId, one.operation.data.operationId);
  assert.throws(() => prepareToolOperation(session, fixture("allow", "2").registry, id), /不一致/);
  const conflict = new Session({ sessionId: "conflict", createdAt: 0 });
  const conflictId = declare(conflict, 1, "a");
  conflict.append({ type: "tool/operation", data: { ...conflictId, operationId: "existing", toolName: "read", toolVersion: "1", validatedArgs: { nested: { x: 9 } } } });
  assert.throws(() => prepareToolOperation(conflict, registry, conflictId), /不一致/);
  assert.equal(executions(), 0);
});

test("可信策略决定拒绝和询问，拒绝与参数错误只结算原调用", () => {
  const session = new Session({ sessionId: "s", createdAt: 0 });
  const { registry, executions } = fixture();
  const deniedId = declare(session, 1, "deny");
  const denied = prepareToolOperation(session, registry, deniedId, () => "deny");
  assert.equal(denied.kind, "settled");
  if (denied.kind !== "settled") throw new Error("expected settled");
  assert.ok(denied.result.data.operationId);
  assert.deepEqual(prepareToolOperation(session, registry, deniedId), denied);
  const asked = prepareToolOperation(session, registry, declare(session, 2, "ask"), () => "ask");
  assert.equal(asked.kind, "ready");
  if (asked.kind !== "ready") throw new Error("expected ready");
  assert.equal(asked.decision, "ask");
  for (const [step, args, code] of [[3, "{", "INVALID_JSON"], [4, '{"nested":{"x":"1"}}', "INVALID_INPUT"]] as const) {
    let calls = 0;
    const result = prepareToolOperation(session, registry, declare(session, step, `bad${step}`, args), () => { calls++; return "allow"; });
    assert.equal(result.kind, "settled");
    if (result.kind !== "settled") throw new Error("expected settled");
    assert.equal(result.result.data.operationId, undefined);
    assert.equal(result.result.data.error?.code, code);
    assert.equal(calls, 0);
  }
  assert.equal(session.snapshot().events.filter((event) => event.type === "tool/operation").length, 2);
  assert.equal(executions(), 0);
});


test("已接受 follow 和提交后 HTTP 历史保留同一操作前缀", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tool-operation-"));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const session = new Session({ sessionId: "s", createdAt: 0 });
  const app = Fastify();
  const handle = await persistence.create(session.header);
  await handle.flush();
  persistence.bindWriter(handle, session);
  const agent = new ReActAgent(session, async () => {}, handle);
  const agents = { get: () => agent, onLoaded: () => () => {} };
  registerSessionRoutes(app, "/api/sessions", persistence, { prompt: async () => ({ accepted: true }), cancel: async () => ({ accept: true }) }, agents);
  const abort = new AbortController();
  const follow = followSession(agents, async () => undefined, "s", abort.signal);
  try {
    const initial = await follow.next();
    assert.equal(followFrameSchema.parse(JSON.parse((initial.value ?? "").slice(6))).type, "snapshot");
    const identity = declare(session, 1, "call");
    const prepared = prepareToolOperation(session, fixture().registry, identity);
    assert.equal(prepared.kind, "ready");
    const observed = [];
    for (let i = 0; i < session.seq; i++) {
      const frame = followFrameSchema.parse(JSON.parse(((await follow.next()).value ?? "").slice(6)));
      assert.equal(frame.type, "event");
      if (frame.type === "event") observed.push(frame.event);
    }
    assert.deepEqual(observed, session.snapshot().events);
    assert.equal(observed.at(-1)?.type, "tool/operation");
    await session.flush();
    const response = await app.inject({ method: "GET", url: "/api/sessions/s" });
    assert.equal(response.statusCode, 200);
    const history = rawSessionHistorySchema.parse(response.json());
    assert.deepEqual(history.records.map((frame) => frame.event), observed);
  } finally {
    abort.abort();
    await follow.return(undefined);
    await app.close();
    await agent.stop();
    await persistence.close();
    await rm(dir, { recursive: true, force: true });
  }
});
