import type { useApprovals } from "../../session/use-approvals.ts";
import { Approval } from "./Approval.tsx";
import type { ToolView } from "../../session/tools.ts";
import styles from "./ToolCard.module.css";

/** 展示工具调用的已记录参数、结果和可检查元数据。
 * @param props - tool 是同一会话的投影事实，enabled 表示审批可交互，approvals 持有跨切换请求状态及提交动作。
 * @returns 可展开的工具详情；允许后仅显示等待结果。
 */
export function ToolCard({ tool, sessionId, enabled, approvals }: { tool: ToolView; sessionId: string; enabled: boolean; approvals: ReturnType<typeof useApprovals> }) {
  const state = tool.approval && tool.operationId ? approvals.get(sessionId, tool.approval.id, tool.operationId) : undefined;
  const confirmed = state?.kind === "confirmed" ? state.response : undefined;
  const status = tool.result || tool.decision || tool.status === "审批已失效" || !confirmed ? tool.status : confirmed.kind === "decided" && confirmed.outcome === "allowed-once" ? "等待结果" : "审批已结束";
  return <details className={styles.card}><summary>{tool.name} · {status}</summary>
    <dl><dt>原始参数</dt><dd><pre>{tool.rawArguments}</pre></dd>
    {tool.version && <><dt>工具版本</dt><dd>{tool.version}</dd></>}
    {tool.validatedArgs !== undefined && <><dt>已校验参数</dt><dd><pre>{JSON.stringify(tool.validatedArgs, null, 2)}</pre></dd></>}
    {tool.result && <><dt>结果</dt><dd><pre>{JSON.stringify(tool.result, null, 2)}</pre></dd></>}
    </dl>{tool.approval && <Approval key={`${sessionId}:${tool.approval.id}:${tool.operationId}`} request={state} onSubmit={(outcome) => void approvals.submit(sessionId, tool.approval!.id, tool.operationId!, outcome)} approval={tool.approval} enabled={enabled} decision={tool.decision} closed={Boolean(tool.result) || tool.status === "审批已失效"} />}</details>;
}
