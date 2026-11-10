import { z } from "zod";

export const attemptIdentitySchema = z.strictObject({
  attemptId: z.string().min(1),
  turnId: z.string().min(1),
  stepId: z.string().min(1),
});

export const attemptOutcomeSchema = z.enum(["completed", "cancelled", "failed", "truncated"]);

const recordHeader = {
  seq: z.int().positive(),
  timestamp: z.iso.datetime(),
};

const turnRef = z.strictObject({ turnId: z.string().min(1) });
/** Turn 的持久状态。只有 running 和 awaiting_approval 占用会话。 */
export const turnStatusDataSchema = turnRef.extend({
  status: z.enum([
    "running",
    "awaiting_approval",
    "succeeded",
    "truncated",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  reason: z.string().min(1).optional(),
});

const toolCallRef = turnRef.extend({
  stepId: z.string().min(1),
  callId: z.string().min(1),
});
const toolCallSchema = z.strictObject({
  callId: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
});

const displayOnlySettlement = attemptIdentitySchema.extend({
  includeInModelContext: z.literal(false),
});

const attemptTerminationSchema = z.discriminatedUnion("outcome", [
  displayOnlySettlement.extend({
    outcome: z.literal("cancelled"),
    text: z.string().min(1).optional(),
  }),
  displayOnlySettlement.extend({
    outcome: z.literal("failed"),
    reason: z.string().min(1),
  }),
  displayOnlySettlement.extend({
    outcome: z.literal("truncated"),
    reason: z.literal("output_limit"),
    text: z.string().min(1).optional(),
  }),
]);

export const sessionRecordSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...recordHeader,
    type: z.literal("user/message"),
    data: turnRef.extend({ text: z.string().min(1) }),
  }),
  z.strictObject({
    ...recordHeader,
    type: z.literal("assistant/message"),
    data: attemptIdentitySchema.extend({
      includeInModelContext: z.literal(true),
      text: z.string(),
      toolCalls: z.array(toolCallSchema),
    }),
  }),
  z.strictObject({
    ...recordHeader,
    type: z.literal("assistant/settled"),
    data: attemptTerminationSchema,
  }),
  z.strictObject({
    ...recordHeader,
    type: z.literal("turn/status"),
    data: turnStatusDataSchema,
  }),
  z.strictObject({
    ...recordHeader,
    type: z.literal("tool/started"),
    data: toolCallRef.extend({ operationId: z.string().min(1) }),
  }),
  z.strictObject({
    ...recordHeader,
    type: z.literal("tool/result"),
    data: toolCallRef.extend({
      status: z.enum(["succeeded", "failed", "cancelled", "unknown"]),
      execution: z.literal("not_started").optional(),
      reason: z.string().min(1).optional(),
      result: z.json().optional(),
      concludeTurn: z.boolean().optional(),
    }),
  }),
  z.strictObject({
    ...recordHeader,
    type: z.literal("approval/requested"),
    data: toolCallRef.extend({
      operationId: z.string().min(1),
      toolName: z.string().min(1),
      toolVersion: z.string().min(1),
      arguments: z.record(z.string(), z.json()),
    }),
  }),
  z.strictObject({
    ...recordHeader,
    type: z.literal("approval/resolved"),
    data: toolCallRef.extend({
      operationId: z.string().min(1),
      status: z.enum(["approved", "rejected", "cancelled"]),
    }),
  }),
]);

export type AttemptOutcome = z.infer<typeof attemptOutcomeSchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
