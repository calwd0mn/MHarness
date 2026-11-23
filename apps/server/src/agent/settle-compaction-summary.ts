import { LlmError } from "../model/adapter.ts";
import { AgentError } from "./react-agent.ts";
import { flushCompaction, type CompactionAttemptContext, type CompactionAttemptIdentity } from "./compaction-lifecycle.ts";
import { commitCompactionSummary, type CommitCompactionSummaryOptions, type CommitCompactionSummaryResult } from "./commit-compaction-summary.ts";

/** 原值可为 undefined；present 用于区分领域拒绝与实际抛出该值。 */
export type CompactionOriginalError = { readonly present: false } | { readonly present: true; readonly value: unknown };

/** 已确认 start 的失败意图，供原占用或可靠前缀恢复使用。 */
export type CompactionSettlementIntent = Readonly<{
  attempt: CompactionAttemptIdentity;
  outcome: "failed" | "cancelled";
  reason: string;
  original: CompactionOriginalError;
}>;

/** 已确认的结局或需要可靠前缀核对的交接。 */
export type CompactionSettlementResult =
  | { readonly status: "no-range" }
  | { readonly status: "settled"; readonly outcome: "succeeded"; readonly attempt: CompactionAttemptIdentity; readonly summarySeq: number }
  | { readonly status: "settled"; readonly outcome: "failed" | "cancelled"; readonly attempt: CompactionAttemptIdentity; readonly original: CompactionOriginalError; readonly source: CommitCompactionSummaryResult }
  | { readonly status: "unsettled"; readonly attempt: CompactionAttemptIdentity; readonly original: CompactionOriginalError; readonly source: CommitCompactionSummaryResult; readonly intent?: CompactionSettlementIntent; readonly storageFailure?: { readonly value: unknown } };

function isCancellation(error: unknown): boolean {
  return (error instanceof LlmError && error.code === "ABORTED") || (error instanceof Error && error.name === "AbortError");
}

/**
 * 在调用方的原占用内执行一次摘要，并为已确认 start 的失败提交独立终态。
 * @param context - 持有占用的会话、准入和取消信号；延后结算时同步锁存存储阻塞。
 * @param options - 固定的业务模型快照和摘要选区参数。
 * @returns 已确认结局、确认无 start，或含原始错误与终态意图的待恢复交接。
 * @throws start 前的本地拒绝以原值传播；关闭的准入会先通知阻塞回调。
 */
export async function settleCompactionSummary(context: CompactionAttemptContext, options: CommitCompactionSummaryOptions): Promise<CompactionSettlementResult> {
  const storageCause = () => {
    const failure = context.storageFailure?.();
    return failure ? failure.value : new AgentError("storage_blocked");
  };
  let source: CommitCompactionSummaryResult;
  try {
    source = await commitCompactionSummary(context, options);
    if (source.status === "no-range") {
      if (!context.storageOpen()) throw storageCause();
      return source;
    }
  } catch (error) {
    if (!context.storageOpen()) context.blockStorage(storageCause());
    throw error;
  }
  if (source.status === "succeeded") return { status: "settled", outcome: "succeeded", attempt: source.attempt, summarySeq: source.summarySeq };

  const original: CompactionOriginalError = source.status === "commit-checkpoint-failed" || source.status === "generation-failed" || source.status === "acceptance-failed" || source.status === "success-commit-failed"
    ? { present: true, value: source.error }
    : source.status === "model-not-completed" && source.adapterError
      ? { present: true, value: source.adapterError.value }
      : { present: false };
  if (source.status === "commit-checkpoint-failed") {
    return { status: "unsettled", attempt: source.attempt, original, source, storageFailure: { value: source.error } };
  }
  const cancelled = source.status === "model-not-completed" ? source.finishReason.kind === "aborted"
    : (source.status === "generation-failed" || source.status === "success-commit-failed") && (source.cancelled === true || isCancellation(source.error));
  const outcome = cancelled ? "cancelled" : "failed";
  const intent: CompactionSettlementIntent = { attempt: source.attempt, outcome, reason: JSON.stringify({ status: outcome, code: cancelled ? "cancelled" : source.status, message: cancelled ? "摘要已取消" : "摘要未完成" }), original };
  const defer = (failure: unknown): CompactionSettlementResult => {
    context.blockStorage(failure);
    return { status: "unsettled", attempt: source.attempt, original, source, intent, storageFailure: { value: failure } };
  };
  if (!context.storageOpen() || context.session.stagedOccupied) return defer(storageCause());
  try {
    context.session.append({ type: "compaction/end", data: { ...intent.attempt, status: intent.outcome, reason: intent.reason } });
  } catch (error) {
    return defer(error);
  }
  try {
    await flushCompaction(context);
  } catch (error) {
    context.blockStorage(error);
    return { status: "unsettled", attempt: source.attempt, original, source, storageFailure: { value: error } };
  }
  return { status: "settled", outcome, attempt: source.attempt, original, source };
}
