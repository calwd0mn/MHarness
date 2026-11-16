import { z } from "zod";

/** 客户端编号及待受理文本块；会话标识来自路径。 */
export const promptRequestSchema = z.strictObject({
  requestId: z.string().min(1),
  content: z.array(z.strictObject({ type: z.literal("text"), text: z.string() })).min(1),
});
/** 首次受理和已受理编号重发均返回同一确认。 */
export const promptResponseSchema = z.strictObject({ accepted: z.literal(true) });
/** HTTP prompt 请求正文。 */
export type PromptRequest = z.infer<typeof promptRequestSchema>;
/** prompt 受理确认。 */
export type PromptResponse = z.infer<typeof promptResponseSchema>;
