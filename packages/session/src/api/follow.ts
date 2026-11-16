/** Session follow 流的业务帧契约；跨帧顺序由消费者校验。 */
import { z } from "zod";
import { rawSessionEventFrameSchema } from "./raw-history.ts";
import { sessionParamsSchema } from "./submission.ts";

const position = z.int().nonnegative();
const scope = { turn: z.int().positive(), step: z.int().positive() };
/** 实时分片；工具调用首片包含标识和名称，后续重带时须保持一致。 */
export const assistantChunkSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), delta: z.string() }),
  z.strictObject({ type: z.literal("reasoning"), delta: z.string() }),
  z.strictObject({
    type: z.literal("tool-call-delta"),
    toolIndex: position,
    argumentsDelta: z.string(),
    callId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
  }),
]);
const activeAttemptSchema = z.strictObject({
  attemptId: z.string().min(1),
  ...scope,
  chunks: z.array(assistantChunkSchema),
  nextIndex: position,
});
const identity = { attemptId: z.string().min(1), revision: z.int().positive() };
const streamFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start"), ...identity, ...scope }),
  z.strictObject({
    type: z.literal("chunk"),
    ...identity,
    index: position,
    chunk: assistantChunkSchema,
  }),
  z.strictObject({
    type: z.literal("end"),
    ...identity,
    ...scope,
    index: position,
    outcome: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("committed"),
        eventType: z.enum(["assistant/message", "assistant/attempt"]),
        seq: position,
      }),
      z.strictObject({ kind: z.literal("abandoned") }),
    ]),
  }),
]);
/** 单帧结构校验；快照前缀和实时帧的连续性须由消费者另行校验。 */
export const followFrameSchema = z.discriminatedUnion("type", [
  sessionParamsSchema.extend({
    type: z.literal("snapshot"),
    inheritedEventCount: position,
    cursor: z.int().min(-1),
    records: z.array(rawSessionEventFrameSchema),
    assistantStream: z.strictObject({
      revision: position,
      activeAttempt: activeAttemptSchema.optional(),
    }),
  }),
  rawSessionEventFrameSchema,
  z.strictObject({
    type: z.literal("assistant-stream"),
    frame: streamFrameSchema,
  }),
  z.strictObject({
    type: z.literal("agent/error"),
    turn: z.int().positive(),
    message: z.string(),
  }),
  z.strictObject({
    type: z.literal("error"),
    error: z.strictObject({
      code: z.literal("follow_sync_failed"),
      message: z.string(),
      details: z.union([
        z.strictObject({}),
        z.strictObject({ expectedSeq: position, actualSeq: position }),
      ]),
    }),
  }),
]);
/** 实时 Assistant 片段。 */
export type AssistantChunk = z.infer<typeof assistantChunkSchema>;
/** follow 业务帧，不含 SSE 心跳注释。 */
export type FollowFrame = z.infer<typeof followFrameSchema>;
