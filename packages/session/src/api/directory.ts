import { z } from "zod";
import { sessionParamsSchema } from "./submission.ts";

const position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sessionId = sessionParamsSchema.shape.sessionId;

/** 目录中的会话摘要；时间为 Unix 毫秒。 */
export const sessionSummarySchema = z.strictObject({
  sessionId, createdAt: position, updatedAt: position, running: z.boolean(), blank: z.boolean(), parentSessionId: sessionId.optional(),
});
/** 同一截点的目录版本和摘要。 */
export const sessionDirectorySnapshotSchema = z.strictObject({ revision: position, sessions: z.array(sessionSummarySchema) });
/** 目录变更帧；每次实际变更占一个实例内版本。 */
export const sessionDirectoryMutationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("api-session/added"), revision: position, summary: sessionSummarySchema }),
  z.strictObject({ type: z.literal("api-session/removed"), revision: position, sessionId, reason: z.literal("creation-failed") }),
  z.strictObject({ type: z.literal("api-session/updated"), revision: position, sessionId, blank: z.literal(false), seq: position }),
  z.strictObject({ type: z.literal("api-session/status"), revision: position, sessionId, running: z.boolean() }),
  z.strictObject({ type: z.literal("api-session/activity"), revision: position, sessionId, updatedAt: position }),
]);
/** 就绪和错误帧不改变目录版本。 */
export const sessionDirectoryFrameSchema = z.union([
  sessionDirectoryMutationSchema,
  z.strictObject({ type: z.literal("api-session/ready") }),
  z.strictObject({ type: z.literal("api-session/error"), sessionId, message: z.string() }),
]);
/** 目录中单个会话的只读摘要。 */
export type SessionSummary = Readonly<z.infer<typeof sessionSummarySchema>>;
/** 一次目录读取的版本和摘要。 */
export type SessionDirectorySnapshot = Readonly<{ revision: number; sessions: readonly SessionSummary[] }>;
/** 带版本的目录变更。 */
export type SessionDirectoryMutation = z.infer<typeof sessionDirectoryMutationSchema>;
/** 目录 SSE 的完整帧类型。 */
export type SessionDirectoryFrame = z.infer<typeof sessionDirectoryFrameSchema>;
