import type { StepHookContext } from "./model-turn.ts";
import type { CompactionWarning, TurnCompactionOperations } from "./turn-compaction.ts";
import { AgentError } from "./react-agent.ts";

/**
 * 在业务 Step 前按当前压力修剪并按需结算摘要，每次成功后重新计量。
 * 普通压缩失败会安全告警并返回；已确认的修改不会回滚。
 * @param context - 当前 Turn 的取消信号和存储准入；存储故障优先于同时发生的取消。
 * @param operations - 绑定本步固定配置、读取当前 surface 的压缩操作。
 * @param warn - 接收不含原始错误或消息内容的原因码。
 * @param compactionRetries - 首次摘要成功后允许的额外摘要次数。
 * @returns 压缩结束或无需压缩后兑现。
 * @throws 存储准入关闭时以已知原值拒绝，当前 Turn 取消时以取消原因拒绝。
 */
export async function runPreStepPressure(context: StepHookContext, operations: TurnCompactionOperations, warn: CompactionWarning, compactionRetries: number): Promise<void> {
  const check = () => {
    if (!context.storageOpen()) {
      const failure = context.storageFailure?.();
      const cause = failure ? failure.value : new AgentError("storage_blocked");
      context.blockStorage(cause);
      throw cause;
    }
    context.signal.throwIfAborted();
  };
  const measured = () => {
    const result = operations.measure();
    if (result.status === "unavailable") warn(result.reason);
    return result;
  };
  try {
    check();
    let result = measured();
    check();
    if (result.status === "unavailable" || !result.triggered) return;
    const pruned = await operations.prune();
    if (pruned.status === "pending-reconciliation") {
      const failure = context.storageFailure?.();
      context.blockStorage(failure ? failure.value : pruned.error);
    }
    check();
    if (pruned.status === "rolled-back") { warn("prune-failed"); return; }
    result = measured();
    check();
    if (result.status === "unavailable" || !result.triggered) return;
    for (let attempt = 0; attempt <= compactionRetries; attempt++) {
      const summary = await operations.summarize(result.tailBudget);
      if (summary.status === "unsettled") {
        const failure = context.storageFailure?.() ?? summary.storageFailure;
        context.blockStorage(failure ? failure.value : new AgentError("storage_blocked"));
      }
      if (summary.status === "settled" && summary.outcome === "failed") {
        if (context.storageOpen()) warn("summary-failed");
        check();
        return;
      }
      check();
      if (summary.status === "no-range") return;
      if (summary.status !== "settled" || summary.outcome !== "succeeded") { warn("summary-failed"); return; }
      result = measured();
      check();
      if (result.status === "unavailable" || !result.triggered) return;
    }
    warn("pressure-remains-high");
  } catch (error) {
    if (!context.storageOpen()) {
      warn("storage-failed");
      check();
    }
    if (context.signal.aborted) context.signal.throwIfAborted();
    warn("compaction-failed");
  }
}
