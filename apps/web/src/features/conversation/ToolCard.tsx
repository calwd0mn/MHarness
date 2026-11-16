import { useState } from "react";
import type { ApprovalResponse } from "../../session/approval.ts";
import { type decideApproval } from "../../session/approval.ts";
import { Approval } from "./Approval.tsx";
import type { ToolView } from "../../session/tools.ts";
import styles from "./ToolCard.module.css";

/** 展示工具调用的已记录参数、结果和可检查元数据。
 * @param props - tool 是同一会话的投影事实，enabled 表示审批可交互，onDecide 负责提交决定。
 * @returns 可展开的工具详情；允许后仅显示等待结果。
 */
export function ToolCard({ tool, sessionId, enabled, onDecide }: { tool: ToolView; sessionId: string; enabled: boolean; onDecide: typeof decideApproval }) {
  const [confirmed, setConfirmed] = useState<ApprovalResponse>();
  const status = tool.result || tool.decision || tool.status === "审批已失效" || !confirmed ? tool.status : confirmed.kind === "decided" && confirmed.outcome === "allowed-once" ? "等待结果" : "审批已结束";
  return <details className={styles.card}><summary>{tool.name} · {status}</summary>
    <dl><dt>原始参数</dt><dd><pre>{tool.rawArguments}</pre></dd>
    {tool.version && <><dt>工具版本</dt><dd>{tool.version}</dd></>}
    {tool.validatedArgs !== undefined && <><dt>已校验参数</dt><dd><pre>{JSON.stringify(tool.validatedArgs, null, 2)}</pre></dd></>}
    {tool.result && <><dt>结果</dt><dd><pre>{JSON.stringify(tool.result, null, 2)}</pre></dd></>}
    </dl>{tool.approval && <Approval key={`${sessionId}:${tool.approval.id}:${tool.operationId}`} onDecide={(outcome) => onDecide(sessionId, tool.approval!.id, outcome)} onConfirmed={setConfirmed} approval={tool.approval} enabled={enabled} decision={tool.decision} closed={Boolean(tool.result) || tool.status === "审批已失效"} />}</details>;
}
