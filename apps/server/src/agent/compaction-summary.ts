import type { LlmFinishReason, ModelInput, ModelRoute, StreamBlock } from "../model/adapter.ts";
import { projectModelMessages, type SurfaceMessage } from "../model/request-projection.ts";
import type { ModelConfig } from "../model/runtime.ts";
import type { CompactionSelection, CompactionWeight } from "./compaction-selection.ts";

const summaryPrompt = `You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.

Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.

## Primary Request and Intent
- [the user's original and evolving goals; quote verbatim where the exact wording matters]

## Key Technical Concepts
- [technologies, frameworks, patterns, and conventions in play]

## Files and Code
- [exact path: why it matters, key changes or snippets]

## Errors and Fixes
- [error: how it was resolved, plus any related user feedback]

## Pending Jobs
- [explicitly requested work not yet completed]

## Current Work
- [precisely what was in progress at this checkpoint]

## Next Step
- [the single next action, directly in line with the most recent request, or "(none)"]

## Critical Context
- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]

Rules:
- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.
- Capture user feedback and explicit instructions faithfully, especially corrections.
- Do NOT mention this summarization request or that the context was compacted.
- Output only the checkpoint text: do not call any tool or take any other action.
- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`;

const checkpointOpening = "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>";
const checkpointClosing = "</compacted-summary>";

/** 开始摘要前固定的模型路由和调用方已确认合法的推理设置。 */
export type FixedCompactionModel = Readonly<{
  route: ModelRoute;
  /** 路由不支持关闭时保留的合法推理值；仅在路由缺省值可用时省略。 */
  reasoningEffort?: string;
  /** 仅在路由明确支持关闭时提供合法关闭值，优先于 reasoningEffort。 */
  disableReasoningEffort?: string;
}>;

/**
 * 只用已捕获的当前前缀准备一次摘要请求，使用专用 system 与空工具列表。
 * 当前缀以 assistant 结束时，额外加入仅属于本次模型输入的 user 指令以开启摘要生成。
 * @param selection - 生成前捕获的完整候选节点，不含保留尾部。
 * @param fixed - 调用方已固定的实际路由和合法推理设置，无需探测 Provider。
 * @returns 可交给模型层的独立配置和输入，8192 是总输出 token 上限；合成指令不属于选区或会话，不会请求模型或访问会话。
 */
export function buildCompactionSummaryRequest(
  selection: CompactionSelection, fixed: FixedCompactionModel,
): { config: ModelConfig; input: ModelInput } {
  const { provider, model, endpointId } = fixed.route;
  const reasoningEffort = fixed.disableReasoningEffort ?? fixed.reasoningEffort;
  const config: ModelConfig = {
    provider, model,
    ...(endpointId === undefined ? {} : { endpointId }),
    params: { maxOutputTokens: 8192, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
  };
  const projected = projectModelMessages(selection.nodes.map((node) => node.type === "user/message" ? node.data : node.data.message));
  const messages = projected.at(-1)?.role === "assistant"
    ? [...projected, { role: "user" as const, text: "Produce the checkpoint for the conversation above using the required structure." }]
    : projected;
  return { config, input: { systemPrompt: summaryPrompt, messages, tools: [] } };
}

/** 已按输出顺序组装的摘要结果；图片标记只用于拒绝无法进入检查点的输出。 */
export type CompactionSummaryOutput = Readonly<{
  finishReason: LlmFinishReason;
  blocks: readonly (StreamBlock | Readonly<{ type: "image" }>)[];
}>;

/** 调用方预先分配的身份；消息 ID 必须是本会话中新分配的 ID。 */
export type CompactionSummaryIdentity = Readonly<{ messageId: string; compactionId: string }>;

type CompactedUserMessage = Extract<SurfaceMessage, { source: { kind: "compact" } }>;

/** 成功返回未包装正文与可供复验的候选消息；拒绝不携带可替换消息。 */
export type CompactionSummaryAcceptance =
  | Readonly<{ status: "accepted"; summary: string; message: CompactedUserMessage }>
  | Readonly<{ status: "rejected"; reason: "not-completed" | "truncated" | "unsupported-image" | "empty-text" | "not-smaller" }>;

/**
 * 只接受已完成且带包装后严格缩小的文本摘要，保留原正文块顺序和空白。
 * @param selection - 生成前捕获的前缀及其业务模型估算值。
 * @param output - 归一化终态和按顺序组装的块；截断、取消、失败及图片不能形成检查点。
 * @param identity - 合成 user 消息的新 ID 和该次摘要的关联 ID。
 * @param weight - 与选择前缀时一致的固定业务投影及节点计量。
 * @returns 未包装正文和合成 user 消息，或具体拒绝原因；不修复格式、不重试、不修改会话。
 */
export function acceptCompactionSummary(
  selection: CompactionSelection, output: CompactionSummaryOutput, identity: CompactionSummaryIdentity, weight: CompactionWeight,
): CompactionSummaryAcceptance {
  const { finishReason, blocks } = output;
  if (finishReason.kind === "aborted" || finishReason.kind === "error") return { status: "rejected", reason: "not-completed" };
  if (finishReason.kind === "max-tokens") return { status: "rejected", reason: "truncated" };
  if (blocks.some((block) => block.type === "image")) return { status: "rejected", reason: "unsupported-image" };

  const body = blocks.flatMap((block) => block.type === "text" ? [{ type: "text" as const, text: block.text }] : []);
  const summary = body.map(({ text }) => text).join("");
  if (summary.trim() === "") return { status: "rejected", reason: "empty-text" };

  const message: CompactedUserMessage = {
    id: identity.messageId,
    role: "user",
    source: { kind: "compact", compactionId: identity.compactionId },
    content: [{ type: "text", text: checkpointOpening }, ...body, { type: "text", text: checkpointClosing }],
  };
  if (weight(message) >= selection.shadowedTokens) return { status: "rejected", reason: "not-smaller" };
  return { status: "accepted", summary, message };
}
