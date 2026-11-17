import { z } from "zod";

/** 会话时间使用 Unix 毫秒，记录位置使用从零开始的安全整数。 */
export const sessionPositionSchema = z.number().int().nonnegative();

const turnNumber = z.number().int().positive();
const eventEnvelope = { seq: sessionPositionSchema, time: sessionPositionSchema };
const stepKey = { turn: turnNumber, step: turnNumber };
const route = { provider: z.string().min(1), model: z.string().min(1) };
const recordedModelRouteSchema = z.strictObject({ ...route, endpointId: z.string().min(1).optional() });
const tokenUsage = z.looseObject({ inputTokens: sessionPositionSchema, outputTokens: sessionPositionSchema });
const range = z.strictObject({ start: sessionPositionSchema, end: sessionPositionSchema });
const replacement = z.strictObject({ op: z.literal("replace"), ...range.shape });
const textBlock = z.strictObject({ type: z.literal("text"), text: z.string() });
const toolCallBlock = z.strictObject({
  type: z.literal("tool-call"), id: z.string(), name: z.string(), arguments: z.string(),
});
const assistantContent = z.array(z.discriminatedUnion("type", [
  textBlock,
  z.strictObject({ type: z.literal("reasoning"), text: z.string() }),
  toolCallBlock,
])).refine((blocks) => {
  const ids = blocks.filter((block) => block.type === "tool-call").map((block) => block.id);
  return new Set(ids).size === ids.length;
}, "同一 Assistant 消息的工具调用 ID 必须唯一");

function record<Type extends string, Data extends z.ZodType>(type: Type, data: Data) {
  return { ...eventEnvelope, type: z.literal(type), data };
}

function event<Type extends string, Data extends z.ZodType>(type: Type, data: Data) {
  return z.strictObject(record(type, data));
}

const userMessage = { id: z.string().min(1), role: z.literal("user"), content: z.array(textBlock) };
const turnsWithNoDetail = ["completed", "blocked", "max-tokens", "interrupted"] as const;
const turnReason = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.enum(turnsWithNoDetail) }),
  z.strictObject({ kind: z.literal("aborted"), reason: z.json() }),
  z.strictObject({
    kind: z.literal("error"),
    error: z.looseObject({ code: z.string(), message: z.string() }),
  }),
]);
const generation = {
  reasoningEffort: z.string().optional(), temperature: z.number().optional(),
  maxTokens: turnNumber.optional(), stop: z.array(z.string()).optional(),
};
const requestHeader = z.strictObject({
  header: z.strictObject({
    config: z.strictObject({ ...route, ...generation }),
    adapterDefaults: z.strictObject({
      maxTokens: generation.maxTokens, reasoningEffort: generation.reasoningEffort,
    }).optional(),
    system: z.string().optional(),
    tools: z.array(z.json()).optional(),
  }),
  reason: z.enum(["initial", "resume", "change", "series"]),
  startsSeries: z.literal(true).optional(),
});
const toolResultMessage = z.strictObject({
  id: z.string().min(1),
  role: z.literal("user"),
  source: z.strictObject({ kind: z.literal("tool"), callId: z.string() }),
  content: z.tuple([z.strictObject({
    type: z.literal("tool-result"), toolCallId: z.string(), isError: z.boolean(),
    content: z.array(z.json()),
  })]),
}).refine((message) => message.source.callId === message.content[0].toolCallId, "工具结果调用标识不匹配");

/** 内存日志与重放共用的事件外壳和载荷校验。Assistant 消息和压缩摘要的模型路由只允许可记录的字段。 */
export const sessionEventSchema = z.discriminatedUnion("type", [
  event("turn/start", z.strictObject({ turn: turnNumber })),
  event("turn/end", z.strictObject({ turn: turnNumber, reason: turnReason })),
  event("step/start", z.strictObject(stepKey)),
  event("step/end", z.strictObject(stepKey)),
  event("request/header", requestHeader),
  z.strictObject({
    ...record("user/message", z.union([
      z.strictObject({
        ...userMessage, source: z.strictObject({ kind: z.literal("user") }),
        turn: turnNumber, requestId: z.string().min(1),
      }),
      z.strictObject({
        ...userMessage, source: z.strictObject({ kind: z.literal("compact"), compactionId: z.string() }),
      }),
    ])),
    surfaceOp: z.union([z.literal("append"), replacement]),
    sourceEventSeqs: z.array(sessionPositionSchema).min(1).optional(),
  }).refine((value) => value.data.source.kind === "user"
    ? value.surfaceOp === "append" && value.sourceEventSeqs === undefined
    : value.surfaceOp !== "append" && value.sourceEventSeqs !== undefined,
  "用户输入和摘要使用不同的 surface 操作"),
  z.strictObject({
    ...record("assistant/message", z.strictObject({
      ...stepKey,
      message: z.strictObject({
        id: z.string().min(1), role: z.literal("assistant"),
        source: recordedModelRouteSchema,
        content: assistantContent,
      }),
      finishReason: z.strictObject({ kind: z.enum(["stop", "tool_calls"]) }),
      stream: z.array(z.json()),
      usage: tokenUsage.optional(),
      includeInModelContext: z.literal(true),
    })),
    surfaceOp: z.literal("append"),
  }),
  event("assistant/attempt", z.strictObject({
    ...stepKey,
    outcome: z.enum(["cancelled", "truncated", "failed"]),
    reason: z.json(),
    stream: z.array(z.json()),
    text: z.string().min(1).optional(),
    includeInModelContext: z.literal(false),
  }).refine((attempt) => {
    if (attempt.outcome === "failed") return attempt.text === undefined;
    return attempt.outcome !== "truncated" || attempt.reason === "output_limit";
  }, "失败结算不可附带展示文字，截断结算使用 output_limit")),
  event("tool/call", z.strictObject({
    ...stepKey, callId: z.string(), name: z.string(), arguments: z.string(),
  })),
  event("tool/operation", z.strictObject({
    ...stepKey, callId: z.string(), operationId: z.string(), toolName: z.string(),
    toolVersion: z.string(), validatedArgs: z.json(),
  })),
  z.strictObject({
    ...record("tool/result", z.strictObject({
      ...stepKey, message: toolResultMessage, operationId: z.string().optional(),
      meta: z.json().optional(), error: z.strictObject({ name: z.string(), code: z.string() }).optional(),
    })),
    surfaceOp: z.union([z.literal("append"), replacement]),
    sourceEventSeqs: z.array(sessionPositionSchema).min(1),
  }),
  event("approval/asked", z.strictObject({
    id: z.string(), operationId: z.string(), toolName: z.string(), reason: z.string(), callId: z.string().optional(),
  })),
  event("approval/decided", z.strictObject({
    id: z.string(), outcome: z.enum(["allowed-once", "rejected", "cancelled", "unavailable"]),
    reason: z.string().optional(),
  })),
  event("compaction/start", z.strictObject({
    compactionId: z.string(), turn: turnNumber.nullable(),
  })),
  event("compaction/summary", z.strictObject({
    compactionId: z.string(), summary: z.string(), shadowedRange: range,
    shadowedSeqs: z.array(sessionPositionSchema), route: recordedModelRouteSchema, usage: tokenUsage.optional(),
  })),
  event("compaction/end", z.discriminatedUnion("status", [
    z.strictObject({ compactionId: z.string(), turn: turnNumber.nullable(), status: z.literal("succeeded") }),
    z.strictObject({
      compactionId: z.string(), turn: turnNumber.nullable(),
      status: z.enum(["failed", "cancelled", "interrupted"]), reason: z.json(),
    }),
  ])),
  event("session/end-seed", z.strictObject({ inherited: z.literal(true) })),
]);

