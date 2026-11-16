import type { RawSessionEventFrame } from "@mharness/session/contracts";
import type { FollowState } from "./follow-controller.ts";

type Message = { key: string; order: number; role: string; text: string; note?: string; reasoning?: string };
/** 根据原始事件和实时草稿构造消息；结算等待期间仅显示草稿。
 * @param state - 当前订阅已安装的事件窗口与活动草稿。
 * @returns 按事件顺序排列的消息；key 用于草稿和正式消息的节点交接，order 用于与工具卡片合并。
 */
export function messages(state: FollowState): Message[] {
  const result: Message[] = [];
  for (const { event } of state.records) {
    if (event.type === "turn/end" && event.data.reason.kind === "error")
      result.push({
        key: `event-${event.seq}`,
        order: event.seq,
        role: "系统",
        text: `本轮失败：${event.data.reason.error.message}`,
      });
    if (
      event.type === "user/message" &&
      event.data.source.kind === "user" &&
      event.surfaceOp === "append"
    )
      result.push({
        key: `event-${event.seq}`,
        order: event.seq,
        role: "你",
        text: event.data.content.map((block) => block.text).join(""),
      });
    if (
      (event.type === "assistant/message" ||
        event.type === "assistant/attempt") &&
      state.draft &&
      event.data.turn === state.draft.turn &&
      event.data.step === state.draft.step
    )
      continue;
    if (event.type === "assistant/message") {
      const text = event.data.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      const reasoning = event.data.message.content.filter((block) => block.type === "reasoning").map((block) => block.text).join("");
      if (text || reasoning)
        result.push({
          key: state.settledNodeIds[event.seq] ?? `event-${event.seq}`,
          order: event.seq,
          role: "助手",
          text,
          reasoning,
        });
    }
    if (event.type === "assistant/attempt" && event.data.text)
      result.push({
        key: state.settledNodeIds[event.seq] ?? `event-${event.seq}`,
        order: event.seq,
        role: "助手",
        text: event.data.text,
        note: event.data.outcome === "cancelled" ? "已取消" : event.data.outcome === "truncated" ? "已截断" : "失败",
      });
  }
  if (state.draft) {
    const text = state.draft.chunks
      .filter((chunk) => chunk.type === "text")
      .map((chunk) => chunk.delta)
      .join("");
    const reasoning = state.draft.chunks.filter((chunk) => chunk.type === "reasoning").map((chunk) => chunk.delta).join("");
    if (text || reasoning)
      result.push({
        key: state.draft.nodeId,
        order: state.records.length,
        role: "助手",
        text,
        note: "正在生成",
        reasoning,
      });
  }
  return result;
}
/** 从最新轮次事件派生当前状态。 */
export function lastTurn(
  records: readonly RawSessionEventFrame[],
): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const event = records[i].event;
    if (event.type === "turn/end")
      return event.data.reason.kind === "error"
        ? `本轮失败：${event.data.reason.error.message}`
        : `本轮结束：${event.data.reason.kind}`;
    if (event.type === "turn/start") return "正在处理";
  }
}
