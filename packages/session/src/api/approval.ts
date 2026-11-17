import { z } from "zod";
/** 客户端可提交的审批答复。 */
export const approvalDecisionRequestSchema = z.strictObject({ outcome: z.enum(["allowed-once", "rejected"]) });
/** 已保存的审批决定。 */
export const approvalDecisionSchema = z.strictObject({ id: z.string(), outcome: z.enum(["allowed-once", "rejected", "cancelled", "unavailable"]) });
/** 客户端可提交的决定。 */
export type ApprovalReply = z.infer<typeof approvalDecisionRequestSchema>["outcome"];
/** 已结算的审批结局。 */
export type ApprovalOutcome = z.infer<typeof approvalDecisionSchema>["outcome"];
