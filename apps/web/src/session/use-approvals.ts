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
  function get(session: string, approval: string, operation: string) {
    return entries.current.get(identity(session, approval, operation))?.state;
  }
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
