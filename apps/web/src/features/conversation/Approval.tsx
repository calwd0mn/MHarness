import { type KeyboardEvent } from "react";
import type { ApprovalOutcome } from "../../session/approval.ts";
import type { ApprovalRequestState } from "../../session/use-approvals.ts";
import { Button } from "../../components/ui/Button.tsx";
import type { ToolView } from "../../session/tools.ts";

type ApprovalData = NonNullable<ToolView["approval"]>;

/** 显示审批详情并调用会话控制层的答复动作。
 * @param props - enabled 表示快照可交互；request 是跨会话切换保留的状态，decision 和 closed 来自权威事件。
 * @returns 带键盘操作和状态反馈的审批详情。
 */
export function Approval({ approval, enabled, decision, closed = false, request, onSubmit }: { approval: ApprovalData; enabled: boolean; decision?: ToolView["decision"]; closed?: boolean; request?: ApprovalRequestState; onSubmit: (outcome: ApprovalOutcome) => void }) {
  const pending = request?.kind === "pending";
  const uncertain = request?.kind === "unknown" ? request.outcome : undefined;
  const response = request?.kind === "confirmed" ? request.response : undefined;
  const status = decision ? (decision === "allowed-once" ? "已允许" : decision === "rejected" ? "已拒绝" : "审批已结束") : closed || request?.kind === "closed" ? "审批已失效" : response ? response.kind === "missing" ? "审批不存在" : response.kind === "inactive" ? "审批已失效" : response.kind === "decided" && response.outcome === "allowed-once" ? "已允许" : response.kind === "decided" && response.outcome === "rejected" ? "已拒绝" : "审批已结束" : undefined;
  function submit(outcome: ApprovalOutcome) {
    if (!enabled || status || pending || (uncertain && uncertain !== outcome)) return;
    onSubmit(outcome);
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === "Escape") { event.preventDefault(); submit(event.key === "Enter" ? "allowed-once" : "rejected"); }
  }
  return <div tabIndex={0} onKeyDown={keyboard} aria-label="审批详情"><p>审批原因：{approval.reason}</p>
    {status ? <p role="status">{status}</p> : <><p role="status">{pending ? "正在提交" : uncertain ? "结果未知，请重试相同决定" : enabled ? "等待审批" : "等待同步"}</p>
      <Button disabled={!enabled || pending || uncertain === "rejected"} onClick={() => submit("allowed-once")}>单次允许</Button>
      <Button disabled={!enabled || pending || uncertain === "allowed-once"} onClick={() => submit("rejected")}>拒绝</Button></>}
  </div>;
}
