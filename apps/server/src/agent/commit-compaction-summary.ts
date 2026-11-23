import { randomUUID } from "node:crypto";
import type { LlmFinishReason, ModelTool } from "../model/adapter.ts";
import type { LlmRuntime, PreparedModel } from "../model/runtime.ts";
import { estimateSurfaceMessageTokens } from "../model/token-meter.ts";
import { AgentError } from "./react-agent.ts";
import { flushCompaction, runCompactionAttempt, type CompactionAttemptContext, type CompactionAttemptIdentity } from "./compaction-lifecycle.ts";
import { revalidateCompactionSelection, selectCompactionPrefix, type CompactionSelection } from "./compaction-selection.ts";
import { acceptCompactionSummary, buildCompactionSummaryRequest } from "./compaction-summary.ts";

/** 调用方从同一业务快照固定的模型、工具及路由解析器。 */
export type CommitCompactionSummaryOptions = Readonly<{
  /** prepare 必须保持业务路由对应的连接配置，不得重新读取可变配置。 */
  runtime: Pick<LlmRuntime, "prepare">;
  businessModel: PreparedModel;
  businessTools: readonly ModelTool[];
  /** 保留尾部的 token 预算。 */
  retainTokens: number;
  /** 路由明确支持关闭推理时使用的合法值；省略时沿用业务值或适配器缺省值。 */
  disableReasoningEffort?: string;
}>;

/**
 * 单次摘要的持久化、生成和内容结论；失败身份供调用方结算或核对。
 * commit-checkpoint-failed 的 side 指明已在会话接受但尚未确认持久化的 start 或成功批次。
 * model-not-completed 的 adapterError 存在时保留捕获的 Adapter 原值，包含 undefined。
 */
export type CommitCompactionSummaryResult =
  | { readonly status: "no-range" }
  | { readonly status: "commit-checkpoint-failed"; readonly side: "start" | "success"; readonly attempt: CompactionAttemptIdentity; readonly error: unknown }
  | { readonly status: "generation-failed" | "acceptance-failed" | "success-commit-failed"; readonly attempt: CompactionAttemptIdentity; readonly error: unknown; readonly cancelled?: boolean }
  | { readonly status: "model-not-completed"; readonly attempt: CompactionAttemptIdentity; readonly finishReason: Extract<LlmFinishReason, { kind: "error" | "aborted" }>; readonly cancellation?: { readonly present: boolean; readonly value: unknown }; readonly adapterError?: { readonly value: unknown } }
  | { readonly status: "rejected"; readonly attempt: CompactionAttemptIdentity; readonly reason: "empty-text" | "truncated" | "unsupported-image" | "not-smaller" }
  | { readonly status: "selection-changed"; readonly attempt: CompactionAttemptIdentity }
  | { readonly status: "succeeded"; readonly attempt: CompactionAttemptIdentity; readonly summarySeq: number };

/**
 * 在调用方持有的占用内生成一次摘要，并在前缀有效时同步接受整个成功批次，随后等待持久化检查点。
 * @param context - 会话、存储准入及占用所有者的取消信号；存储故障时同步关闭准入。
 * @param options - 同一业务快照的固定模型、工具、路由解析器和保留预算。
 * @returns 无选区、带身份的失败交接或已确认提交的摘要序号；不负责失败终态或恢复。
 * @throws start 前的准入、取消、捕获、准备及本地构建错误以原值拒绝。
 */
export async function commitCompactionSummary(context: CompactionAttemptContext, options: CommitCompactionSummaryOptions): Promise<CommitCompactionSummaryResult> {
  const tools = structuredClone(options.businessTools);
  const weight = (message: Parameters<typeof estimateSurfaceMessageTokens>[1]) => estimateSurfaceMessageTokens(options.businessModel, message, tools);
  let selection: CompactionSelection | undefined;
  let summaryModel: PreparedModel | undefined;
  const started = await runCompactionAttempt(context, () => {
    selection = selectCompactionPrefix(context.session, options.retainTokens, weight);
    if (!selection) return { kind: "no-range" };
    const request = buildCompactionSummaryRequest(selection, {
      route: options.businessModel.route,
      reasoningEffort: options.businessModel.effectiveParams.reasoningEffort,
      disableReasoningEffort: options.disableReasoningEffort,
    });
    summaryModel = options.runtime.prepare(request.config);
    return { kind: "ready", input: request.input, model: summaryModel };
  }, { preserveFailureTerminal: true });
  if (started.status === "no-range" || started.status === "generation-failed") return started;
  if (started.status === "start-not-confirmed") {
    return { status: "commit-checkpoint-failed", side: "start", attempt: started.attempt, error: started.error };
  }
  const { attempt, value } = started;
  if (value.finishReason.kind === "aborted" || value.finishReason.kind === "error") {
    return { status: "model-not-completed", attempt, finishReason: value.finishReason, ...(value.cancellation ? { cancellation: value.cancellation } : {}), ...(value.adapterError ? { adapterError: value.adapterError } : {}) };
  }
  let accepted: ReturnType<typeof acceptCompactionSummary>;
  try {
    accepted = acceptCompactionSummary(selection!, value, { messageId: randomUUID(), compactionId: attempt.compactionId }, weight);
  } catch (error) {
    return { status: "acceptance-failed", attempt, error };
  }
  if (accepted.status === "rejected") {
    if (accepted.reason === "not-completed") throw new Error("摘要终态与接受检查不一致");
    return { status: "rejected", attempt, reason: accepted.reason };
  }
  const chosen = selection!;
  const result = accepted;
  const conflict = Symbol("selection-changed");
  let summarySeq: number;
  let cancelled = false;
  const checkCancellation = () => { if (context.signal.aborted) { cancelled = true; context.signal.throwIfAborted(); } };
  try {
    if (!context.storageOpen() || context.session.stagedOccupied) throw new AgentError("storage_blocked");
    const events = context.session.appendBatch((firstSeq) => {
      checkCancellation();
      if (!revalidateCompactionSelection(context.session, chosen)) throw conflict;
      const sourceCommand = attempt.sourceCommandId === undefined ? {} : { sourceCommandId: attempt.sourceCommandId };
      return [
        { type: "compaction/summary", data: { compactionId: attempt.compactionId, ...sourceCommand, summary: result.summary, shadowedRange: chosen.shadowedRange, shadowedSeqs: [...chosen.shadowedSeqs], route: summaryModel!.route, ...(value.usage ? { usage: value.usage } : {}) } },
        { type: "user/message", data: { ...result.message, ...sourceCommand }, surfaceOp: { op: "replace", ...chosen.shadowedRange }, sourceEventSeqs: [firstSeq, ...chosen.shadowedSeqs] },
        { type: "compaction/end", data: { ...attempt, status: "succeeded" } },
      ];
    });
    summarySeq = events[0]!.seq;
  } catch (error) {
    if (error === conflict) return { status: "selection-changed", attempt };
    return { status: "success-commit-failed", attempt, error, ...(cancelled ? { cancelled: true } : {}) };
  }
  try {
    await flushCompaction(context);
  } catch (error) {
    context.blockStorage(error);
    return { status: "commit-checkpoint-failed", side: "success", attempt, error };
  }
  return { status: "succeeded", attempt, summarySeq };
}
