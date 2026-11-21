import { localConfig } from "../../../../config/local.ts";
import { randomUUID } from "node:crypto";
import type { Session } from "@mharness/session/server";
import { LlmError } from "../model/adapter.ts";
import type {

  LlmFinishReason,
  ModelTool,
} from "../model/adapter.ts";
import type { LlmRuntime, ModelConfig } from "../model/runtime.ts";
import { AssistantStreamAttempt, type AssistantStreamFrame } from "./assistant-stream.ts";
import { createRequestPreparer, type StepSnapshot } from "./request-context.ts";
import { ApprovalService } from "../approval/service.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { runToolBatch } from "../tools/batch.ts";
import { appendToolResult } from "../tools/result-event.ts";

/** 供会话观察层同步发布的内部模型帧和执行错误。 */
export type ExecutionNotice = AssistantStreamFrame | { type: "agent/error"; turn: number; message: string };

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
  /** 即时读取存储准入；省略时视为开放。 */
  storageOpen?: () => boolean;
};
/** 等待点可见的本步上下文，不包含模型凭据。 */
export type StepHookContext = Readonly<{
  session: Session; turn: number; step: number; signal: AbortSignal;
  /** 即时读取会话存储准入；本轮首次通过 hook 报告待核对后，即使普通 flush 完成核对也保持关闭。 */
  storageOpen: () => boolean;
  /** 报告压缩写入待核对的原始错误；本轮保留首次报告并跳过普通持久收尾。 */
  blockStorage: (error: unknown) => void;
  /** 已固定并冻结的可记录路由、生成参数、system 和 tools。 */
  header: Readonly<StepSnapshot["header"]>;
}>;
/** 模型驱动的配置供应者；每个 Step 开始时取一次快照。 */
export type ModelTurnOptions = {
  /** 负责归一模型配置并生成统一流。 */
  runtime: LlmRuntime;
  /** 每个 Step 读取配置；无法记录的 endpointId 或生效 topP 会在开步前拒绝。 */
  config: () => ModelConfig;
  /** 每个 Step 读取系统提示词，并与模型配置一同记录。 */
  systemPrompt: () => string;
  /** 每个 Step 读取的模型可见工具定义。 */
  tools?: () => readonly ModelTool[];
  /** 开步前等待；AbortError 表示取消，其他拒绝终止本轮；取消信号作用于该等待。 */
  preStep?: (context: StepHookContext) => Promise<void>;
  /** 超限结算及实时结束后决定是否重试；存储开放时普通异常保留原失败，AbortError 表示取消，失败信息为独立只读副本。 */
  recoverOverflow?: (context: StepHookContext & { readonly failure: Readonly<{ code: string; message: string }> }) => Promise<boolean>;
  /** 每轮最多发起的模型步数，须为正安全整数；默认使用集中配置。 */
  maxSteps?: number;
  /** 每轮只读工具超时次数上限，须为正安全整数；达到上限时停止本轮，默认使用集中配置。 */
  maxReadOnlyTimeouts?: number;
  /** 提供可信工具定义和正文；未配置时工具调用不派发。 */
  toolRegistry?: ToolRegistry;
  /** 审批服务；未提供时审批渠道不可用。 */
  approvalService?: ApprovalService;
};

