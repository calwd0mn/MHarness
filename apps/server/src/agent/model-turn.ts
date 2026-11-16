import { localConfig } from "../../../../config/local.ts";
import { randomUUID } from "node:crypto";
import type { Session } from "@mharness/session/server";
import { LlmError } from "../model/adapter.ts";
import type {
  LlmChunk,
  LlmFinishReason,
  ModelTool,
} from "../model/adapter.ts";
import type { LlmRuntime, ModelConfig } from "../model/runtime.ts";
import { createRequestPreparer } from "./request-context.ts";
import { ApprovalService } from "../approval/service.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { runToolBatch } from "../tools/batch.ts";
import { appendToolResult } from "../tools/result-event.ts";

/** 供会话观察层同步发布的 Attempt 增量；实时版本由观察层分配。 */
export type ExecutionNotice =
  | { type: "assistant/start"; attemptId: string; turn: number; step: number }
  | {
      type: "assistant/chunk";
      attemptId: string;
      index: number;
      chunk: StreamChunk;
    }
  | {
      type: "assistant/end";
      attemptId: string;
      turn: number;
      step: number;
      index: number;
      outcome:
        | {
            kind: "committed";
            eventType: "assistant/message" | "assistant/attempt";
            seq: number;
          }
        | { kind: "abandoned" };
    }
  | { type: "agent/error"; turn: number; message: string };

type StreamChunk =
  | { type: "text" | "reasoning"; delta: string }
  | {
      type: "tool-call-delta";
      toolIndex: number;
      callId?: string;
      name?: string;
      argumentsDelta: string;
    };
/** 一次已受理 Turn 的运行上下文。publish 同步交付实时通知，blockStorage 阻止故障后继续受理。 */
export type ModelTurnContext = {
  /** 已接受本轮输入并绑定持久化检查点的会话。 */
  session: Session;
  /** 会话内从 1 开始的轮次。 */
  turn: number;
  /** 本次请求所在的步骤，从 1 开始。 */
  step: number;
  /** 取消当前请求；不代表远端已停止。 */
  signal: AbortSignal;
  /** 同步交付实时通知；事件日志由 Session 独立发布。 */
  publish: (notice: ExecutionNotice) => void;
  /** 检查点失败时阻止会话继续受理新任务。 */
  blockStorage: (error: unknown) => void;
};
/** 模型驱动的配置供应者；每次请求开始时取一次快照。 */
export type ModelTurnOptions = {
  /** 负责归一模型配置并生成统一流。 */
  runtime: LlmRuntime;
  /** 每次请求读取配置；无法记录的 endpointId 或生效 topP 会在生成前拒绝。 */
  config: () => ModelConfig;
  /** 每次请求读取系统提示词，并与模型配置一同记录。 */
  systemPrompt: () => string;
  /** 每次请求读取的模型可见工具定义。 */
  tools?: () => readonly ModelTool[];
  /** 每轮最多发起的模型步数，须为正安全整数；默认使用集中配置。 */
  maxSteps?: number;
  /** 提供可信工具定义和正文；未配置时工具调用不派发。 */
  toolRegistry?: ToolRegistry;
  /** 审批服务；未提供时审批渠道不可用。 */
  approvalService?: ApprovalService;
};

