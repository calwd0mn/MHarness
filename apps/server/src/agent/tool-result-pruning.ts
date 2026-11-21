import type { SurfaceNode } from "@mharness/session/server";
/** 当前工具结果及仅更换模型可见内容的候选载荷。 */
export type PruningCandidate = { readonly original: Extract<SurfaceNode, { type: "tool/result" }>; readonly data: Extract<SurfaceNode, { type: "tool/result" }>["data"] };

/** 单个工具结果的文本修剪预算；长度均按 Unicode 码点计算，头尾与标记的合计不得超过阈值。 */
export type ToolResultPruningConfig = Readonly<{
  /** 文本严格超过该正安全整数时才生成候选。 */
  thresholdChars: number;
  /** 保留的头部码点数，须为非负安全整数。 */
  headChars: number;
  /** 保留的尾部码点数，须为非负安全整数。 */
  tailChars: number;
  /** 插入首个删除区间的文本标记。 */
  marker: string;
}>;

/**
 * 校验并固定工具结果修剪配置，避免调用方后续修改生效预算。
 * @param config - 文本码点预算及插入标记。
 * @returns 与输入独立的不可变配置。
 * @throws 预算不是有效安全整数，或保留内容与标记超过阈值时抛出 RangeError。
 */
export function createToolResultPruningConfig(config: ToolResultPruningConfig): ToolResultPruningConfig {
  validateConfig(config);
  return Object.freeze({ ...config });
}

/** 默认修剪预算与插入被删除区间的标记。 */
export const defaultToolResultPruningConfig = createToolResultPruningConfig({
  thresholdChars: 8192, headChars: 4096, tailChars: 1024, marker: "\n\n[... tool result middle pruned ...]\n\n",
});

function countPoints(text: string): number {
  let count = 0;
  for (const _point of text) count++;
  return count;
}

function offsetAt(text: string, count: number): number {
  let offset = 0;
  for (const point of text) {
    if (count-- === 0) break;
    offset += point.length;
  }
  return offset;
}

function validateConfig(config: ToolResultPruningConfig): void {
  const { thresholdChars, headChars, tailChars, marker } = config;
  if (!Number.isSafeInteger(thresholdChars) || thresholdChars < 1 ||
      !Number.isSafeInteger(headChars) || headChars < 0 ||
      !Number.isSafeInteger(tailChars) || tailChars < 0 ||
      headChars + countPoints(marker) + tailChars > thresholdChars) {
    throw new RangeError("工具结果修剪预算无效");
  }
}

/**
 * 从当前 surface 生成超限工具结果的修剪候选，不修改输入或判断触发条件。
 * @param nodes - 按 surface 顺序排列的不可变节点。
 * @param config - 码点预算及标记；省略时使用默认配置。
 * @returns 按原顺序排列的替换候选；没有超限结果时为空。
 * @throws 预算不是有效安全整数，或保留内容与标记超过阈值时抛出 RangeError。
 */
export function selectToolResultPruning(nodes: readonly SurfaceNode[], config: ToolResultPruningConfig = defaultToolResultPruningConfig): readonly PruningCandidate[] {
  validateConfig(config);
  const { thresholdChars, headChars, tailChars, marker } = config;
  const candidates: PruningCandidate[] = [];
  for (const node of nodes) {
    if (node.type !== "tool/result") continue;
    const content = node.data.message.content[0].content;
    const lengths = content.map((block) => block !== null && typeof block === "object" && !Array.isArray(block) && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" ? countPoints(block.text) : undefined);
    const total = lengths.reduce<number>((sum, length) => sum + (length ?? 0), 0);
    if (total <= thresholdChars) continue;
    const output: typeof content[number][] = [];
    let offset = 0;
    let marked = false;
    for (const [index, block] of content.entries()) {
      const length = lengths[index];
      if (length === undefined || block === null || typeof block !== "object" || Array.isArray(block) || !("text" in block) || typeof block.text !== "string") { output.push(block); continue; }
      const start = offset;
      offset += length;
      const headLength = Math.min(length, Math.max(0, headChars - start));
      const tailStart = Math.min(length, Math.max(0, total - tailChars - start));
      const insert = !marked && offset > headChars && start < total - tailChars;
      const head = block.text.slice(0, offsetAt(block.text, headLength));
      const tail = block.text.slice(offsetAt(block.text, tailStart));
      const text = head + (insert ? marker : "") + tail;
      if (insert) marked = true;
      if (text) output.push({ ...block, text });
    }
    const originalResult = node.data.message.content[0];
    candidates.push({ original: node, data: { ...node.data, message: { ...node.data.message, content: [{ ...originalResult, content: output }] } } });
  }
  return candidates;
}
