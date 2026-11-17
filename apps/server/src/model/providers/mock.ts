import { setTimeout } from "node:timers/promises";
import { LlmError } from "../adapter.ts";
import type { LlmFinishReason, ModelAdapter, ModelRequest, StreamBlock, StreamChunk } from "../adapter.ts";

type LegacyChunk =
  | Readonly<{ type: "text" | "reasoning"; delta: string }>
  | Readonly<{ type: "tool_call"; index: number; callId?: string; name?: string; argumentsDelta: string }>
  | Readonly<{ type: "usage"; inputTokens: number; outputTokens: number }>
  | Readonly<{ type: "finish"; reason: Readonly<{ kind: "stop" | "tool_calls" | "output_limit" }> }>;

/** 模拟脚本中的一次产出。delayMs 是本步产出前的等待时间，缺省时立即产出。 */
export type MockStep = Readonly<{ delayMs?: number }> & (
  | Readonly<{ chunk: StreamChunk | LegacyChunk }>
  | Readonly<{ error: LlmError }>
);

/**
 * 创建进程内模拟 Adapter；旧式脚本只作为测试便捷输入，输出始终是统一模型流。
 * 首个事件和后续事件分别受请求等待、流空闲超时限制，取消释放模拟等待。
 * @param script - 每次启动生成时执行一次，返回按交付顺序排列的步骤。
 * @returns 可注册到 LlmRuntime 的模拟 Adapter。
 */
export function createMockAdapter(script: (request: ModelRequest) => readonly MockStep[]): ModelAdapter {
  return {
    async *generate(request, signal) {
      if (signal.aborted) throw new LlmError("ABORTED");
      let timeoutPhase: "request" | "idle" = "request";
      const blocks = new Map<string, { index: number; block: StreamBlock }>();
      for (const step of script(request)) {
        const timeoutMs = timeoutPhase === "request" ? request.timeouts.requestTimeoutMs : request.timeouts.idleTimeoutMs;
        const delayMs = step.delayMs ?? 0;
        if (delayMs > 0) {
          try { await setTimeout(Math.min(delayMs, timeoutMs), undefined, { signal }); }
          catch (error: unknown) { if (signal.aborted) throw new LlmError("ABORTED"); throw error; }
        }
        if (signal.aborted) throw new LlmError("ABORTED");
        if (delayMs >= timeoutMs) throw new LlmError("TIMEOUT", { timeoutPhase });
        if ("error" in step) throw step.error;
        const chunk = step.chunk;
        if (chunk.type === "text" || chunk.type === "reasoning" || chunk.type === "tool_call") {
          const key = chunk.type === "tool_call" ? `tool:${chunk.index}` : chunk.type;
          let state = blocks.get(key);
          if (!state) {
            state = { index: blocks.size, block: chunk.type === "tool_call"
              ? { type: "tool-call", id: "", name: "", arguments: "" }
              : { type: chunk.type, text: "" } };
            blocks.set(key, state);
            yield { type: "block-start", index: state.index, blockType: state.block.type };
          }
          if (chunk.type === "tool_call" && state.block.type === "tool-call") {
            state.block = { ...state.block, id: chunk.callId ?? state.block.id, name: chunk.name ?? state.block.name,
              arguments: state.block.arguments + chunk.argumentsDelta };
            yield { type: "tool-call-delta", index: state.index, ...(chunk.callId === undefined ? {} : { id: chunk.callId }),
              ...(chunk.name === undefined ? {} : { name: chunk.name }), argumentsDelta: chunk.argumentsDelta };
          } else if (chunk.type !== "tool_call" && state.block.type !== "tool-call") {
            state.block = { ...state.block, text: state.block.text + chunk.delta };
            yield { type: chunk.type === "text" ? "text-delta" : "reasoning-delta", index: state.index, text: chunk.delta };
          }
        } else if (chunk.type === "usage" && "inputTokens" in chunk) {
          yield { type: "usage", usage: { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens } };
        } else if (chunk.type === "finish") {
          for (const state of blocks.values()) yield { type: "block-end", index: state.index, block: state.block };
          const reason: LlmFinishReason = chunk.reason.kind === "tool_calls" || chunk.reason.kind === "tool-calls" ? { kind: "tool-calls" } : chunk.reason.kind === "output_limit" || chunk.reason.kind === "max-tokens" ? { kind: "max-tokens" } : chunk.reason.kind === "error" ? { kind: "error", failure: chunk.reason.failure } : chunk.reason.kind === "aborted" ? { kind: "aborted" } : { kind: "stop" };
          yield { type: "finish", reason };
          return;
        } else if (chunk.type === "block-start" || chunk.type === "block-end" || chunk.type === "text-delta" || chunk.type === "reasoning-delta" || chunk.type === "tool-call-delta" || chunk.type === "usage") yield chunk;
        timeoutPhase = "idle";
      }
    },
  };
}
