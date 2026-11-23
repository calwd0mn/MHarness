import assert from "node:assert/strict";
import { test } from "node:test";
import type { StepHookContext } from "./model-turn.ts";
import type { TurnCompactionOperations } from "./turn-compaction.ts";
import { recoverContextOverflow } from "./context-overflow-recovery.ts";

function fixture() {
  let generation = 0;
  let open = true;
  let failure: { value: unknown } | undefined;
  const controller = new AbortController();
  const calls: string[] = [];
  const warnings: string[] = [];
  const context = {
    session: { get replaceGeneration() { return generation; } }, turn: 1, step: 1,
    signal: controller.signal, storageOpen: () => open,
    storageFailure: () => failure,
    blockStorage: (error: unknown) => { failure ??= { value: error }; open = false; },
  } as unknown as StepHookContext;
  const operations: TurnCompactionOperations = {
    measure: () => { calls.push("measure"); return { status: "unavailable", reason: "missing-context-window" }; },
    prune: async () => { calls.push("prune"); return { status: "unchanged" }; },
    summarize: async (budget) => { calls.push(`summary:${budget}`); return { status: "no-range" }; },
  };
  return { context, operations, calls, warnings, controller, replace: () => { generation++; }, close: (value: unknown) => { failure = { value }; open = false; } };
}

const attempt = { compactionId: "id", turn: 1 } as const;

test("超限始终修剪、重测并以零预算摘要，不以估算值阻止恢复", async () => {
  const f = fixture();
  f.operations.prune = async () => { f.calls.push("prune"); f.replace(); return { status: "committed", events: [] }; };
  assert.equal(await recoverContextOverflow(f.context, f.operations, reason => f.warnings.push(reason)), true);
  assert.deepEqual(f.calls, ["prune", "measure", "summary:0"]);
});

test("只有确认替换且代数前进才授权", async () => {
  for (const mode of ["none", "generation-only", "commit-only"] as const) {
    const f = fixture();
    f.operations.prune = async () => { if (mode === "generation-only") f.replace(); return mode === "commit-only" ? { status: "committed", events: [] } : { status: "unchanged" }; };
    assert.equal(await recoverContextOverflow(f.context, f.operations, () => {}), false, mode);
  }
});

test("修剪回滚后确认摘要可授权；摘要准备异常或独立取消可依赖已确认修剪", async () => {
  for (const mode of ["summary", "throw", "cancelled"] as const) {
    const f = fixture();
    f.operations.prune = async () => { if (mode !== "summary") f.replace(); return mode === "summary" ? { status: "rolled-back", error: new Error() } : { status: "committed", events: [] }; };
    f.operations.summarize = async () => {
      if (mode === "throw") throw new Error("secret");
      if (mode === "summary") { f.replace(); return { status: "settled", outcome: "succeeded", attempt, summarySeq: 2 }; }
      return { status: "settled", outcome: "cancelled", attempt, original: { present: false }, source: { status: "model-not-completed", attempt, finishReason: { kind: "aborted" } } };
    };
    assert.equal(await recoverContextOverflow(f.context, f.operations, reason => f.warnings.push(reason)), true, mode);
    assert.doesNotMatch(JSON.stringify(f.warnings), /secret/);
  }
});

test("待核对和关闭准入保留原始存储错误，即使原值为 undefined 或同时取消", async () => {
  for (const mode of ["pending", "unsettled", "throw"] as const) {
    const f = fixture();
    f.operations.prune = async () => {
      if (mode === "pending") { f.close(undefined); f.controller.abort(); return { status: "pending-reconciliation", error: undefined }; }
      f.replace(); return { status: "committed", events: [] };
    };
    f.operations.summarize = async () => {
      f.close(undefined); f.controller.abort();
      if (mode === "throw") throw new Error("other");
      return { status: "unsettled", attempt, original: { present: false }, source: { status: "selection-changed", attempt }, storageFailure: { value: undefined } };
    };
    let rejected = false;
    try { await recoverContextOverflow(f.context, f.operations, () => {}); } catch (error) { rejected = true; assert.equal(error, undefined); }
    assert.equal(rejected, true, mode);
  }
});

test("取消阻止摘要及重试；摘要超限或未缩小只产生安全告警", async () => {
  const cancelled = fixture();
  cancelled.operations.prune = async () => { cancelled.replace(); cancelled.controller.abort(); return { status: "committed", events: [] }; };
  assert.equal(await recoverContextOverflow(cancelled.context, cancelled.operations, () => {}), false);
  assert.deepEqual(cancelled.calls, []);
  for (const source of [
    { status: "rejected", attempt, reason: "not-smaller" },
    { status: "model-not-completed", attempt, finishReason: { kind: "error", failure: { code: "CONTEXT_WINDOW_EXCEEDED", message: "secret" } } },
  ] as const) {
    const f = fixture();
    f.operations.summarize = async () => ({ status: "settled", outcome: "failed", attempt, original: { present: false }, source });
    assert.equal(await recoverContextOverflow(f.context, f.operations, reason => f.warnings.push(reason)), false);
    assert.equal(f.warnings.length, 1);
    assert.doesNotMatch(JSON.stringify(f.warnings), /secret/);
  }
});

test("低估算及已结算失败不阻止使用已确认修剪", async () => {
  const f = fixture();
  f.operations.measure = () => ({ status: "measured", inputTokens: 60000, outputTokens: 10000, pressure: 70000, contextWindow: 100000, threshold: 80000, tailBudget: 16000, triggered: false });
  f.operations.prune = async () => { f.replace(); return { status: "committed", events: [] }; };
  f.operations.summarize = async budget => {
    assert.equal(budget, 0);
    return { status: "settled", outcome: "failed", attempt, original: { present: false }, source: { status: "selection-changed", attempt } };
  };
  assert.equal(await recoverContextOverflow(f.context, f.operations, reason => f.warnings.push(reason)), true);
  assert.deepEqual(f.warnings, ["summary-failed"]);
});

test("修剪拒绝同时锁存存储故障时保留存储原值", async () => {
  const f = fixture();
  const storage = new Error("storage");
  f.operations.prune = async () => { f.close(storage); f.controller.abort(); throw new Error("other"); };
  await assert.rejects(recoverContextOverflow(f.context, f.operations, () => {}), error => error === storage);
});

test("外部门关闭后仍向本轮锁存原始故障，包括 undefined", async () => {
  for (const value of [undefined, new Error("storage")]) {
    const f = fixture();
    const reported: unknown[] = [];
    const context = { ...f.context, blockStorage: (error: unknown) => { reported.push(error); } };
    f.operations.prune = async () => { f.close(value); return { status: "pending-reconciliation", error: new Error("other") }; };
    let caught = false;
    try { await recoverContextOverflow(context, f.operations, () => {}); } catch (error) { caught = true; assert.equal(error, value); }
    assert.equal(caught, true);
    assert.deepEqual(reported, [value]);
  }
});
