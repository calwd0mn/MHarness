import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "@mharness/session/server";
import { rebuildRequestContext } from "../agent/request-context.ts";
import { appendToolResult } from "./result-event.ts";
import { ToolDispatch } from "./dispatch.ts";
import { z } from "zod";
import { defineLocalTool, ToolRegistry } from "./registry.ts";
import { defineLocalToolOutput } from "./result.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("派发前各阶段取消均阻止正文", async () => {
  for (const phase of ["待审批", "批准后", "等待检查点"]) {
    const gate = new ToolDispatch<string>();
    let called = false;
    gate.cancel();
    assert.deepEqual(await gate.dispatch(async () => { called = true; return phase; }, "none"),
      { kind: "aborted", code: "ABORTED_BEFORE_DISPATCH" });
    assert.equal(called, false);
  }
});

test("派发后取消向正文传播，停止等待并忽略迟到结果", async () => {
  for (const late of ["resolve", "reject"]) {
    const gate = new ToolDispatch<string>();
    const work = deferred<string>();
    let signal: AbortSignal | undefined;
    const result = gate.dispatch((received) => { signal = received; return work.promise; }, "none");
    gate.cancel();
    assert.equal(signal?.aborted, true);
    assert.deepEqual(await result, { kind: "aborted", code: "ABORTED" });
    if (late === "resolve") work.resolve("late"); else work.reject(new Error("late"));
    await Promise.resolve();
    assert.deepEqual(await result, { kind: "aborted", code: "ABORTED" });
  }
});

test("协作退出等待正文退出并保留确认结果", async () => {
  const gate = new ToolDispatch<string>();
  const work = deferred<string>();
  let settled = false;
  const result = gate.dispatch(() => work.promise, "cooperative-exit");
  void result.then(() => { settled = true; });
  gate.cancel();
  await Promise.resolve();
  assert.equal(settled, false);
  work.resolve("confirmed");
  assert.deepEqual(await result, { kind: "completed", value: "confirmed" });
  gate.cancel();
  assert.deepEqual(await result, { kind: "completed", value: "confirmed" });
});

test("取消结果按 turn、step、callId 进入下一轮上下文", async () => {
  const session = new Session({ sessionId: "dispatch", createdAt: 0 });
  session.append({ type: "request/header", data: { reason: "initial", header: { config: { provider: "p", model: "m" } } } });
  for (const [turn, step, code] of [[1, 1, "ABORTED_BEFORE_DISPATCH"], [1, 2, "ABORTED"], [2, 1, "ABORTED_BEFORE_DISPATCH"]] as const) {
    const gate = new ToolDispatch<string>();
    const work = deferred<string>();
    if (code === "ABORTED_BEFORE_DISPATCH") gate.cancel();
    const outcome = gate.dispatch(() => work.promise, "none");
    if (code === "ABORTED") gate.cancel();
    assert.deepEqual(await outcome, { kind: "aborted", code });
    session.append({ type: "assistant/message", surfaceOp: "append", data: { turn, step, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true,
      message: { id: `a-${turn}-${step}`, role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "tool-call", id: "same", name: "read", arguments: "{}" }] } } });
    const call = session.append({ type: "tool/call", data: { turn, step, callId: "same", name: "read", arguments: "{}" } });
    const result = appendToolResult(session, { turn, step, callId: "same", messageId: `r-${turn}-${step}` }, {
      isError: true, error: { message: code, info: { name: "ToolError", code } }, content: [{ type: "text", text: code }],
    });
    assert.deepEqual(result.sourceEventSeqs, [call.seq]);
  }
  const messages = rebuildRequestContext(session).input.messages;
  assert.deepEqual(messages.map((message) => message.role), ["assistant", "tool", "assistant", "tool", "assistant", "tool"]);
  for (const [index, code] of ["ABORTED_BEFORE_DISPATCH", "ABORTED", "ABORTED_BEFORE_DISPATCH"].entries()) {
    const call = messages[index * 2];
    const result = messages[index * 2 + 1];
    assert.equal(call?.role, "assistant");
    assert.equal(result?.role, "tool");
    if (call?.role !== "assistant" || result?.role !== "tool") throw new Error("上下文消息不匹配");
    assert.equal(call.toolCalls?.[0]?.callId, result.callId);
    assert.match(result.text, new RegExp(code));
  }
});

test("同步重入取消和失败分别结算", async () => {
  const gate = new ToolDispatch<string>();
  const work = deferred<string>();
  const result = gate.dispatch(() => { gate.cancel(); return work.promise; }, "none");
  assert.deepEqual(await result, { kind: "aborted", code: "ABORTED" });
  work.reject(new Error("late"));
  await Promise.resolve();
  assert.throws(() => gate.dispatch(async () => "again", "none"));

  const failure = new Error("failure");
  assert.deepEqual(await new ToolDispatch<string>().dispatch(() => Promise.reject(failure), "none"), { kind: "failed", error: failure });
  assert.deepEqual(await new ToolDispatch<string>().dispatch(() => { throw failure; }, "none"), { kind: "dispatch-error", error: failure });
});

