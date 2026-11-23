import type { StagedCommitResult } from "@mharness/session/server";
import { measureRequestPressure, type RequestPressure } from "../model/token-meter.ts";
import type { LlmRuntime } from "../model/runtime.ts";
import type { CommitCompactionSummaryOptions } from "./commit-compaction-summary.ts";
import { commitToolResultPruning } from "./commit-tool-result-pruning.ts";
import type { CompactionAttemptContext } from "./compaction-lifecycle.ts";
import type { StepHookContext } from "./model-turn.ts";
import type { StepSnapshot } from "./request-context.ts";
import type { CompactionSettlementResult } from "./settle-compaction-summary.ts";

/** 接收稳定的原因码，供压缩策略记录安全诊断。 */
export type CompactionWarning = (reason: string) => void;

/** 在原 Turn 占用内执行摘要，并保留待恢复的终态意图。 */
export type TurnCompactionSettlement = (context: CompactionAttemptContext, options: CommitCompactionSummaryOptions) => Promise<CompactionSettlementResult>;

/** 两个自动入口共用本步模型快照，每次操作读取当前 surface。 */
export interface TurnCompactionOperations {
  /** 重新计量当前请求，容量缺失时交付原因。 */
  measure(): RequestPressure;
  /** 尝试一次修剪，返回已确认或待核对的暂存结论。 */
  prune(): Promise<StagedCommitResult | { readonly status: "unchanged" }>;
  /** 按保留 token 预算结算一次摘要，保留失败或持久化待核对的信息。 */
  summarize(retainTokens: number): Promise<CompactionSettlementResult>;
}

/**
 * 绑定本 Step 的压缩操作，使用固定模型计量最新 surface，摘要复用同一路由和 Adapter。
 * @param context - 本轮会话、取消及压缩写入准入，调用方负责在原 Step 内等待操作。
 * @param fixed - 业务模型、system 和工具快照。
 * @param runtime - 固定业务模型所归属的 Runtime。
 * @param settle - Agent 的摘要结算入口。未提供时仍可计量和修剪，摘要会拒绝。
 * @returns 供当前 Step 的等待点使用的操作。
 */
export function createTurnCompactionOperations(
  context: StepHookContext,
  fixed: StepSnapshot,
  runtime: LlmRuntime,
  settle?: TurnCompactionSettlement,
): TurnCompactionOperations {
  const { session, signal } = context;
  const { prepared, header, tools } = fixed;
  return {
    measure: () => measureRequestPressure(prepared, {
      systemPrompt: header.system ?? "", tools, messages: session.deriveMessages(),
    }),
    prune: () => commitToolResultPruning(context, prepared, tools, undefined, signal),
    async summarize(retainTokens) {
      if (!settle) throw new Error("当前 Turn 未绑定摘要结算");
      return settle(context, {
        runtime: { prepare: config => runtime.prepareForSameRoute(prepared, config) },
        businessModel: prepared, businessTools: tools, retainTokens,
        disableReasoningEffort: prepared.disableReasoningEffort,
      });
    },
  };
}
