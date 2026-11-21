import type { SurfaceNode } from "./session.ts";

type SurfaceToolGroup = Readonly<{
  assistant: number;
  results: readonly number[];
  complete: boolean;
}>;

function callKey(turn: number, step: number, callId: string): string {
  return JSON.stringify([turn, step, callId]);
}

/**
 * 索引当前 surface 中的工具声明和结果，修剪后的结果仍按原调用关联。
 * @param nodes - 按 surface 顺序排列的当前节点。
 * @returns 按 Assistant 位置排列的工具组；位置以 nodes 下标为准，未写齐结果的组标记为未完成。
 */
export function indexSurfaceToolGroups(nodes: readonly SurfaceNode[]): readonly SurfaceToolGroup[] {
  const groups: { assistant: number; results: number[]; expected: number }[] = [];
  const byCall = new Map<string, number[]>();
  for (const [position, node] of nodes.entries()) {
    if (node.type === "assistant/message") {
      const { turn, step, message } = node.data;
      const calls = message.content.filter((block) => block.type === "tool-call");
      if (!calls.length) continue;
      const results: number[] = [];
      for (const call of calls) byCall.set(callKey(turn, step, call.id), results);
      groups.push({ assistant: position, results, expected: calls.length });
    } else if (node.type === "tool/result") {
      const { turn, step, message } = node.data;
      byCall.get(callKey(turn, step, message.source.callId))?.push(position);
    }
  }
  return groups.map(({ assistant, results, expected }) => ({ assistant, results, complete: results.length === expected }));
}

function splitsGroup(group: SurfaceToolGroup, from: number, toExclusive: number): boolean {
  const contains = (position: number) => position >= from && position < toExclusive;
  return contains(group.assistant)
    ? !group.complete || group.results.some((position) => !contains(position))
    : group.results.some(contains);
}

/**
 * 检查替换是否完整保留或覆盖工具组；仅跨过组的跨度不算选中该组。
 * @param groups - 同一 surface 的工具组索引。
 * @param from - 包含的起始节点下标。
 * @param toExclusive - 排除的结束节点下标。
 * @returns 范围内每个触及的工具组都有声明及全部结果时为 true。
 */
export function isCompleteSurfaceToolRange(groups: readonly SurfaceToolGroup[], from: number, toExclusive: number): boolean {
  return groups.every((group) => !splitsGroup(group, from, toExclusive));
}

/**
 * 将旧前缀的右边界向前移动，直到不会留下半个工具组。
 * @param groups - 按 Assistant 位置排列的同一 surface 工具组索引。
 * @param toExclusive - 初选前缀排除的结束下标。
 * @returns 最大安全前缀排除的结束下标，零表示无范围。
 */
export function fitSurfaceToolPrefix(groups: readonly SurfaceToolGroup[], toExclusive: number): number {
  let end = toExclusive;
  // 较新的组回退时可能拆开较旧的组，按声明位置倒序只需检查一次。
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]!;
    if (group.assistant < end && splitsGroup(group, 0, end)) end = group.assistant;
  }
  return end;
}