test("已确认结果不受后续取消影响，协作退出拒绝也等待清理", async () => {
  const completed = new ToolDispatch<string>();
  const first = completed.dispatch(async () => "done", "none");
  assert.deepEqual(await first, { kind: "completed", value: "done" });
  completed.cancel();
  assert.deepEqual(await first, { kind: "completed", value: "done" });

  const gate = new ToolDispatch<string>();
  const work = deferred<string>();
  const result = gate.dispatch(() => work.promise, "cooperative-exit");
  gate.cancel();
  const failure = new Error("清理完成后的明确失败");
  work.reject(failure);
  assert.deepEqual(await result, { kind: "failed", error: failure });
});

test("超时后仅本地协作退出等待清理，迟到结果不能覆盖超时", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [executionBoundary, cancellationGuarantee] of [["local", "cooperative-exit"], ["local", "none"], ["remote", "cooperative-exit"], ["remote", "none"]] as const) {
    const gate = new ToolDispatch<string>();
    const work = deferred<string>();
    let signal: AbortSignal | undefined;
    let settled = false;
    const result = gate.dispatch((received) => { signal = received; return work.promise; }, { executionBoundary, cancellationGuarantee, timeoutMs: 20 });
    void result.then(() => { settled = true; });
    t.mock.timers.tick(20);
    await Promise.resolve();
    assert.equal(signal?.aborted, true);
    const waitsForCleanup = executionBoundary === "local" && cancellationGuarantee === "cooperative-exit";
    assert.equal(settled, !waitsForCleanup);
    work.resolve("late");
    assert.deepEqual(await result, { kind: "timeout", code: "TOOL_TIMEOUT" });
  }
});

test("远程取消立即停止等待并处理迟到拒绝", async () => {
  const gate = new ToolDispatch<string>();
  const work = deferred<string>();
  let signal: AbortSignal | undefined;
  const result = gate.dispatch((received) => { signal = received; return work.promise; }, { executionBoundary: "remote", cancellationGuarantee: "cooperative-exit", timeoutMs: 20 });
  gate.cancel();
  assert.equal(signal?.aborted, true);
  assert.deepEqual(await result, { kind: "aborted", code: "ABORTED" });
  work.reject(new Error("late"));
  await Promise.resolve();
});

test("截止前结果优先且取消或完成后不再触发计时", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = new ToolDispatch<string>();
  let signal: AbortSignal | undefined;
  const result = gate.dispatch(async (received) => { signal = received; return "confirmed"; }, { executionBoundary: "local", cancellationGuarantee: "cooperative-exit", timeoutMs: 20 });
  assert.deepEqual(await result, { kind: "completed", value: "confirmed" });
  t.mock.timers.tick(20);
  assert.equal(signal?.aborted, false);
  const cancelled = new ToolDispatch<string>();
  const work = deferred<string>();
  const pending = cancelled.dispatch(() => work.promise, { executionBoundary: "local", cancellationGuarantee: "cooperative-exit", timeoutMs: 20 });
  cancelled.cancel();
  t.mock.timers.tick(20);
  work.resolve("confirmed");
  assert.deepEqual(await pending, { kind: "completed", value: "confirmed" });
});

test("本地超时后的清理拒绝仍结算为超时", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = new ToolDispatch<string>();
  const work = deferred<string>();
  const result = gate.dispatch(() => work.promise, { executionBoundary: "local", cancellationGuarantee: "cooperative-exit", timeoutMs: 1 });
  t.mock.timers.tick(1);
  work.reject(new Error("cleanup"));
  assert.deepEqual(await result, { kind: "timeout", code: "TOOL_TIMEOUT" });
});

test("超时后的迟到值不触发结果渲染", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let renders = 0;
  const work = deferred<number>();
  const registry = new ToolRegistry();
  registry.register(defineLocalTool({ name: "late", version: "1", description: "late", input: z.strictObject({}), timeoutMs: 1,
    handler: () => work.promise, output: defineLocalToolOutput({ schema: z.number(), render: () => { renders++; return [{ type: "text", text: "late" }]; } }) }));
  const prepared = registry.prepare("late", "{}");
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("准备失败");
  const gate = new ToolDispatch<unknown>();
  const result = gate.dispatch((signal) => prepared.call.executeNormalized(signal), prepared.call.governance);
  t.mock.timers.tick(1);
  assert.deepEqual(await result, { kind: "timeout", code: "TOOL_TIMEOUT" });
  work.resolve(1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(renders, 0);
});

test("停止等待的取消不会渲染迟到值，本地协作取消仍可确认结果", async () => {
  for (const executionBoundary of ["local", "remote"] as const) {
    let renders = 0;
    const work = deferred<number>();
    const registry = new ToolRegistry();
    registry.register(defineLocalTool({ name: "read", version: "1", description: "read", input: z.strictObject({}), cancellationGuarantee: "cooperative-exit",
      handler: () => work.promise, output: defineLocalToolOutput({ schema: z.number(), render: () => { renders++; return [{ type: "text", text: "ok" }]; } }) }));
    const prepared = registry.prepare("read", "{}");
    if (!prepared.ok) throw new Error("准备失败");
    const gate = new ToolDispatch<unknown>();
    const result = gate.dispatch((signal) => prepared.call.executeNormalized(signal), { ...prepared.call.governance, executionBoundary });
    gate.cancel();
    work.resolve(1);
    const outcome = await result;
    await Promise.resolve();
    assert.equal(renders, executionBoundary === "local" ? 1 : 0);
    assert.equal(outcome.kind, executionBoundary === "local" ? "completed" : "aborted");
  }
});
