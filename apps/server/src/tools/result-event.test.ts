import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { ToolRegistry, defineLocalTool } from "./registry.ts";
import { defineLocalToolOutput, normalizeLocalToolResult, normalizeToolError } from "./result.ts";
import { followFrameSchema, rawSessionEventFrameSchema, rawSessionHistorySchema } from "@mharness/session/contracts";
import { Session, SqliteSessionPersistence } from "@mharness/session/server";
import { rebuildRequestContext } from "../agent/request-context.ts";
import { appendToolResult } from "./result-event.ts";

function declare(session: Session, step: number, turn = 1, name = "read", args = "{}") {
  return session.append({ type: "assistant/message", surfaceOp: "append", data: {
    turn, step, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true,
    message: { id: `a${turn}-${step}`, role: "assistant", source: { provider: "p", model: "m" }, content: [
      { type: "tool-call", id: "same", name, arguments: args },
    ] },
  } });
}
function schedule(session: Session, step: number, turn = 1, name = "read", args = "{}") {
  return session.append({ type: "tool/call", data: { turn, step, callId: "same", name, arguments: args } });
}

test("结果按调用范围匹配来源，持久化并重开时保留安全投影", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tool-projection-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  const storage = new SqliteSessionPersistence(path);
  const session = new Session({ sessionId: "s", createdAt: 0 });
  let events: ReturnType<Session["snapshot"]>["events"];
  let renders = 0;
  try {
    const handle = await storage.create(session.header);
    await handle.flush();
    storage.bindWriter(handle, session);
    session.append({ type: "request/header", data: { reason: "initial", header: { config: { provider: "p", model: "m" } } } });
    const registry = new ToolRegistry();
    registry.register(defineLocalTool({ name: "read", version: "1", description: "read", input: z.strictObject({}), timeoutMs: 1000, sideEffect: "read-only",
      handler: () => ({ secret: "private-value" }),
    }));
    const prepared = registry.prepare("read", "{}");
    assert.equal(prepared.ok, true);
    if (!prepared.ok) throw new Error("工具准备失败");
    const normalized = normalizeLocalToolResult(defineLocalToolOutput({ schema: z.strictObject({ secret: z.string() }),
      render: () => { renders++; return [{ type: "text", text: "visible" }]; },
      presentationMeta: () => ({ ui: "only" }),
    }), prepared.call.args, await prepared.call.execute(), true);
    declare(session, 1);
    const firstCall = schedule(session, 1);
    const first = appendToolResult(session, { turn: 1, step: 1, callId: "same", messageId: "r1" }, normalized);
    assert.deepEqual(first.sourceEventSeqs, [firstCall.seq]);
    assert.equal(first.data.operationId, undefined);
    declare(session, 2);
    const secondCall = schedule(session, 2);
    session.append({ type: "tool/operation", data: { turn: 1, step: 2, callId: "same", operationId: "op", toolName: "read", toolVersion: "1", validatedArgs: {} } });
    const second = appendToolResult(session, { turn: 1, step: 2, callId: "same", messageId: "r2" }, {
      isError: true, error: { message: "secret-not-stored", info: { name: "ToolError", code: "FAIL" } }, content: [{ type: "text", text: "safe" }], meta: { ui: 2 },
    });
    assert.deepEqual(second.sourceEventSeqs, [secondCall.seq]);
    assert.equal(second.data.operationId, "op");
    assert.deepEqual(second.data.error, { name: "ToolError", code: "FAIL" });
    const thirdDeclaration = declare(session, 3);
    const third = appendToolResult(session, { turn: 1, step: 3, callId: "same", messageId: "r3" }, normalizeToolError(new Error("secret")));
    assert.deepEqual(third.sourceEventSeqs, [thirdDeclaration.seq]);
    assert.equal(third.data.error, undefined);
    declare(session, 1, 2);
    const otherTurnCall = schedule(session, 1, 2);
    const otherTurn = appendToolResult(session, { turn: 2, step: 1, callId: "same", messageId: "r4" }, { isError: false, content: [] });
    assert.deepEqual(otherTurn.sourceEventSeqs, [otherTurnCall.seq]);
    assert.throws(() => session.append({ type: "tool/result", surfaceOp: { op: "replace", start: first.seq, end: first.seq }, sourceEventSeqs: [first.seq], data: { ...first.data, message: { ...first.data.message, id: "changed" } } }));
    assert.throws(() => appendToolResult(session, { turn: 1, step: 4, callId: "same", messageId: "missing" }, { isError: false, content: [] }));
    assert.throws(() => appendToolResult(session, { turn: 1, step: 1, callId: "same", messageId: "duplicate" }, { isError: false, content: [] }));
    await session.flush();
    events = await handle.read();
    assert.deepEqual(events, session.snapshot().events);
    assert.doesNotMatch(JSON.stringify(events), /private-value|secret-not-stored|concludeTurn/);
    assert.doesNotMatch(JSON.stringify(session.deriveMessages()), /"ui"/);
    for (const event of [first, second, third, otherTurn]) {
      assert.deepEqual(rawSessionEventFrameSchema.parse({ type: "event", event }).event, event);
      assert.deepEqual(followFrameSchema.parse({ type: "event", event }), { type: "event", event });
    }
    assert.doesNotMatch(JSON.stringify(rebuildRequestContext(session).input), /"ui"/);
    rawSessionHistorySchema.parse({ sessionId: "s", inheritedEventCount: 0, cursor: events.length - 1, records: events.map((event) => ({ type: "event", event })) });
    await handle.close();
  } finally { await storage.close(); }
  const reopened = new SqliteSessionPersistence(path);
  try {
    const handle = await reopened.open("s", "read");
    assert.ok(handle);
    const restored = new Session(handle.header, { seed: { kind: "restore", events: await handle.read(), inheritedEventCount: 0 } });
    assert.deepEqual(restored.snapshot().events, events);
    assert.deepEqual(restored.deriveMessages(), session.deriveMessages());
    assert.equal(renders, 1);
    await handle.close();
  } finally { await reopened.close(); }
});


test("准备失败只结算原调用且不执行工具正文", () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register(defineLocalTool({ name: "read", version: "1", description: "read", input: z.strictObject({}),
    timeoutMs: 1000, sideEffect: "read-only", handler: () => { executions++; },
  }));
  const cases = [["read", "{", "INVALID_JSON"], ["read", "{\"extra\":1}", "INVALID_INPUT"], ["missing", "{}", "UNKNOWN_TOOL"]] as const;
  const session = new Session({ sessionId: "failures", createdAt: 0 });
  for (const [index, [name, args, code]] of cases.entries()) {
    const step = index + 1;
    declare(session, step, 1, name, args);
    const call = schedule(session, step, 1, name, args);
    const prepared = registry.prepare(name, args);
    assert.equal(prepared.ok, false);
    if (prepared.ok) throw new Error("预期准备失败");
    assert.equal(prepared.code, code);
    const event = appendToolResult(session, { turn: 1, step, callId: "same", messageId: `failure-${step}` }, {
      isError: true, error: { message: "工具准备失败", info: { name: "ToolError", code: prepared.code } },
      content: [{ type: "text", text: "工具准备失败" }],
    });
    assert.deepEqual(event.sourceEventSeqs, [call.seq]);
    assert.equal(event.data.error?.code, code);
    assert.equal(event.data.operationId, undefined);
  }
  assert.equal(executions, 0);
});
