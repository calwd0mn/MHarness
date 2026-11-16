import { randomUUID } from "node:crypto";
import type { Session } from "@mharness/session/server";
import { ApprovalCheckpointError, ApprovalService } from "../approval/service.ts";
import type { ApprovalOutcome } from "../approval/contracts.ts";
import { ToolDispatch } from "./dispatch.ts";
import type { DispatchOutcome } from "./dispatch.ts";
import { prepareToolOperation } from "./operation.ts";
import { ToolRegistry } from "./registry.ts";
import { HarnessError, normalizeToolError, type ToolResult } from "./result.ts";
import { appendToolResult } from "./result-event.ts";
import { localConfig } from "../../../../config/local.ts";

type Call = { readonly id: string; readonly name: string; readonly arguments: string };
/** 批次结局；结束意向仅供后续 Turn 策略使用。 */
export type ToolBatchOutcome = { kind: "completed"; concludeTurn: boolean } | { kind: "aborted" | "rejected" | "failed" | "timeout" | "read-only-timeout-budget" };

/** 由同一 Turn 的多个批次共享；新 Turn 应创建新的计数器。 */
export type ReadOnlyTimeoutBudget = {
  /** 本轮已发生的只读超时次数，批次执行期间递增。 */
  count: number;
  /** 正安全整数；只读超时次数达到此上限时立即停止本轮。 */
  max: number;
};

function failure(code: string, message: string): ToolResult {
  return { isError: true, error: { message, info: { name: code === "TOOL_TIMEOUT" ? "ToolTimeoutError" : "ToolError", code } }, content: [{ type: "text", text: message }] };
}

/**
 * 按声明顺序执行已提交 Assistant 的工具批次；调用前须先确认该消息通过持久化检查点。
 * @param session - 接收调度和配对结果的在线会话。
 * @param registry - 包含可信工具定义的注册表。
 * @param approvals - 负责持久化审批决定的服务。
 * @param identity - 声明所属 Turn 与 Step。
 * @param calls - Assistant 内容中的有序完整调用。
 * @param signal - 当前 Turn 的取消信号，向审批和工具传播。
 * @param checkpoint - 工具正文前的持久化检查点；失败时拒绝并停止派发。
 * @param onStorageFailure - 审批检查点失败时接收存储原始错误；渠道失败不会调用。
 * @param timeoutBudget - 跨批次累计的只读超时预算；省略时仅在本批累计并使用集中默认上限。
 * @returns 批次终态及成功调用提出的结束意向；不自行推进模型。
 */
export async function runToolBatch(session: Session, registry: ToolRegistry, approvals: ApprovalService, identity: { turn: number; step: number }, calls: readonly Call[], signal: AbortSignal, checkpoint: () => Promise<void>, onStorageFailure?: (error: unknown) => void, timeoutBudget: ReadOnlyTimeoutBudget = { count: 0, max: localConfig.tools.maxReadOnlyTimeouts }): Promise<ToolBatchOutcome> {
  let stop: "aborted" | "rejected" | "failed" | "timeout" | "read-only-timeout-budget" | undefined;
  let concludeTurn = false;
  for (const call of calls) {
    const id = { ...identity, callId: call.id, messageId: randomUUID() };
    if (stop || signal.aborted) {
      stop ??= "aborted";
      appendToolResult(session, id, failure(stop === "aborted" ? "ABORTED_BEFORE_DISPATCH" : "TOOL_NOT_STARTED", stop === "aborted" ? "用户取消，工具尚未派发。" : "工具尚未派发。"));
      continue;
    }
    session.append({ type: "tool/call", data: { ...identity, callId: call.id, name: call.name, arguments: call.arguments } });
    const prepared = prepareToolOperation(session, registry, { ...identity, callId: call.id });
    if (prepared.kind === "settled") continue;
    if (prepared.decision === "ask") {
      let outcome: ApprovalOutcome;
      try { outcome = await approvals.request(session, prepared.operation, "工具需要审批。", signal); }
      catch (error) {
        if (error instanceof ApprovalCheckpointError) onStorageFailure?.(error.cause);
        appendToolResult(session, id, failure("TOOL_NOT_STARTED", "审批未完成，工具尚未派发。"));
        for (const remaining of calls.slice(calls.indexOf(call) + 1)) appendToolResult(session, { ...identity, callId: remaining.id, messageId: randomUUID() }, failure("TOOL_NOT_STARTED", "工具尚未派发。"));
        throw error;
      }
      if (outcome !== "allowed-once") {
        const cancelled = outcome === "cancelled" || signal.aborted;
        appendToolResult(session, id, failure(cancelled ? "ABORTED_BEFORE_DISPATCH" : outcome === "rejected" ? "APPROVAL_REJECTED" : "APPROVAL_UNAVAILABLE", cancelled ? "用户取消，工具尚未派发。" : outcome === "rejected" ? "用户拒绝了工具调用。" : "审批渠道不可用。"));
        if (cancelled) stop = "aborted";
        else if (outcome === "rejected") stop = "rejected";
        continue;
      }
    }
    try { await checkpoint(); }
    catch (error) {
      appendToolResult(session, id, failure("TOOL_NOT_STARTED", "检查点失败，工具尚未派发。"));
      for (const remaining of calls.slice(calls.indexOf(call) + 1)) appendToolResult(session, { ...identity, callId: remaining.id, messageId: randomUUID() }, failure("TOOL_NOT_STARTED", "工具尚未派发。"));
      throw error;
    }
    const gate = new ToolDispatch<ToolResult<unknown>>();
    const cancel = () => gate.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    let outcome: DispatchOutcome<ToolResult<unknown>>;
    try {
      outcome = await gate.dispatch((toolSignal) => prepared.call.executeNormalized(toolSignal), prepared.call.governance);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
    if (outcome.kind === "completed") {
      appendToolResult(session, id, outcome.value);
      if (!outcome.value.isError && outcome.value.concludeTurn) concludeTurn = true;
    } else if (outcome.kind === "aborted") {
      appendToolResult(session, id, failure(outcome.code, outcome.code === "ABORTED" ? "用户取消，工具结果未确认。" : "用户取消，工具尚未派发。"));
      stop = "aborted";
    } else if (outcome.kind === "timeout") {
      appendToolResult(session, id, failure(outcome.code, "等待工具响应超时，最终结果未确认。"));
      if (prepared.call.governance.sideEffect !== "read-only") stop = "timeout";
      else if (++timeoutBudget.count >= timeoutBudget.max) stop = "read-only-timeout-budget";
    } else {
      appendToolResult(session, id, normalizeToolError(outcome.error));
      if (outcome.kind === "dispatch-error" || !(outcome.error instanceof HarnessError)) stop = "failed";
    }
    if (signal.aborted) stop = "aborted";
  }
  return stop ? { kind: stop } : { kind: "completed", concludeTurn };
}
