import type { StepHookContext } from "./model-turn.ts";
import type { CompactionWarning, TurnCompactionOperations } from "./turn-compaction.ts";

/**
 * 对已确认的业务上下文超限执行一次修剪和摘要，并依据持久化替换决定是否重试。
 * @param context - 当前 Step 的固定上下文；调用前须确认失败 Attempt 的普通检查点。
 * @param operations - 与当前 Step 绑定的计量和压缩操作。
 * @param warn - 接收不包含模型原文的稳定告警原因。
 * @returns 仅在已确认替换、代数前进、准入开放且本轮未取消时返回 true。
 * @throws 存储准入关闭或压缩待核对时以已知原始存储故障拒绝，包括 undefined；其他修剪或计量错误向调用方传播。
 */
export async function recoverContextOverflow(context: StepHookContext, operations: TurnCompactionOperations, warn: CompactionWarning): Promise<boolean> {
  const generation = context.session.replaceGeneration;
  const storageFailure = () => context.storageFailure?.();
  const assertStorage = () => {
    if (!context.storageOpen()) {
      const failure = storageFailure();
      const error = failure ? failure.value : new Error("存储准入已关闭");
      context.blockStorage(error);
      throw error;
    }
  };
  assertStorage();
  if (context.signal.aborted) return false;
  let pruning;
  try { pruning = await operations.prune(); }
  catch (error) { assertStorage(); throw error; }
  if (pruning.status === "pending-reconciliation") {
    const failure = storageFailure();
    context.blockStorage(failure ? failure.value : pruning.error);
    const latched = storageFailure();
    throw latched ? latched.value : pruning.error;
  }
  assertStorage();
  if (context.signal.aborted) return false;
  let confirmed = pruning.status === "committed";
  operations.measure();
  assertStorage();
  if (context.signal.aborted) return false;
  let summary;
  try { summary = await operations.summarize(0); }
  catch (error) {
    assertStorage();
    if (!context.signal.aborted) warn("summary-preparation-failed");
    return !context.signal.aborted && confirmed && context.session.replaceGeneration > generation;
  }
  if (summary.status === "unsettled") {
    const failure = storageFailure();
    context.blockStorage(failure ? failure.value : summary.storageFailure?.value);
    const latched = storageFailure();
    throw latched ? latched.value : summary.storageFailure?.value;
  }
  assertStorage();
  if (summary.status === "settled") {
    if (summary.outcome === "succeeded") confirmed = true;
    else if (summary.outcome === "failed") {
      const source = summary.source;
      if (source.status === "rejected" && source.reason === "not-smaller") warn("summary-not-smaller");
      else if (source.status === "model-not-completed" && source.finishReason.kind === "error" && source.finishReason.failure.code === "CONTEXT_WINDOW_EXCEEDED") warn("summary-context-overflow");
      else warn("summary-failed");
    }
  }
  assertStorage();
  return !context.signal.aborted && confirmed && context.session.replaceGeneration > generation;
}
