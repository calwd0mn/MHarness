import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventSessionApp } from "../app.ts";
import { ApprovalService } from "./service.ts";
import { appendToolResult } from "../tools/result-event.ts";

test("真实 HTTP 答复、忙碌、重发与重启后的已保存决定", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "approval-http-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let report!: (id: string) => void;
  const requested = new Promise<string>((resolve) => { report = resolve; });
  const approvals = new ApprovalService((asked) => { report(asked.data.id); return new Promise(() => {}); });
  const path = join(dir, "events.sqlite");
  const app = await createEventSessionApp(path, false, async ({ session, turn, step, signal }) => {
    session.append({ type: "assistant/message", surfaceOp: "append", data: { turn, step, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true, message: { id: "a", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "tool-call", id: "c", name: "t", arguments: "{}" }] } } });
    session.append({ type: "tool/call", data: { turn, step, callId: "c", name: "t", arguments: "{}" } });
    const operation = session.append({ type: "tool/operation", data: { turn, step, callId: "c", operationId: "o", toolName: "t", toolVersion: "1", validatedArgs: {} } });
    await approvals.request(session, operation, "r", signal);
    appendToolResult(session, { turn, step, callId: "c", messageId: "result" }, { isError: true, error: { message: "测试" }, content: [{ type: "text", text: "测试" }] });
    session.append({ type: "step/end", data: { turn, step } });
    session.append({ type: "turn/end", data: { turn, reason: { kind: "completed" } } });
  }, { approvalService: approvals });
  let sessionId = "";
  let id = "";
  try {
    sessionId = (await app.inject({ method: "POST", url: "/api/sessions" })).json().sessionId;
    const url = `/api/sessions/${sessionId}`;
    const prompt = (requestId: string) => app.inject({ method: "POST", url: `${url}/messages`, payload: { requestId, content: [{ type: "text", text: "hello" }] } });
    assert.equal((await prompt("one")).statusCode, 202);
    id = await requested;
    assert.equal((await prompt("two")).statusCode, 409);
    const history = (await app.inject({ method: "GET", url })).json();
    assert.equal(history.records.some((record: { event: { type: string; data: { requestId?: string } } }) => record.event.type === "user/message" && record.event.data.requestId === "two"), false);
    const decision = (outcome: string) => app.inject({ method: "POST", url: `${url}/approvals/${id}/decision`, payload: { outcome } });
    assert.deepEqual((await decision("allowed-once")).json(), { id, outcome: "allowed-once" });
    assert.equal((await decision("allowed-once")).statusCode, 200);
    const conflict = await decision("rejected");
    assert.equal(conflict.statusCode, 409);
    assert.deepEqual(conflict.json(), { id, outcome: "allowed-once" });
    assert.equal((await app.inject({ method: "POST", url: `${url}/approvals/missing/decision`, payload: { outcome: "rejected" } })).statusCode, 404);
  } finally { await app.close(); }
  const reopened = await createEventSessionApp(path);
  try {
    const repeat = await reopened.inject({ method: "POST", url: `/api/sessions/${sessionId}/approvals/${id}/decision`, payload: { outcome: "allowed-once" } });
    assert.equal(repeat.statusCode, 200);
    assert.deepEqual(repeat.json(), { id, outcome: "allowed-once" });
  } finally { await reopened.close(); }
});

test("恢复仅保留 asked 时拒绝迟到答复且不重启审批", async (t) => {
  const { Session, SqliteSessionPersistence } = await import("@mharness/session/server");
  const dir = await mkdtemp(join(tmpdir(), "approval-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  const persistence = new SqliteSessionPersistence(path);
  const session = new Session({ sessionId: "old", createdAt: 0 });
  const handle = await persistence.create(session.header);
  await handle.flush();
  persistence.bindWriter(handle, session);
  session.append({ type: "turn/start", data: { turn: 1 } });
  session.append({ type: "step/start", data: { turn: 1, step: 1 } });
  session.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true, message: { id: "a", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "tool-call", id: "c", name: "t", arguments: "{}" }] } } });
  session.append({ type: "tool/call", data: { turn: 1, step: 1, callId: "c", name: "t", arguments: "{}" } });
  session.append({ type: "tool/operation", data: { turn: 1, step: 1, callId: "c", operationId: "o", toolName: "t", toolVersion: "1", validatedArgs: {} } });
  session.append({ type: "approval/asked", data: { id: "old-approval", operationId: "o", toolName: "t", callId: "c", reason: "r" } });
  await session.flush();
  await handle.close();
  await persistence.close();
  const app = await createEventSessionApp(path);
  try {
    const result = await app.inject({ method: "POST", url: "/api/sessions/old/approvals/old-approval/decision", payload: { outcome: "allowed-once" } });
    assert.equal(result.statusCode, 409);
    assert.deepEqual(result.json(), { code: "approval_not_active" });
    const history = (await app.inject({ method: "GET", url: "/api/sessions/old" })).json();
    assert.equal(history.records.filter((r: { event: { type: string } }) => r.event.type === "approval/decided").length, 0);
    assert.equal(history.records.filter((r: { event: { type: string } }) => r.event.type === "tool/result").length, 1);
  } finally { await app.close(); }
});

