import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "@mharness/session/server";
import { ApprovalService } from "./service.ts";

function fixture(flush: () => Promise<void> = async () => {}) {
  const session = new Session({ sessionId: "s", createdAt: 0 });
  session.bindCheckpoint(flush);
  session.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true, message: { id: "a", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "tool-call", id: "c", name: "t", arguments: "{}" }] } } });
  session.append({ type: "tool/call", data: { turn: 1, step: 1, callId: "c", name: "t", arguments: "{}" } });
  const operation = session.append({ type: "tool/operation", data: { turn: 1, step: 1, callId: "c", operationId: "o", toolName: "t", toolVersion: "1", validatedArgs: {} } });
  return { session, operation };
}

test("审批先持久化请求，重复操作共用交互和持久决定", async () => {
  const { session, operation } = fixture();
  let calls = 0;
  let resolve!: (outcome: "allowed-once") => void;
  const service = new ApprovalService(() => { calls++; return new Promise((r) => { resolve = r; }); });
  const one = service.request(session, operation, "reason", new AbortController().signal);
  const two = service.request(session, operation, "reason", new AbortController().signal);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 1);
  resolve("allowed-once");
  assert.deepEqual(await Promise.all([one, two]), ["allowed-once", "allowed-once"]);
  assert.equal(session.snapshot().events.filter((e) => e.type === "approval/asked").length, 1);
  assert.equal(session.snapshot().events.filter((e) => e.type === "approval/decided").length, 1);
});

test("请求和决定检查点失败不交付决定", async () => {
  let calls = 0;
  let bodies = 0;
  const failed = fixture(async () => { throw new Error("disk"); });
  const service = new ApprovalService(() => { calls++; return Promise.resolve("allowed-once"); });
  const run = async (value: ReturnType<typeof fixture>) => {
    if (await service.request(value.session, value.operation, "r", new AbortController().signal) === "allowed-once") bodies++;
  };
  await assert.rejects(run(failed), /disk/);
  assert.equal(calls, 0);
  let count = 0;
  const later = fixture(async () => { if (++count === 2) throw new Error("disk"); });
  await assert.rejects(run(later), /disk/);
  assert.equal(bodies, 0);
});

test("HTTP 与渠道竞争只保存一个决定，结算后释放渠道", async () => {
  const { session, operation } = fixture();
  let channelSignal!: AbortSignal;
  let channelReply!: (outcome: "rejected") => void;
  const service = new ApprovalService((_asked, _operation, signal) => { channelSignal = signal; return new Promise((resolve) => { channelReply = resolve; }); });
  const waiting = service.request(session, operation, "r", new AbortController().signal);
  await Promise.resolve(); await Promise.resolve();
  const asked = session.snapshot().events.find((event) => event.type === "approval/asked");
  assert.ok(asked && asked.type === "approval/asked");
  const result = await service.respond("s", asked.data.id, "allowed-once", session.snapshot().events, session);
  assert.deepEqual(result, { status: 200, body: { id: asked.data.id, outcome: "allowed-once" } });
  assert.equal(await waiting, "allowed-once");
  assert.equal(channelSignal.aborted, true);
  channelReply("rejected");
  await Promise.resolve();
  assert.equal(session.snapshot().events.filter((event) => event.type === "approval/decided").length, 1);
  assert.equal((await service.respond("s", asked.data.id, "rejected", session.snapshot().events, session)).status, 409);
});

test("取消使用首次信号，无渠道提交 unavailable，已关闭操作不重新交互", async () => {
  const { session, operation } = fixture();
  const first = new AbortController();
  const second = new AbortController();
  const service = new ApprovalService();
  const waiting = service.request(session, operation, "r", first.signal);
  const repeat = service.request(session, operation, "r", second.signal);
  let settled = false;
  void waiting.then(() => { settled = true; });
  second.abort();
  await Promise.resolve();
  assert.equal(settled, false);
  first.abort();
  assert.deepEqual(await Promise.all([waiting, repeat]), ["cancelled", "cancelled"]);
  const other = fixture();
  assert.equal(await new ApprovalService(null).request(other.session, other.operation, "r", new AbortController().signal), "unavailable");
  other.session.append({ type: "turn/end", data: { turn: 1, reason: { kind: "interrupted" } } });
  await assert.rejects(new ApprovalService().request(other.session, other.operation, "r", new AbortController().signal), /关闭/);
});

test("决定检查点失败后相同决定重新确认才能返回成功", async () => {
  let flushes = 0;
  const { session, operation } = fixture(async () => { if (++flushes === 2) throw new Error("disk"); });
  const service = new ApprovalService();
  const waiting = service.request(session, operation, "r", new AbortController().signal);
  const asked = session.snapshot().events.find((e) => e.type === "approval/asked");
  assert.ok(asked && asked.type === "approval/asked");
  const response = service.respond("s", asked.data.id, "allowed-once", session.snapshot().events, session);
  await assert.rejects(response, /disk/);
  await assert.rejects(waiting, /disk/);
  const retry = await service.respond("s", asked.data.id, "allowed-once", session.snapshot().events, session);
  assert.equal(retry.status, 200);
  assert.equal(flushes, 3);
});

test("没有 asked 的已结束操作不会创建审批", async () => {
  const { session, operation } = fixture();
  session.append({ type: "turn/end", data: { turn: 1, reason: { kind: "interrupted" } } });
  const count = session.seq;
  let calls = 0;
  const service = new ApprovalService(() => { calls++; return null; });
  await assert.rejects(service.request(session, operation, "r", new AbortController().signal), /关闭/);
  assert.equal(session.seq, count);
  assert.equal(calls, 0);
});
