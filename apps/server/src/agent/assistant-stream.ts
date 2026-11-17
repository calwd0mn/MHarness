import { snapshotSessionJson } from "@mharness/session/server";
import { LlmError, type LlmFinishReason } from "../model/adapter.ts";

import type { StreamBlock, StreamChunk } from "../model/stream-types.ts";

type MutableBlock = { type: "text" | "reasoning"; text: string } | { type: "tool-call"; id: string; name: string; arguments: string };
type BlockState = { block: MutableBlock; closed: boolean };

/** 按首次出现顺序组装一次模型请求的内容；首次关闭携带的完整块为最终值。 */
export class BlockAssembler {
  readonly #blocks = new Map<number, BlockState>();
  usage?: { inputTokens: number; outputTokens: number };
  finish?: LlmFinishReason;

  /**
   * 检查并接收一个模型分片；无效分片抛出 PROTOCOL，调用方可以保留安全诊断副本。
   * @param chunk - 本次接收的分片快照。
   * @returns 分片是否仍可发布；已关闭块的后续分片返回 false。
   */
  push(chunk: StreamChunk): boolean {
    if (chunk.type === "usage") {
      if (!Number.isSafeInteger(chunk.usage.inputTokens) || chunk.usage.inputTokens < 0 || !Number.isSafeInteger(chunk.usage.outputTokens) || chunk.usage.outputTokens < 0) throw new LlmError("PROTOCOL");
      this.usage = { ...chunk.usage }; return true;
    }
    if (chunk.type === "finish") { this.finish = chunk.reason; return true; }
    if (!Number.isSafeInteger(chunk.index) || chunk.index < 0 || Object.is(chunk.index, -0)) throw new LlmError("PROTOCOL");
    const state = this.#blocks.get(chunk.index);
    if (chunk.type === "block-start") {
      if (state) throw new LlmError("PROTOCOL");
      this.#blocks.set(chunk.index, { closed: false, block: chunk.blockType === "tool-call"
        ? { type: "tool-call", id: "", name: "", arguments: "" }
        : { type: chunk.blockType, text: "" } });
      return true;
    }
    if (!state) throw new LlmError("PROTOCOL");
    if (state.closed) return false;
    if (chunk.type === "block-end") {
      if (chunk.block.type !== state.block.type) throw new LlmError("PROTOCOL");
      if (chunk.block.type === "tool-call" && state.block.type === "tool-call" &&
          ((state.block.id && state.block.id !== chunk.block.id) || (state.block.name && state.block.name !== chunk.block.name) ||
           typeof chunk.block.arguments !== "string")) throw new LlmError("PROTOCOL");
      state.block = { ...chunk.block };
      state.closed = true;
      return true;
    }
    if (chunk.type === "tool-call-delta") {
      if (state.block.type !== "tool-call") throw new LlmError("PROTOCOL");
      if ((!state.block.id && !chunk.id) || (!state.block.name && !chunk.name)) throw new LlmError("PROTOCOL");
      if ((chunk.id !== undefined && state.block.id && chunk.id !== state.block.id) ||
          (chunk.name !== undefined && state.block.name && chunk.name !== state.block.name)) throw new LlmError("PROTOCOL");
      if (chunk.id !== undefined) state.block.id = chunk.id;
      if (chunk.name !== undefined) state.block.name = chunk.name;
      state.block.arguments += chunk.argumentsDelta;
      return true;
    }
    if (state.block.type !== (chunk.type === "text-delta" ? "text" : "reasoning")) throw new LlmError("PROTOCOL");
    state.block.text += chunk.text;
    return true;
  }

  /** 已组装内容，按块首次出现顺序返回独立副本。 */
  get content(): StreamBlock[] { return [...this.#blocks.values()].map(({ block }) => ({ ...block })); }
  /** 工具块是否均已关闭、具有非空标识和名称，且标识互不重复。 */
  get completeTools(): boolean {
    const tools = [...this.#blocks.values()].filter((state) => state.block.type === "tool-call");
    const ids = tools.map(({ block }) => block.type === "tool-call" ? block.id : "");
    return tools.length > 0 && new Set(ids).size === ids.length && tools.every(({ block, closed }) =>
      closed && block.type === "tool-call" && Boolean(block.id && block.name));
  }
}

/** 按接收时刻保存独立分片，展开记录可恢复边界、顺序和相对时间。 */
export class AssistantStreamAccumulator {
  readonly #started = Date.now();
  readonly #entries: { time: number; chunk: StreamChunk }[] = [];

  /**
   * 保存当前分片的独立快照。
   * @param chunk - 调用方交付的模型分片。
   * @returns 脱离调用方对象的同一份快照。
   */
  push(chunk: StreamChunk): StreamChunk {
    const snapshot = snapshotSessionJson(chunk);
    this.#entries.push({ time: Math.max(0, Date.now() - this.#started), chunk: snapshot });
    return snapshot;
  }
  /** 按原边界返回本次已记录的分片和相对毫秒。 */
  get stream(): ({ time: number; chunk: StreamChunk } | { chunks: { time: number; chunk: StreamChunk }[] })[] {
    const result: ({ time: number; chunk: StreamChunk } | { chunks: { time: number; chunk: StreamChunk }[] })[] = [];
    for (const entry of structuredClone(this.#entries)) {
      const previous = result.at(-1);
      const last = previous && "chunks" in previous ? previous.chunks.at(-1) : previous;
      const chunk = entry.chunk;
      if ((chunk.type === "text-delta" || chunk.type === "reasoning-delta" || chunk.type === "tool-call-delta") &&
          last?.chunk.type === chunk.type && "index" in last.chunk && last.chunk.index === chunk.index) {
        if (previous && "chunks" in previous) previous.chunks.push(entry);
        else if (last) result.splice(result.length - 1, 1, { chunks: [last, entry] });
      } else result.push(entry);
    }
    return result;
  }
}

/** 一次模型请求的内部观察帧；chunk 索引包括所有已发布的模型分片。 */
export type AssistantStreamFrame =
  | { type: "assistant/start"; attemptId: string; turn: number; step: number }
  | { type: "assistant/chunk"; attemptId: string; index: number; chunk: StreamChunk }
  | { type: "assistant/end"; attemptId: string; turn: number; step: number; index: number;
      outcome: { kind: "committed"; eventType: "assistant/message" | "assistant/attempt"; seq: number } | { kind: "abandoned" } };

/** 管理一次请求的聚合和发布；每个已开始的实例最多发布一个结束帧。 */
export class AssistantStreamAttempt {
  readonly accumulator = new AssistantStreamAccumulator();
  readonly assembler = new BlockAssembler();
  #started = false;
  #ended = false;
  #index = 0;

  /**
   * 创建独立请求尝试，调用方在取得流并检查取消后启动发布。
   * @param attemptId - 当前 Agent 生命周期内唯一的标识。
   * @param turn - 所属 Turn。
   * @param step - 所属 Step。
   * @param publish - 同步发布内部观察帧的函数。
   */
  constructor(readonly attemptId: string, readonly turn: number, readonly step: number,
    readonly publish: (frame: AssistantStreamFrame) => void) {}

  /** 发布开始帧。 */
  start(): void {
    if (this.#started || this.#ended) throw new Error("Attempt 已开始或结束");
    this.#started = true;
    this.publish({ type: "assistant/start", attemptId: this.attemptId, turn: this.turn, step: this.step });
  }

  /**
   * 将同一分片快照写入记录和组装器，校验通过后发布。
   * @param chunk - 本次模型流分片。
   * @throws 内容块协议无效时抛出 LlmError；可安全记录的分片仍保留在诊断流中。
   */
  push(chunk: StreamChunk): void {
    if (!this.#started || this.#ended) throw new Error("Attempt 不在发布中");
    let snapshot: StreamChunk;
    try { snapshot = this.accumulator.push(chunk); }
    catch { throw new LlmError("PROTOCOL"); }
    if (!this.assembler.push(snapshot)) return;
    this.publish({ type: "assistant/chunk", attemptId: this.attemptId, index: this.#index++, chunk: snapshot });
  }

  /**
   * 追加结算事件；追加成功后发布引用该事件的结束帧。
   * @param append - 同步追加并返回结算事件引用的操作。
   * @returns 已追加的结算事件引用。
   * @throws 追加失败时传播错误，由调用方执行 abandon。
   */
  commit<T extends { type: "assistant/message" | "assistant/attempt"; seq: number }>(append: () => T): T {
    if (!this.#started || this.#ended) throw new Error("Attempt 不在发布中");
    const event = append();
    this.#ended = true;
    this.publish({ type: "assistant/end", attemptId: this.attemptId, turn: this.turn, step: this.step,
      index: this.#index, outcome: { kind: "committed", eventType: event.type, seq: event.seq } });
    return event;
  }

  /** 已开始但未结算时发布一次 abandoned；未开始或已结束时无操作。 */
  abandon(): void {
    if (!this.#started || this.#ended) return;
    this.#ended = true;
    this.publish({ type: "assistant/end", attemptId: this.attemptId, turn: this.turn, step: this.step,
      index: this.#index, outcome: { kind: "abandoned" } });
  }
}
