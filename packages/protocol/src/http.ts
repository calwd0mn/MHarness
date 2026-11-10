import { z } from "zod";
import { sessionRecordSchema, turnStatusDataSchema } from "./records.ts";

export const healthPath = "/health";
export const healthResponseSchema = z.strictObject({ status: z.literal("ok") });

export const createSessionRequestSchema = z.strictObject({});
export const sessionParamsSchema = z.strictObject({ sessionId: z.string().min(1) });
export const submitMessageRequestSchema = z.strictObject({ text: z.string().trim().min(1) });
export const cancelTurnParamsSchema = sessionParamsSchema.extend({ turnId: z.string().min(1) });
export const approvalParamsSchema = sessionParamsSchema.extend({ operationId: z.string().min(1) });
export const decideApprovalRequestSchema = z.strictObject({
  decision: z.enum(["approve", "reject"]),
});

/** 创建成功仅表示空会话已持久化。 */
export const createSessionResponseSchema = sessionParamsSchema;

/** 提交成功表示用户消息和初始 Turn 已持久化，回复尚未完成。 */
export const submitMessageResponseSchema = sessionParamsSchema.extend({ turnId: z.string().min(1) });

/** 读取时的完整持久历史。cursor 为 0 表示无记录，latestTurn 为 null 表示尚无 Turn。 */
export const sessionHistoryResponseSchema = sessionParamsSchema.extend({
  cursor: z.int().nonnegative(),
  records: z.array(sessionRecordSchema),
  latestTurn: turnStatusDataSchema.nullable(),
});

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type SessionParams = z.infer<typeof sessionParamsSchema>;
export type SubmitMessageRequest = z.infer<typeof submitMessageRequestSchema>;
export type CancelTurnParams = z.infer<typeof cancelTurnParamsSchema>;
export type ApprovalParams = z.infer<typeof approvalParamsSchema>;
export type DecideApprovalRequest = z.infer<typeof decideApprovalRequestSchema>;
