import { z } from "zod";

/** 每次显式提交使用新的 UUID；该标识用于关联日志，不表示请求幂等。 */
export const compactRequestSchema = z.strictObject({ compactionId: z.uuid() });
/** 已知业务终态；成功表示服务端已确认批次并等待 flush，不包含摘要正文。 */
export const compactResponseSchema = z.strictObject({
  compactionId: z.uuid(),
  commandId: z.string().min(1),
  status: z.enum(["succeeded", "no_safe_range", "cancelled", "failed"]),
});
/** 入口拒绝不分配命令标识；已识别的忙碌命令须携带服务端标识。 */
export const compactRejectionSchema = z.strictObject({
  commandId: z.union([z.null(), z.string().min(1)]),
  result: z.strictObject({ kind: z.literal("error"), text: z.string() }),
});
/** 压缩接口允许返回的安全错误码。 */
export const compactErrorSchema = z.strictObject({
  code: z.enum(["invalid_request", "session/not-found", "agent_busy", "compaction_id_conflict", "compaction_unavailable", "storage_blocked", "agent_closed", "compaction_internal_error"]),
});
/** 手动压缩请求；标识与压缩事件共用。 */
export type CompactRequest = z.infer<typeof compactRequestSchema>;
/** 手动压缩的已知业务终态。 */
export type CompactResponse = z.infer<typeof compactResponseSchema>;
/** 手动压缩接口的安全错误。 */
export type CompactError = z.infer<typeof compactErrorSchema>;
