import type { CompactionWriteContext } from "./compaction-lifecycle.ts";
import type { PreparedModel } from "../model/runtime.ts";
import type { ModelTool } from "../model/adapter.ts";
import type { ToolResultPruningConfig } from "./tool-result-pruning.ts";
import type { SessionAppendInput, StagedCommitResult } from "@mharness/session/server";
import { selectToolResultPruning } from "./tool-result-pruning.ts";
import { commitCompactionBatch } from "./compaction-lifecycle.ts";
import { estimateSurfaceMessageTokens } from "../model/token-meter.ts";

/**
 * 在调用方持有运行占用时原子提交当前工具结果的修剪，不执行工具或摘要。
    * @param context - 当前会话及存储准入，修剪内部的前缀检查点或端口拒绝时同步报告原故障。
 * @param prepared - 本次请求使用的固定模型，用于估算原结果。
 * @param tools - 本次请求的工具定义。
 * @param config - 修剪预算和标记；省略时使用默认配置，调用方负责判断触发条件。
 * @param signal - 构建与提交前检查的取消信号；提交开始后不改变持久化结论。
 * @returns 无候选时为 unchanged，否则保留暂存提交的三态结果。
 * @throws 取消、配置无效，或存在候选时准入关闭、构建及校验失败时拒绝。
 */
export async function commitToolResultPruning(context: CompactionWriteContext, prepared: PreparedModel, tools: readonly ModelTool[], config?: ToolResultPruningConfig, signal?: AbortSignal): Promise<StagedCommitResult | { readonly status: "unchanged" }> {
  signal?.throwIfAborted();
  const candidates = selectToolResultPruning(context.session.deriveSurfaceNodes(), config);
  if (!candidates.length) return { status: "unchanged" };
  return commitCompactionBatch(context, () => {
    signal?.throwIfAborted();
    const events: SessionAppendInput[] = [];
    for (const candidate of candidates) {
      const seq = candidate.original.seq;
      events.push({ type: "compaction/prune", data: { shadowedSeq: seq, beforeTokens: estimateSurfaceMessageTokens(prepared, candidate.original.data.message, tools) } });
      events.push({ type: "tool/result", surfaceOp: { op: "replace", start: seq, end: seq }, sourceEventSeqs: [seq], data: candidate.data });
    }
    return events;
  }, { beforeSubmit: () => signal?.throwIfAborted(), onPersistenceError: error => context.blockStorage(error) });
}
