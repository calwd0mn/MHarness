import { z } from "zod";
import { attemptIdentitySchema, attemptOutcomeSchema, sessionRecordSchema } from "./records.ts";

const toolCallChunkData = {
  callId: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
};

export const assistantChunkSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text/delta"), text: z.string() }),
  z.strictObject({ type: z.literal("tool/arguments-delta"), ...toolCallChunkData }),
  z.strictObject({ type: z.literal("tool/call"), ...toolCallChunkData }),
]);

const activeAttemptSchema = attemptIdentitySchema.extend({
  chunks: z.array(assistantChunkSchema),
  nextIndex: z.int().nonnegative(),
});

export const followFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("snapshot"),
    sessionId: z.string().min(1),
    records: z.array(sessionRecordSchema),
    cursor: z.int().nonnegative(),
    assistantStream: z.strictObject({
      revision: z.int().nonnegative(),
      activeAttempt: activeAttemptSchema.optional(),
    }),
  }),
  z.strictObject({ type: z.literal("record"), record: sessionRecordSchema }),
  attemptIdentitySchema.extend({
    type: z.literal("assistant/start"),
    revision: z.int().positive(),
  }),
  z.strictObject({
    type: z.literal("assistant/chunk"),
    revision: z.int().positive(),
    attemptId: z.string().min(1),
    index: z.int().nonnegative(),
    chunk: assistantChunkSchema,
  }),
  z.strictObject({
    type: z.literal("assistant/end"),
    revision: z.int().positive(),
    attemptId: z.string().min(1),
    nextIndex: z.int().nonnegative(),
    outcome: attemptOutcomeSchema,
    recordSeq: z.int().positive(),
  }),
]);

export type AssistantChunk = z.infer<typeof assistantChunkSchema>;
export type FollowFrame = z.infer<typeof followFrameSchema>;
