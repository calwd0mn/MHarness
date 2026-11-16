import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { type ApprovalResponse, type ApprovalOutcome } from "../../session/approval.ts";
import { Button } from "../../components/ui/Button.tsx";
import type { ToolView } from "../../session/tools.ts";

type Outcome = ApprovalOutcome;
type ApprovalData = NonNullable<ToolView["approval"]>;

/** 显示审批详情并通过回调答复；网络不确定时仅允许重试原决定。
 * @param props - enabled 表示快照可交互；decision 和 closed 由权威事件提供，onDecide 返回适配结果。
 * @returns 带键盘操作和状态反馈的审批详情；卸载或结算后的迟到回调不更新视图。
 */
export function Approval({ approval, enabled, decision, closed = false, onDecide, onConfirmed }: { approval: ApprovalData; enabled: boolean; decision?: ToolView["decision"]; closed?: boolean; onDecide: (outcome: Outcome) => Promise<ApprovalResponse>; onConfirmed?: (result: ApprovalResponse) => void }) {
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState<Outcome>();
  const [response, setResponse] = useState<string>();
  const lock = useRef(false);
  const generation = useRef(0);
  const active = useRef(true);
  active.current = !closed && !decision;
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { if (decision || closed) { generation.current++; lock.current = false; setPending(false); } }, [decision, closed]);
  async function submit(outcome: Outcome) {
    if (!enabled || closed || decision || response || lock.current || (uncertain && uncertain !== outcome)) return;
    lock.current = true;
    setPending(true);
    const request = ++generation.current;
    try {
      const result = await onDecide(outcome);
      if (request !== generation.current || !active.current) return;
      if (result.kind !== "unknown") onConfirmed?.(result);
      if (result.kind === "missing") setResponse("审批不存在");
      else if (result.kind === "inactive") setResponse("审批已失效");
      else if (result.kind === "decided") setResponse(result.outcome === "allowed-once" ? "已允许" : result.outcome === "rejected" ? "已拒绝" : "审批已结束");
      else setUncertain(outcome);
    } catch { if (request === generation.current && active.current) setUncertain(outcome); }
    finally { if (request === generation.current) { lock.current = false; setPending(false); } }
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === "Escape") { event.preventDefault(); void submit(event.key === "Enter" ? "allowed-once" : "rejected"); }
  }
  const status = decision ? (decision === "allowed-once" ? "已允许" : decision === "rejected" ? "已拒绝" : "审批已结束") : closed ? "审批已失效" : response;
  return <div tabIndex={0} onKeyDown={keyboard} aria-label="审批详情"><p>审批原因：{approval.reason}</p>
    {status ? <p role="status">{status}</p> : <><p role="status">{pending ? "正在提交" : uncertain ? "结果未知，请重试相同决定" : enabled ? "等待审批" : "等待同步"}</p>
      <Button disabled={!enabled || pending || uncertain === "rejected"} onClick={() => void submit("allowed-once")}>单次允许</Button>
      <Button disabled={!enabled || pending || uncertain === "allowed-once"} onClick={() => void submit("rejected")}>拒绝</Button></>}
  </div>;
}

