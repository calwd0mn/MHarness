import type { RawSessionEventFrame } from "@mharness/session/contracts";
import type { FollowState } from "./follow-controller.ts";

type Message = { key: string; order: number; role: string; text: string; note?: string; reasoning?: string };
type CommandCard = { id: string; order: number; name: string; args?: string; result: string; summary?: string };

/**
 * 从已安装的共享日志投影命令卡；继承记录缺少结果时不推断仍在执行，纯空白结果使用结局默认文本。
 * @param state - 当前订阅窗口及继承边界。
 * @returns 以运行记录顺序排列的独立命令卡。
 */
export function commandCards(state: FollowState): CommandCard[] {
  const cards = new Map<string, CommandCard>();
  const settled = new Set<string>();
  for (const { event } of state.records) {
    if (event.type === "command/run") {
      cards.set(event.data.commandId, { id: event.data.commandId, order: event.seq, name: event.data.name, args: event.data.args,
        result: event.seq < state.inheritedEventCount ? "结果未记录" : state.status === "ready" ? "执行中" : "结果未知" });
    } else if (event.type === "command/done") {
      const card = cards.get(event.data.commandId);
      if (card) { card.result = event.data.text?.trim() ? event.data.text : (event.data.kind === "success" ? "已完成" : "执行失败"); settled.add(event.data.commandId); }
    } else if (event.type === "compaction/summary" && event.data.sourceCommandId) {
      const card = cards.get(event.data.sourceCommandId);
      if (card) card.summary = event.data.summary;
    } else if (event.type === "compaction/end" && event.data.sourceCommandId) {
      const card = cards.get(event.data.sourceCommandId);
      if (card && !settled.has(event.data.sourceCommandId)) card.result = { succeeded: "已压缩", failed: "压缩失败", cancelled: "压缩已取消", interrupted: "压缩已中断" }[event.data.status];
    }
  }
  return [...cards.values()];
}
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
      state.draft?.pendingSeq !== undefined &&
      event.seq === state.draft.pendingSeq
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
    if (event.type === "assistant/attempt" && !event.data.text)
      result.push({
        key: state.settledNodeIds[event.seq] ?? `event-${event.seq}`,
        order: event.seq,
        role: "系统",
        text: event.data.outcome === "cancelled" ? "助手尝试已取消" : event.data.outcome === "truncated" ? "助手尝试已截断" : "助手尝试失败",
      });
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
