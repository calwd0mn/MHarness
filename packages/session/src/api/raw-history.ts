import { z } from "zod";
import { sessionPositionSchema, snapshotSessionEvent } from "../events.ts";
import { sessionParamsSchema } from "./submission.ts";

const rawSessionEventSchema = z.unknown().transform((raw, ctx) => {
  try {
    const seq: unknown = typeof raw === "object" && raw !== null
      ? Object.getOwnPropertyDescriptor(raw, "seq")?.value
      : undefined;
    const position = sessionPositionSchema.safeParse(seq);
    if (!position.success) {
      ctx.addIssue({ code: "custom", path: ["seq"], message: "事件位置必须是非负安全整数" });
      return z.NEVER;
    }
    return snapshotSessionEvent(raw, position.data, "replay");
  } catch (error) {
    if (error instanceof z.ZodError) {
      for (const issue of error.issues) ctx.addIssue({ ...issue });
    } else {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "会话事件无效" });
    }
    return z.NEVER;
  }
});

/** 历史与实时传输共用的原始事件封装；解析返回保留自有 JSON 键的不可变事件。 */
export const rawSessionEventFrameSchema = z.strictObject({ type: z.literal("event"), event: rawSessionEventSchema });
/** 完整已提交前缀；空前缀游标为 -1，事件位置从零连续。 */
export const rawSessionHistorySchema = sessionParamsSchema.extend({
  inheritedEventCount: z.int().nonnegative(), cursor: z.int().min(-1),
  records: z.array(rawSessionEventFrameSchema),
}).refine((history) => history.cursor === history.records.length - 1
  && history.records.every((record, index) => record.event.seq === index), "历史必须是连续的完整前缀");
/** 历史与 follow 共用的原始事件帧。 */
export type RawSessionEventFrame = Readonly<z.infer<typeof rawSessionEventFrameSchema>>;
/** 已提交的完整会话历史。 */
export type RawSessionHistory = Readonly<Omit<z.infer<typeof rawSessionHistorySchema>, "records">> & {
  readonly records: readonly RawSessionEventFrame[];
};
