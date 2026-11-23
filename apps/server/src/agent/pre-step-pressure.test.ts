import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "@mharness/session/server";
import type { RequestPressure } from "../model/token-meter.ts";
import type { StepHookContext } from "./model-turn.ts";
import type { TurnCompactionOperations } from "./turn-compaction.ts";
import { runPreStepPressure } from "./pre-step-pressure.ts";

const pressure = (value: number): RequestPressure => ({ status: "measured", inputTokens: value, outputTokens: 0, pressure: value, contextWindow: 100000, threshold: 80000, tailBudget: 16000, triggered: value >= 80000 });
const success = { status: "settled", outcome: "succeeded", attempt: { compactionId: "id", turn: 1 }, summarySeq: 1 } as const;

function fixture(values: RequestPressure[]) {
  const controller = new AbortController();
  let open = true;
  let failure: { value: unknown } | undefined;
  const reports: unknown[] = [];
  const warnings: string[] = [];
  const calls: string[] = [];
  const context = {
    session: new Session({ sessionId: "pressure", createdAt: 1 }), turn: 1, step: 1,
    signal: controller.signal, header: {} as StepHookContext["header"],
    storageOpen: () => open, storageFailure: () => failure,
    blockStorage: (error: unknown) => { reports.push(error); failure ??= { value: error }; open = false; },
  };
  const operations: TurnCompactionOperations = {
    measure: () => { calls.push("measure"); return values.shift() ?? pressure(80000); },
    prune: async () => { calls.push("prune"); return { status: "unchanged" }; },
    summarize: async (budget) => { calls.push(`summary:${budget}`); return success; },
  };
  return { context, controller, operations, warnings, calls, reports, close: (value: unknown) => { failure = { value }; open = false; } };
}

test("阈值边界与修剪后降压", async () => {
  for (const [initial, expected] of [[79999, ["measure"]], [80000, ["measure", "prune", "measure"]]] as const) {
    const f = fixture([pressure(initial), pressure(79999)]);
    await runPreStepPressure(f.context, f.operations, reason => f.warnings.push(reason), 1);
    assert.deepEqual(f.calls, expected);
    assert.deepEqual(f.warnings, []);
  }
});

test("缺预算告警，摘要重测及重试上限", async () => {
  const missing = fixture([{ status: "unavailable", reason: "missing-output-budget" }]);
  await runPreStepPressure(missing.context, missing.operations, reason => missing.warnings.push(reason), 1);
  assert.deepEqual(missing.warnings, ["missing-output-budget"]);
  const f = fixture([pressure(80000), pressure(80000), pressure(80000), pressure(80000)]);
  await runPreStepPressure(f.context, f.operations, reason => f.warnings.push(reason), 1);
  assert.deepEqual(f.calls, ["measure", "prune", "measure", "summary:16000", "measure", "summary:16000", "measure"]);
  assert.equal(f.warnings.length, 1);
  const lowered = fixture([pressure(80000), pressure(80000), pressure(79999)]);
  await runPreStepPressure(lowered.context, lowered.operations, reason => lowered.warnings.push(reason), 1);
  assert.deepEqual(lowered.calls, ["measure", "prune", "measure", "summary:16000", "measure"]);
});

test("无安全范围与普通异常均停止压缩，告警不泄露异常", async () => {
  for (const stage of ["prune", "first", "second", "no-range"] as const) {
    const f = fixture([pressure(80000), pressure(80000), pressure(80000)]);
    let count = 0;
    if (stage === "prune") f.operations.prune = async () => { throw new Error("private"); };
    else f.operations.summarize = async () => {
      count++;
      if (stage === "no-range") return { status: "no-range" };
      if (stage === "first" || count === 2) throw new Error("private");
      return success;
    };
    await runPreStepPressure(f.context, f.operations, reason => f.warnings.push(reason), 1);
    assert.equal(f.warnings.length, stage === "no-range" ? 0 : 1);
    assert.ok(f.warnings.every(reason => !reason.includes("private")));
    if (stage === "second") assert.equal(count, 2);
  }
});

test("存储故障优先于取消并保留 undefined 原值", async () => {
  const f = fixture([pressure(80000)]);
  f.operations.prune = async () => { f.close(undefined); f.controller.abort(); throw new Error("private"); };
  let rejected = false;
  try { await runPreStepPressure(f.context, f.operations, reason => f.warnings.push(reason), 1); } catch (error) { rejected = true; assert.equal(error, undefined); }
  assert.equal(rejected, true);
  assert.deepEqual(f.reports, [undefined]);
  assert.equal(f.warnings.length, 1);
});

test("真实取消阻止后续调用；独立 aborted 属于普通失败", async () => {
  const f = fixture([pressure(80000)]);
  f.operations.prune = async () => { f.controller.abort(); return { status: "unchanged" }; };
  await assert.rejects(runPreStepPressure(f.context, f.operations, reason => f.warnings.push(reason), 1), { name: "AbortError" });
  const independent = fixture([pressure(80000), pressure(80000)]);
  independent.operations.summarize = async () => ({ status: "settled", outcome: "cancelled", attempt: success.attempt, original: { present: false }, source: { status: "model-not-completed", attempt: success.attempt, finishReason: { kind: "aborted" } } } as Awaited<ReturnType<TurnCompactionOperations["summarize"]>>);
  await runPreStepPressure(independent.context, independent.operations, reason => independent.warnings.push(reason), 1);
  assert.equal(independent.warnings.length, 1);
});

test("修剪回滚与摘要结构化失败安全退出", async () => {
  const rolled = fixture([pressure(80000)]);
  rolled.operations.prune = async () => ({ status: "rolled-back", error: new Error("private") });
  await runPreStepPressure(rolled.context, rolled.operations, reason => rolled.warnings.push(reason), 1);
  assert.deepEqual(rolled.warnings, ["prune-failed"]);
  const failed = fixture([pressure(80000), pressure(80000)]);
  failed.operations.summarize = async () => ({ status: "settled", outcome: "failed", attempt: success.attempt, original: { present: false }, source: { status: "model-not-completed", attempt: success.attempt, finishReason: { kind: "aborted" } } } as Awaited<ReturnType<TurnCompactionOperations["summarize"]>>);
  await runPreStepPressure(failed.context, failed.operations, reason => failed.warnings.push(reason), 1);
  assert.deepEqual(failed.warnings, ["summary-failed"]);
});

test("摘要已报告失败后迟到取消仍告警并停止本轮", async () => {
  const f = fixture([pressure(80000), pressure(80000)]);
  f.operations.summarize = async () => {
    f.controller.abort();
    return {
      status: "settled", outcome: "failed", attempt: success.attempt, original: { present: false },
      source: { status: "model-not-completed", attempt: success.attempt, finishReason: { kind: "error", failure: { code: "UNKNOWN", message: "private" } } },
    };
  };
  await assert.rejects(runPreStepPressure(f.context, f.operations, reason => f.warnings.push(reason), 1), { name: "AbortError" });
  assert.deepEqual(f.warnings, ["summary-failed"]);
});

test("待核对关闭准入并保留已有原值", async () => {
  const f = fixture([pressure(80000)]);
  const original = new Error("original");
  f.operations.prune = async () => { f.close(original); return { status: "pending-reconciliation", error: new Error("later") }; };
  await assert.rejects(runPreStepPressure(f.context, f.operations, reason => f.warnings.push(reason), 1), error => error === original);
  assert.ok(f.reports.every(error => error === original));
  assert.deepEqual(f.warnings, ["storage-failed"]);
  assert.deepEqual(f.calls, ["measure"]);
});
