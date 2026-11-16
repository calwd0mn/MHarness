/** Session 创建、消息提交与取消的 HTTP 契约。 */
import { z } from "zod";
import { isValidSessionId } from "../session-id.ts";

/** 创建会话无需参数，请求体只接受空对象。 */
export const createSessionRequestSchema = z.strictObject({});

/** 会话标识由服务端分配，须为可无损持久化和传输的非空文本。 */
export const sessionParamsSchema = z.strictObject({
  sessionId: z.string().refine(isValidSessionId, "会话标识无效"),
});

/** 消息在校验时去除首尾空白，去除后必须非空。 */
export const submitMessageRequestSchema = z.strictObject({ text: z.string().trim().min(1) });

/** 取消参数同时定位会话与目标 Turn。 */
export const cancelTurnParamsSchema = sessionParamsSchema.extend({ turnId: z.string().min(1) });

/** 创建成功仅表示空会话已持久化。 */
export const createSessionResponseSchema = sessionParamsSchema;

/** 提交成功表示用户消息和初始 Turn 已持久化，回复尚未完成。 */
export const submitMessageResponseSchema = sessionParamsSchema.extend({ turnId: z.string().min(1) });

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type SessionParams = z.infer<typeof sessionParamsSchema>;
/** 校验后的消息请求，正文已去除首尾空白。 */
export type SubmitMessageRequest = z.infer<typeof submitMessageRequestSchema>;
export type CancelTurnParams = z.infer<typeof cancelTurnParamsSchema>;