test("无渠道结局可由批次保存配对错误且正文不执行", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "approval-unavailable-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const approvals = new ApprovalService(null);
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  let bodies = 0;
  const app = await createEventSessionApp(join(dir, "events.sqlite"), false, async ({ session, turn, step, signal }) => {
    session.append({ type: "assistant/message", surfaceOp: "append", data: { turn, step, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true, message: { id: "a", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "tool-call", id: "c", name: "t", arguments: "{}" }] } } });
    session.append({ type: "tool/call", data: { turn, step, callId: "c", name: "t", arguments: "{}" } });
    const operation = session.append({ type: "tool/operation", data: { turn, step, callId: "c", operationId: "o", toolName: "t", toolVersion: "1", validatedArgs: {} } });
    const outcome = await approvals.request(session, operation, "r", signal);
    if (outcome === "allowed-once") bodies++;
    else appendToolResult(session, { turn, step, callId: "c", messageId: "result" }, { isError: true, error: { message: "审批不可用", info: { name: "ApprovalError", code: "APPROVAL_UNAVAILABLE" } }, content: [{ type: "text", text: "审批不可用" }] });
    session.append({ type: "step/end", data: { turn, step } });
    session.append({ type: "turn/end", data: { turn, reason: { kind: "completed" } } });
    await session.flush();
    finish();
  }, { approvalService: approvals });
  try {
    const sessionId: string = (await app.inject({ method: "POST", url: "/api/sessions" })).json().sessionId;
    await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { requestId: "one", content: [{ type: "text", text: "hello" }] } });
    await finished;
    const history = (await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` })).json();
    const records: { event: { type: string; data: { outcome?: string; operationId?: string; error?: { code: string } } } }[] = history.records;
    assert.equal(records.find((r) => r.event.type === "approval/decided")?.event.data.outcome, "unavailable");
    const result = records.find((r) => r.event.type === "tool/result");
    assert.equal(result?.event.data.operationId, "o");
    assert.equal(result?.event.data.error?.code, "APPROVAL_UNAVAILABLE");
    assert.equal(bodies, 0);
  } finally { await app.close(); }
});

test("follow 与持久历史交付相同的原始操作和审批事件", async (t) => {
  const { Session, SqliteSessionPersistence } = await import("@mharness/session/server");
  const { ReActAgent } = await import("../agent/react-agent.ts");
  const { followSession } = await import("../session/follow.ts");
  const dir = await mkdtemp(join(tmpdir(), "approval-follow-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const persistence = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  const session = new Session({ sessionId: "s", createdAt: 0 });
  const handle = await persistence.create(session.header);
  await handle.flush();
  persistence.bindWriter(handle, session);
  const agent = new ReActAgent(session, async () => {}, handle);
  const abort = new AbortController();
  const follow = followSession({ get: () => agent, onLoaded: () => () => {} }, async () => undefined, "s", abort.signal);
  try {
    await follow.next();
    session.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true, message: { id: "a", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "tool-call", id: "c", name: "t", arguments: "{}" }] } } });
    session.append({ type: "tool/call", data: { turn: 1, step: 1, callId: "c", name: "t", arguments: "{}" } });
    const operation = session.append({ type: "tool/operation", data: { turn: 1, step: 1, callId: "c", operationId: "o", toolName: "t", toolVersion: "v1", validatedArgs: { x: 1 } } });
    await new ApprovalService(null).request(session, operation, "r", abort.signal);
    const live = [];
    for (let i = 0; i < session.seq; i++) {
      const frame = await follow.next();
      live.push(JSON.parse((frame.value ?? "").slice(6)).event);
    }
    assert.deepEqual(live, await handle.read());
    assert.deepEqual(live.filter((e: { type: string }) => ["tool/operation", "approval/asked", "approval/decided"].includes(e.type)).map((e: { type: string }) => e.type), ["tool/operation", "approval/asked", "approval/decided"]);
  } finally {
    abort.abort();
    await follow.return(undefined);
    await agent.stop();
    await handle.close();
    await persistence.close();
  }
});
