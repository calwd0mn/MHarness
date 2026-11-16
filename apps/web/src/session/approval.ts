import { localConfig } from "../../../../config/local.ts";

/** 审批答复只支持单次允许或拒绝。 */
export type ApprovalOutcome = "allowed-once" | "rejected";
/** HTTP 替身适配的答复结果；unknown 表示不能确认服务端是否保存。 */
export type ApprovalResponse = { kind: "decided"; outcome: ApprovalOutcome | "cancelled" | "unavailable" } | { kind: "inactive" | "missing" | "unknown" };

/** 提交指定审批决定；网络失败或无法识别的响应返回 unknown，调用方可用同一决定重试。
 * @param sessionId - 审批所属会话。
 * @param approvalId - 待答复审批的标识。
 * @param outcome - 本次选择的单次决定。
 * @returns 响应解析后的权威决定、失效、不存在或未知结果；兑现不代表工具已经执行。
 */
export async function decideApproval(sessionId: string, approvalId: string, outcome: ApprovalOutcome): Promise<ApprovalResponse> {
  try {
    const result = await fetch(`${localConfig.apiPrefix}/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}/decision`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ outcome }) });
    const data: unknown = await result.json().catch(() => null);
    if (result.status === 404) return { kind: "missing" };
    if (result.status === 409 && typeof data === "object" && data !== null && "code" in data && data.code === "approval_not_active") return { kind: "inactive" };
    if ((result.ok || result.status === 409) && typeof data === "object" && data !== null && "id" in data && data.id === approvalId && "outcome" in data && (data.outcome === "allowed-once" || data.outcome === "rejected" || data.outcome === "cancelled" || data.outcome === "unavailable")) return { kind: "decided", outcome: data.outcome };
  } catch { return { kind: "unknown" }; }
  return { kind: "unknown" };
}
