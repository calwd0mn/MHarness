/** 旧版审批答复契约，供审批能力接管前保留原有定义。 */
import { sessionParamsSchema } from "@mharness/session/contracts";
import { z } from "zod";

/** 旧版审批答复以会话与操作标识共同定位。 */
export const approvalParamsSchema = sessionParamsSchema.extend({ operationId: z.string().min(1) });

/** 校验审批答复的决定值，校验通过只表示请求形状有效。 */
export const decideApprovalRequestSchema = z.strictObject({
  decision: z.enum(["approve", "reject"]),
});

export type ApprovalParams = z.infer<typeof approvalParamsSchema>;
export type DecideApprovalRequest = z.infer<typeof decideApprovalRequestSchema>;
