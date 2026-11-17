import type { LlmFinishReason } from "./adapter.ts";

/** 单次生成中以块索引关联的完整内容。 */
export type StreamBlock =
  | Readonly<{ type: "text" | "reasoning"; text: string }>
  | Readonly<{ type: "tool-call"; id: string; name: string; arguments: string }>;

/** Adapter、Runtime 与 Attempt 共同使用的模型分片。 */
export type StreamChunk =
  | Readonly<{ type: "block-start"; index: number; blockType: StreamBlock["type"] }>
  | Readonly<{ type: "text-delta" | "reasoning-delta"; index: number; text: string }>
  | Readonly<{ type: "tool-call-delta"; index: number; id?: string; name?: string; argumentsDelta: string }>
  | Readonly<{ type: "block-end"; index: number; block: StreamBlock }>
  | Readonly<{ type: "usage"; usage: Readonly<{ inputTokens: number; outputTokens: number }> }>
  | Readonly<{ type: "finish"; reason: LlmFinishReason }>;