type Content = (
  | { type: "text" | "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; arguments: string }
)[];

/**
 * 创建有限步数的 Turn 驱动，检查点成功后启动模型并结算每个 Step。
 * 未配置工具注册表时工具调用追加 TOOL_NOT_STARTED 并以 blocked 结束；耗尽步数时不再派发。
 * 已完成批次中的成功结束意向使 Turn 以 completed 结束，不再请求模型续答。
 * 副作用或未知工具超时以及只读超时预算耗尽时以对应错误码结束；只读预算跨 Step 累计，每轮重置。
 * 已取消时不进入下一步；否则先固定模型配置并等待 preStep，检查存储准入后开步。
 * 每次请求在检查点后重新检查准入和取消；检查点失败优先于同时发生的取消。
 * 超限恢复回调只在失败 Attempt 及实时结束交付后调用一次，获准后在同一步重建请求。
 * 等待点报告压缩写入待核对后，以首次错误拒绝并保留未闭合的 Step 和 Turn。
 * @param options - Runtime、每步配置及可选等待和恢复回调。
 * @returns 可注入 Agent 的异步驱动；取消信号传给等待点、模型请求和工具批次。
 * @throws 步数或只读超时上限不是正安全整数时抛出 RangeError。
 */
export function createModelTurnDriver(
  options: ModelTurnOptions,
): (context: ModelTurnContext) => Promise<void> {
  const maxSteps = options.maxSteps ?? localConfig.model.maxSteps;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1)
    throw new RangeError("maxSteps must be a positive safe integer");
  const maxReadOnlyTimeouts = options.maxReadOnlyTimeouts ?? localConfig.tools.maxReadOnlyTimeouts;
  if (!Number.isSafeInteger(maxReadOnlyTimeouts) || maxReadOnlyTimeouts < 1)
    throw new RangeError("maxReadOnlyTimeouts must be a positive safe integer");
  const prepareRequest = createRequestPreparer({ ...options, tools: options.tools ?? (options.toolRegistry ? () => options.toolRegistry!.definitions() : undefined) });
  const approvals = options.approvalService ?? new ApprovalService(null);
  return async ({
    session,
    turn,
    step: initialStep,
    signal,
    publish,
    blockStorage,
    storageOpen = () => true,
  }) => {
    let step = initialStep;
    let hookStorageFailure: { error: unknown } | undefined;
    const blockHookStorage = (error: unknown) => {
      if (hookStorageFailure) return;
      hookStorageFailure = { error };
      if (storageOpen()) blockStorage(error);
    };
    const assertHookStorage = () => {
      if (hookStorageFailure) throw hookStorageFailure.error;
    };
    const timeoutBudget = { count: 0, max: maxReadOnlyTimeouts };
    let turnReason:
      | { kind: "completed" | "max-tokens" | "blocked" }
      | { kind: "aborted"; reason: string }
      | { kind: "error"; error: { code: string; message: string } } = {
      kind: "completed",
    };
    try {
      for (let count = 0; count < maxSteps; count++, step++) {
        if (signal.aborted) { turnReason = { kind: "aborted", reason: "user" }; break; }
        let continued = false;
        let attempt: AssistantStreamAttempt | undefined;
        let stepOpen = false;
        let storageCode = "UNKNOWN";
        let storageFailed = false;
        const storageFailure = (error: unknown) => {
          storageFailed = true;
          if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && (error.code === "ERR_SQLITE_ERROR" || /^SQLITE_[A-Z0-9_]{1,40}$/.test(error.code))) storageCode = error.code;
          blockStorage(error);
        };
        try {
          const fixed = prepareRequest.snapshot();
          if (signal.aborted) { turnReason = { kind: "aborted", reason: "user" }; break; }
          const hookContext: StepHookContext = Object.freeze({ session, turn, step, signal, header: fixed.header, storageOpen: () => hookStorageFailure === undefined && storageOpen(), blockStorage: blockHookStorage });
          try {
            await options.preStep?.(hookContext);
          } catch (error) {
            assertHookStorage();
            if (storageOpen() && error instanceof Error && error.name === "AbortError") {
              turnReason = { kind: "aborted", reason: "user" };
              break;
            }
            throw error;
          }
          assertHookStorage();
          if (signal.aborted) { turnReason = { kind: "aborted", reason: "user" }; break; }
          if (!storageOpen()) throw new Error("存储准入已关闭");
          session.append({ type: "step/start", data: { turn, step } });
          stepOpen = true;
          let retried = false;
          while (true) {
            const { prepared, input } = prepareRequest(session, false, fixed);
            try {
              await session.flush();
            } catch (error) {
              storageFailure(error);
              throw error;
            }
            if (!storageOpen()) throw new Error("存储准入已关闭");
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
            attempt = new AssistantStreamAttempt(randomUUID(), turn, step, publish);
            attempt.start();
            const { accumulator, assembler } = attempt;
            let finish: LlmFinishReason = new LlmError("STREAM_CLOSED").toFinishReason();
            for await (const incoming of stream) {
              try { attempt.push(incoming); }
              catch { finish = new LlmError("PROTOCOL").toFinishReason(); break; }
              if (incoming.type === "finish") { finish = incoming.reason; break; }
            }
            const content = assembler.content;
            const calls = content.filter((part): part is Extract<Content[number], { type: "tool-call" }> => part.type === "tool-call");
            const text = content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
            const usage = assembler.usage;

            if ((finish.kind === "stop" && calls.length) || (finish.kind === "tool-calls" && !assembler.completeTools)) {
              finish = new LlmError("PROTOCOL").toFinishReason();
            }
            if (finish.kind === "stop" && !content.some((part) => part.type !== "tool-call" && part.text.length > 0)) {
              finish = new LlmError("EMPTY_RESPONSE").toFinishReason();
            }
            let event: {
              type: "assistant/message" | "assistant/attempt";
              seq: number;
            };
            if (finish.kind === "stop" || finish.kind === "tool-calls") {
              turnReason = { kind: finish.kind === "tool-calls" ? "blocked" : "completed" };
              event = attempt.commit(() => session.append({
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
                  finishReason: { kind: finish.kind === "tool-calls" ? "tool_calls" : "stop" },
                  stream: accumulator.stream,
                  ...(usage ? { usage } : {}),
                  includeInModelContext: true,
                },
              }));
            } else {
              const outcome =
                finish.kind === "aborted"
                  ? "cancelled"
                  : finish.kind === "max-tokens"
                    ? "truncated"
                    : "failed";
              const reason =
                finish.kind === "max-tokens"
                  ? "output_limit"
                  : finish.kind === "error"
                    ? finish.failure
                    : "aborted";
              event = attempt.commit(() => session.append({
                type: "assistant/attempt",
                data: {
                  turn,
                  step,
                  outcome,
                  reason,
                  stream: accumulator.stream,
                  ...(outcome !== "failed" && text ? { text } : {}),
                  includeInModelContext: false,
                },
              }));
              turnReason =
                finish.kind === "aborted"
                  ? { kind: "aborted", reason: "user" }
                  : finish.kind === "max-tokens"
                    ? { kind: "max-tokens" }
                    : finish.kind === "error"
                      ? { kind: "error", error: finish.failure }
                      : { kind: "completed" };
            }
            if (!retried && finish.kind === "error" && finish.failure.code === "CONTEXT_WINDOW_EXCEEDED" && options.recoverOverflow) {
              attempt.abandon();
              attempt = undefined;
              let approved = false;
              try {
                approved = await options.recoverOverflow(Object.freeze({ ...hookContext, failure: Object.freeze({ ...finish.failure }) }));
              } catch (error) {
                assertHookStorage();
                if (!storageOpen()) throw error;
                if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
                  turnReason = { kind: "aborted", reason: "user" };
                  break;
                }
              }
              assertHookStorage();
              if (signal.aborted) { turnReason = { kind: "aborted", reason: "user" }; break; }
              if (!storageOpen()) throw new Error("存储准入已关闭");
              if (approved) { retried = true; continue; }
            }
            if (event.type === "assistant/message" && calls.length) {
              const toolCalls = content.filter((part): part is Extract<Content[number], { type: "tool-call" }> => part.type === "tool-call");
              const canDispatch = finish.kind === "tool-calls" && options.toolRegistry && count + 1 < maxSteps && !signal.aborted;
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
                const batch = await runToolBatch(session, options.toolRegistry!, approvals, { turn, step }, toolCalls, signal, checkpoint, storageFailure, timeoutBudget);
                if (batch.kind === "completed") {
                  if (batch.concludeTurn) turnReason = { kind: "completed" };
                  else continued = true;
                }
                else if (batch.kind === "aborted") turnReason = { kind: "aborted", reason: "user" };
                else if (batch.kind === "rejected") turnReason = { kind: "blocked" };
                else if (batch.kind === "timeout") turnReason = { kind: "error", error: { code: "TOOL_TIMEOUT", message: "工具超时，最终结果未确认" } };
                else if (batch.kind === "read-only-timeout-budget") turnReason = { kind: "error", error: { code: "READ_ONLY_TIMEOUT_BUDGET_EXHAUSTED", message: "只读工具超时预算已耗尽" } };
                else turnReason = { kind: "error", error: { code: "UNKNOWN", message: "本轮执行失败" } };
              } else {
                const message = signal.aborted ? "用户取消，工具未执行。" : "工具尚未派发";
                const code = signal.aborted ? "ABORTED_BEFORE_DISPATCH" : "TOOL_NOT_STARTED";
                for (const call of toolCalls) appendToolResult(session, { turn, step, callId: call.id, messageId: randomUUID() }, { isError: true, error: { message, info: { name: "ToolError", code } }, content: [{ type: "text", text: message }] });
                if (signal.aborted) turnReason = { kind: "aborted", reason: "user" };
                else if (options.toolRegistry && count + 1 >= maxSteps && finish.kind === "tool-calls") turnReason = { kind: "error", error: { code: "MAX_STEPS", message: "模型步数预算已耗尽" } };
              }
            }
            break;
          }
        } catch (error) {
          assertHookStorage();
          if (!storageFailed && signal.aborted) {
            turnReason = { kind: "aborted", reason: "user" };
          } else {
            turnReason = {
              kind: "error",
              error: { code: storageCode, message: "本轮执行失败" },
            };
            publish({ type: "agent/error", turn, message: "本轮执行失败" });
          }
        } finally {
          attempt?.abandon();
          if (stepOpen && !hookStorageFailure) session.append({ type: "step/end", data: { turn, step } });
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
      }
    } finally {
      if (!hookStorageFailure) session.append({ type: "turn/end", data: { turn, reason: turnReason } });
    }
  };
}