type JsonPrimitive = null | boolean | string | number;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type ReadonlyJsonValue = JsonPrimitive | readonly ReadonlyJsonValue[] | { readonly [key: string]: ReadonlyJsonValue };

// 紧凑流和工具元数据可递归嵌套，直接使用只读 JSON 类型，避免编译器反复展开同一结构。
type DeepReadonly<T> = [JsonValue] extends [T]
  ? ReadonlyJsonValue | Exclude<T, JsonValue>
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/** 已接受的独立不可变记录，位置在所属 Session 内从零开始。 */
export type SessionEvent = DeepReadonly<z.infer<typeof sessionEventSchema>>;

type AppendableEvent = Exclude<SessionEvent, { type: "session/end-seed" }>;

/** 进程内写入方提交的事件。省略时间时使用当前 Unix 毫秒，序号及分支标记由 Session 分配。 */
export type SessionAppendInput = {
  [Event in AppendableEvent as Event["type"]]: Omit<Event, "seq" | "time"> & {
    readonly time?: Event["time"];
  };
}[AppendableEvent["type"]];

function invalidJson(): never {
  throw new TypeError("会话事件必须能无损保存为 JSON");
}

function ownData(object: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor?.enumerable || !("value" in descriptor)) return invalidJson();
  return descriptor.value;
}

function copyJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (typeof value !== "object" || ancestors.has(value)) return invalidJson();

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
        return invalidJson();
      }
      return Array.from({ length: value.length }, (_, index) => copyJson(ownData(value, index), ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalidJson();
    return Object.fromEntries(Reflect.ownKeys(value).map((key) => {
      if (typeof key !== "string") return invalidJson();
      return [key, copyJson(ownData(value, key), ancestors)];
    }));
  } finally {
    ancestors.delete(value);
  }
}

/**
 * 取得可无损保存为会话 JSON 的独立数据快照，不执行事件或业务字段校验。
 * @param value - 待记录的 JSON 数据。
 * @returns 脱离输入对象的数据副本。
 * @throws 存在非有限数字、负零、循环、访问器或其他不可无损保存的值时抛出 TypeError。
 */
export function snapshotSessionJson<T>(value: T): T {
  return copyJson(value) as T;
}
function freezeTree(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
}

function assertSessionEvent(value: unknown): asserts value is SessionEvent {
  sessionEventSchema.parse(value);
}

/**
 * 校验候选记录并取得独立的不可变快照。
 * @param candidate - 追加输入，或重放时读取的完整记录。
 * @param seq - 当前日志分配的位置。追加时由日志补入，重放时必须匹配原记录。
 * @param kind - 追加时补入默认时间，重放时保留原时间。
 * @returns 可由内存日志和后续消费者共享的记录。
 * @throws 候选值不能无损表示、事件契约不符或重放位置不连续时抛出。
 */
export function snapshotSessionEvent(candidate: unknown, seq: number, kind: "append" | "replay"): SessionEvent {
  const copied = copyJson(candidate);
  if (copied === null || typeof copied !== "object" || Array.isArray(copied)) {
    throw new TypeError("会话事件必须是对象");
  }
  if (kind === "append") {
    if (Object.hasOwn(copied, "seq")) throw new TypeError("事件序号由会话分配");
    copied.seq = seq;
    if (!Object.hasOwn(copied, "time")) copied.time = Date.now();
  } else if (copied.seq !== seq) {
    throw new RangeError("重放事件序号不连续");
  }
  // 保留已验证的原始 JSON，避免解析器重建对象时丢失工具载荷的自有属性。
  const event: unknown = copied;
  assertSessionEvent(event);
  freezeTree(event);
  return event;
}