type Content = (
  | { type: "text" | "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; arguments: string }
)[];

function compact(entries: { time: number; chunk: LlmChunk }[]) {
  const result: (
    | { time: number; chunk: LlmChunk }
    | { chunks: { time: number; chunk: LlmChunk }[] }
  )[] = [];
  for (const entry of entries) {
    const mergeable =
      entry.chunk.type === "text" ||
      entry.chunk.type === "reasoning" ||
      entry.chunk.type === "tool_call";
    const previous = result.at(-1);
    const last =
      previous && "chunks" in previous
        ? previous.chunks.at(-1)
        : previous && "chunk" in previous
          ? previous
          : undefined;
    if (
      mergeable &&
      last?.chunk.type === entry.chunk.type &&
      (entry.chunk.type !== "tool_call" ||
        (last.chunk.type === "tool_call" &&
          last.chunk.index === entry.chunk.index))
    ) {
      if (previous && "chunks" in previous) previous.chunks.push(entry);
      else if (last)
        result.splice(result.length - 1, 1, { chunks: [last, entry] });
    } else result.push(entry);
  }
  return result;
}
/**
 * 创建有限步数的 Turn 驱动，检查点成功后启动模型并结算每个 Step。
 * 未配置工具注册表时工具调用追加 TOOL_NOT_STARTED 并以 blocked 结束；耗尽步数时不再派发。
 * @param options - Runtime 及每次请求读取的配置和系统提示词。
 * @returns 可注入 Agent 的异步驱动；取消信号传给当前模型请求和工具批次。
 */
export function createModelTurnDriver(
  options: ModelTurnOptions,
): (context: ModelTurnContext) => Promise<void> {
  const maxSteps = options.maxSteps ?? localConfig.model.maxSteps;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1)
    throw new RangeError("maxSteps must be a positive safe integer");
  const prepareRequest = createRequestPreparer({ ...options, tools: options.tools ?? (options.toolRegistry ? () => options.toolRegistry!.definitions() : undefined) });
  const approvals = options.approvalService ?? new ApprovalService(null);
  return async ({
    session,
    turn,
    step: initialStep,
    signal,
    publish,
    blockStorage,
  }) => {
    let step = initialStep;
    let turnReason:
      | { kind: "completed" | "max-tokens" | "blocked" }
      | { kind: "aborted"; reason: string }
      | { kind: "error"; error: { code: string; message: string } } = {
      kind: "completed",
    };
    try {
      for (let count = 0; count < maxSteps; count++, step++) {
        let continued = false;
        let started = false;
        let ended = false;
        let index = 0;
        let storageCode = "UNKNOWN";
        const attemptId = randomUUID();
        const storageFailure = (error: unknown) => {
          if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && (error.code === "ERR_SQLITE_ERROR" || /^SQLITE_[A-Z0-9_]{1,40}$/.test(error.code))) storageCode = error.code;
          blockStorage(error);
        };
        try {
          const { prepared, input } = prepareRequest(session);
          try {
            await session.flush();
          } catch (error) {
            storageFailure(error);
            throw error;
          }
          if (signal.aborted) {
            session.append({
              type: "assistant/attempt",
              data: {
                turn,
                step,
                outcome: "cancelled",
                reason: "aborted",
                stream: [],
                includeInModelContext: false,
              },
            });
            turnReason = { kind: "aborted", reason: "user" };
            return;
          }
          const stream = prepared.generate(input, signal);
          if (signal.aborted) {
            try {
              await stream[Symbol.asyncIterator]().return?.();
            } catch {
              // 释放失败不能把已经确认的取消改写成模型失败。
            }
            session.append({
              type: "assistant/attempt",
              data: { turn, step, outcome: "cancelled", reason: "aborted", stream: [], includeInModelContext: false },
            });
            turnReason = { kind: "aborted", reason: "user" };
            return;
          }
          publish({ type: "assistant/start", attemptId, turn, step });
          started = true;
          const start = Date.now();
          const recorded: { time: number; chunk: LlmChunk }[] = [];
          const content: Content = [];
          const calls = new Map<
            number,
            { id: string; name: string; arguments: string }
          >();
          let text = "";
          let usage: { inputTokens: number; outputTokens: number } | undefined;
          let finish: LlmFinishReason = {
            kind: "error",
            failure: {
              code: "STREAM_CLOSED",
              message: "Provider stream ended without a finish event",
            },
          };
          for await (const chunk of stream) {
            // 这些数字不能无损写入会话 JSON，保留它们会使失败结算本身被拒绝。
            if (chunk.type === "tool_call" && (!Number.isFinite(chunk.index) || Object.is(chunk.index, -0))) {
              finish = new LlmError("PROTOCOL").toFinishReason();
              break;
            }
            recorded.push({ time: Math.max(0, Date.now() - start), chunk });
            if (chunk.type === "finish") {
              finish = chunk.reason;
              break;
            }
            if (chunk.type === "usage") {
              usage = {
                inputTokens: chunk.inputTokens,
                outputTokens: chunk.outputTokens,
              };
              continue;
            }
            if (chunk.type === "tool_call") {
              let call = calls.get(chunk.index);
              if (
                !Number.isSafeInteger(chunk.index) ||
                chunk.index < 0 ||
                (!call && (!chunk.callId || !chunk.name)) ||
                (call &&
                  ((chunk.callId !== undefined && chunk.callId !== call.id) ||
                    (chunk.name !== undefined && chunk.name !== call.name))) ||
                (!call && [...calls.values()].some((prior) => prior.id === chunk.callId))
              ) {
                finish = new LlmError("PROTOCOL").toFinishReason();
                break;
              }
              if (!call) {
                call = {
                  id: chunk.callId ?? "",
                  name: chunk.name ?? "",
                  arguments: "",
                };
                calls.set(chunk.index, call);
                content.push({ type: "tool-call", ...call });
              }
              call.arguments += chunk.argumentsDelta;
              const block = content.find(
                (part) => part.type === "tool-call" && part.id === call.id,
              );
              if (block?.type === "tool-call") block.arguments = call.arguments;
              publish({
                type: "assistant/chunk",
                attemptId,
                index: index++,
                chunk: {
                  type: "tool-call-delta",
                  toolIndex: chunk.index,
                  ...(chunk.callId === undefined
                    ? {}
                    : { callId: chunk.callId }),
                  ...(chunk.name === undefined ? {} : { name: chunk.name }),
                  argumentsDelta: chunk.argumentsDelta,
                },
              });
            } else {
              if (chunk.type === "text") text += chunk.delta;
              const last = content.at(-1);
              if (last?.type === chunk.type) last.text += chunk.delta;
              else content.push({ type: chunk.type, text: chunk.delta });
              publish({
                type: "assistant/chunk",
                attemptId,
                index: index++,
                chunk,
              });
            }
          }
          if (
            (finish.kind === "stop" || finish.kind === "tool_calls") &&
            ([...calls.values()].some((call) => !call.id || !call.name) ||
              new Set([...calls.values()].map((call) => call.id)).size !==
                calls.size)
          ) {
            finish = new LlmError("PROTOCOL").toFinishReason();
          }
          let event: {
            type: "assistant/message" | "assistant/attempt";
            seq: number;
          };
          if (finish.kind === "stop" || finish.kind === "tool_calls") {
            turnReason = { kind: finish.kind === "tool_calls" ? "blocked" : "completed" };
            event = session.append({
              type: "assistant/message",
              surfaceOp: "append",
              data: {
                turn,
                step,
                message: {
                  id: randomUUID(),
                  role: "assistant",
                  source: prepared.route,
                  content,
                },
                finishReason: { kind: finish.kind },
                stream: compact(recorded),
                ...(usage ? { usage } : {}),
                includeInModelContext: true,
              },
            });
          } else {
            const outcome =
              finish.kind === "aborted"
                ? "cancelled"
                : finish.kind === "output_limit"
                  ? "truncated"
                  : "failed";
            const reason =
              finish.kind === "output_limit"
                ? "output_limit"
                : finish.kind === "error"
                  ? finish.failure
                  : "aborted";
            event = session.append({
              type: "assistant/attempt",
              data: {
                turn,
                step,
                outcome,
                reason,
                stream: compact(recorded),
                ...(outcome !== "failed" && text ? { text } : {}),
                includeInModelContext: false,
              },
            });
            turnReason =
              finish.kind === "aborted"
                ? { kind: "aborted", reason: "user" }
                : finish.kind === "output_limit"
                  ? { kind: "max-tokens" }
                  : finish.kind === "error"
                    ? { kind: "error", error: finish.failure }
                    : { kind: "completed" };
          }
          publish({
            type: "assistant/end",
            attemptId,
            turn,
            step,
            index,
            outcome: {
              kind: "committed",
              eventType: event.type,
              seq: event.seq,
            },
          });
          ended = true;
          if (event.type === "assistant/message" && calls.size) {
            const toolCalls = content.filter((part): part is Extract<Content[number], { type: "tool-call" }> => part.type === "tool-call");
            const canDispatch = finish.kind === "tool_calls" && options.toolRegistry && count + 1 < maxSteps && !signal.aborted;
            const checkpoint = async () => {
              try { await session.flush(); }
              catch (error) {
                storageFailure(error);
                throw error;
              }
            };
            if (canDispatch) {
              try { await checkpoint(); }
              catch (error) {
                for (const call of toolCalls) appendToolResult(session, { turn, step, callId: call.id, messageId: randomUUID() }, { isError: true, error: { message: "工具尚未派发", info: { name: "ToolError", code: "TOOL_NOT_STARTED" } }, content: [{ type: "text", text: "工具尚未派发" }] });
                throw error;
              }
              const batch = await runToolBatch(session, options.toolRegistry!, approvals, { turn, step }, toolCalls, signal, checkpoint, storageFailure);
              if (batch.kind === "completed") continued = true;
              else if (batch.kind === "aborted") turnReason = { kind: "aborted", reason: "user" };
              else if (batch.kind === "rejected") turnReason = { kind: "blocked" };
              else turnReason = { kind: "error", error: { code: "UNKNOWN", message: "本轮执行失败" } };
            } else {
              const message = signal.aborted ? "用户取消，工具未执行。" : "工具尚未派发";
              const code = signal.aborted ? "ABORTED_BEFORE_DISPATCH" : "TOOL_NOT_STARTED";
              for (const call of toolCalls) appendToolResult(session, { turn, step, callId: call.id, messageId: randomUUID() }, { isError: true, error: { message, info: { name: "ToolError", code } }, content: [{ type: "text", text: message }] });
              if (signal.aborted) turnReason = { kind: "aborted", reason: "user" };
              else if (options.toolRegistry && count + 1 >= maxSteps && finish.kind === "tool_calls") turnReason = { kind: "error", error: { code: "MAX_STEPS", message: "模型步数预算已耗尽" } };
            }
          }
        } catch (error) {
          turnReason = {
            kind: "error",
            error: { code: storageCode, message: "本轮执行失败" },
          };
          publish({ type: "agent/error", turn, message: "本轮执行失败" });
        } finally {
          if (started && !ended)
            publish({
              type: "assistant/end",
              attemptId,
              turn,
              step,
              index,
              outcome: { kind: "abandoned" },
            });
          session.append({ type: "step/end", data: { turn, step } });
        }
        if (!continued) break;
        try {
          await session.flush();
        } catch (error) {
          storageFailure(error);
          turnReason = {
            kind: "error",
            error: { code: storageCode, message: "本轮执行失败" },
          };
          publish({ type: "agent/error", turn, message: "本轮执行失败" });
          break;
        }
        if (signal.aborted) {
          turnReason = { kind: "aborted", reason: "user" };
          break;
        }
        session.append({ type: "step/start", data: { turn, step: step + 1 } });
      }
    } finally {
      session.append({ type: "turn/end", data: { turn, reason: turnReason } });
    }
  };
}
