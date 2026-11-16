import { useEffect, useRef, useState } from "react";
import { decideApproval, type ApprovalOutcome, type ApprovalResponse } from "./approval.ts";
import { projectTools } from "./tools.ts";
import type { RawSessionEventFrame } from "@mharness/session/contracts";

/** 当前页面保存的单个审批请求状态；unknown 只能重试原决定。 */
export type ApprovalRequestState =
  | { kind: "pending" | "unknown"; outcome: ApprovalOutcome }
  | { kind: "confirmed"; response: Exclude<ApprovalResponse, { kind: "unknown" }> }
  | { kind: "closed" };

type Entry = { state: ApprovalRequestState; token: object };
const identity = (session: string, approval: string, operation: string) => JSON.stringify([session, approval, operation]);

/** 按会话和审批保存请求锁，页面卸载后不更新视图。
 * @returns 读取状态、提交决定和接纳权威事件的方法；切换会话不会取消请求。
 */
export function useApprovals() {
  const entries = useRef(new Map<string, Entry>());
  const mounted = useRef(false);
  const [, render] = useState(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function publish() { if (mounted.current) render((version) => version + 1); }
  /** 按会话、审批及操作身份读取页面内状态；尚无请求时返回 undefined。
   * @param session - 审批所属会话标识。
   * @param approval - 审批标识。
   * @param operation - 审批绑定的操作标识。
   * @returns 当前请求状态，或尚未提交时的 undefined。
   */
  function get(session: string, approval: string, operation: string) {
    return entries.current.get(identity(session, approval, operation))?.state;
  }
  /** 用当前会话的权威事件关闭已结算请求，并使其在途令牌失效。
   * @param session - 事件窗口所属会话。
   * @param records - 按序接纳的完整原始事件窗口。
   */
  function observe(session: string, records: readonly RawSessionEventFrame[]) {
    let changed = false;
    for (const tool of projectTools(records)) {
      if (!tool.approval || !tool.operationId) continue;
      const key = identity(session, tool.approval.id, tool.operationId);
      const existing = entries.current.get(key);
      if (!existing || existing.state.kind === "closed") continue;
      if (tool.decision || tool.result || tool.status === "审批已失效") {
        entries.current.set(key, { state: { kind: "closed" }, token: {} });
        changed = true;
      }
    }
    if (changed) publish();
  }
  /** 对指定审批提交决定；相同身份已有请求或终态时不再发送。
   * @param session - 审批所属会话。
   * @param approval - 审批标识。
   * @param operation - 绑定操作标识，用于隔离替代请求。
   * @param outcome - 单次允许或拒绝；未知结果后仅可重试原决定。
   * @returns 请求及响应处理结束时兑现；卸载页面不取消已发送的后端请求。
   */
  async function submit(session: string, approval: string, operation: string, outcome: ApprovalOutcome) {
    const key = identity(session, approval, operation);
    const previous = entries.current.get(key)?.state;
    if (previous && (previous.kind === "pending" || previous.kind === "confirmed" || previous.kind === "closed" || (previous.kind === "unknown" && previous.outcome !== outcome))) return;
    const token = {};
    entries.current.set(key, { state: { kind: "pending", outcome }, token });
    publish();
    const response = await decideApproval(session, approval, outcome);
    if (entries.current.get(key)?.token !== token) return;
    entries.current.set(key, { state: response.kind === "unknown" ? { kind: "unknown", outcome } : { kind: "confirmed", response }, token });
    publish();
  }
  return { get, observe, submit };
}
