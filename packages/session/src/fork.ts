import type { SessionEvent } from "./events.ts";

/**
 * 从同一观察截点选择可继承的闭合 Turn 及随后的稳定轮间事件。
 * @param events - 从零连续排列的一次父会话观察前缀。
 * @param atSeq - 可选的非负安全整数事件位置；缺省或超过末条已观察事件时选择最近闭合的 Turn。
 * @returns 排他的截止位置；锚点找不到闭合 Turn 时返回 undefined。
 * @throws 锚点非法时抛出 RangeError。
 */
export function selectForkCut(events: readonly SessionEvent[], atSeq?: number): number | undefined {
  if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq < 0)) {
    throw new RangeError("分支锚点必须是非负安全整数");
  }

  let end: number;
  if (atSeq !== undefined && atSeq < events.length) {
    const start = events.findLastIndex((event) => event.seq <= atSeq && event.type === "turn/start");
    const turn = events[start];
    if (turn?.type !== "turn/start") return undefined;
    end = -1;
    for (let index = start + 1; index < events.length; index++) {
      const event = events[index];
      if (event.type === "turn/start") break;
      if (event.type === "turn/end" && event.data.turn === turn.data.turn) {
        end = index;
        break;
      }
    }
  } else {
    end = events.findLastIndex((event) => event.type === "turn/end");
  }
  if (end < 0) return undefined;

  const pending = new Map<string, number>();
  let cut = end + 1;
  for (; cut < events.length; cut++) {
    const event = events[cut];
    if (event.type === "turn/start") break;
    if (event.type === "compaction/start" && event.data.turn === null) pending.set(event.data.compactionId, cut);
    if (event.type === "compaction/end" && event.data.turn === null) pending.delete(event.data.compactionId);
  }
  return pending.values().next().value ?? cut;
}
