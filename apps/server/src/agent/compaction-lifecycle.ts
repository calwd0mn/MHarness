import type { Session, SessionAppendInput, StagedCommitResult } from "@mharness/session/server";
import { randomUUID } from "node:crypto";
import { AgentError } from "./react-agent.ts";
import { BlockAssembler } from "./assistant-stream.ts";
import { LlmError, type LlmFinishReason, type ModelInput, type StreamBlock } from "../model/adapter.ts";
import type { PreparedModel } from "../model/runtime.ts";

/** 压缩批次使用的会话和独立存储准入。 */
export interface CompactionWriteContext {
  readonly session: Session;
  /** 同步读取当前准入，关闭时不能提交新批次。 */
  readonly storageOpen: () => boolean;
  /** 接收待核对的原始错误，须同步阻止后续写入。 */
  readonly blockStorage: (error: unknown) => void;
  /** 返回当前已知的故障原因，允许原值为 undefined。 */
  readonly storageFailure?: () => { readonly value: unknown } | undefined;
}

/**
 * 暂存压缩事件批次，确认提交后由 Session 发布完整批次。
 * @param context - 会话及其存储准入；调用方负责持有相应运行占用。
 * @param build - 根据首序号同步构建待提交事件。
 * @param options - 可选的提交前同步检查及暂存侧异常通知；普通检查点后先重新检查准入，再执行调用方检查，二者均在暂存端口调用前执行且异常不触发通知。通知须同步且不抛错。
 * @returns 已提交、确认回滚或待核对的持久化结论；待核对时先以原错误关闭准入。
 * @throws 准入关闭、暂存竞争、构建、校验、提交前检查或暂存侧抛错时以原值拒绝。
 */
export async function commitCompactionBatch(context: CompactionWriteContext, build: (firstSeq: number) => readonly SessionAppendInput[], options?: { readonly beforeSubmit?: () => void; readonly onPersistenceError?: (error: unknown) => void }): Promise<StagedCommitResult> {
  if (!context.storageOpen()) throw new AgentError("storage_blocked");
  const result = await context.session.commitStaged(build, {
    ...options,
    beforeSubmit: () => {
      if (!context.storageOpen()) throw new AgentError("storage_blocked");
      options?.beforeSubmit?.();
    },
  });
  if (result.status === "pending-reconciliation") context.blockStorage(result.error);
  return result;
}

function requireCompactionStorage(context: CompactionWriteContext): void {
  if (context.storageOpen()) return;
  const failure = context.storageFailure?.();
  throw failure ? failure.value : new AgentError("storage_blocked");
}

/**
 * 等待已接受的压缩事件落盘。检查点前后的准入必须保持开放。
 * @param context - 当前压缩占用的会话与存储准入；调用方负责记录故障并停止依赖请求。
 * @throws 检查点异常以原值拒绝，准入变化时携带已知故障。
 */
export async function flushCompaction(context: CompactionWriteContext): Promise<void> {
  requireCompactionStorage(context);
  await context.session.flush();
  requireCompactionStorage(context);
}

/** 调用方已取得独立维护或 Turn 占用，信号由该占用的所有者管理。 */
export interface CompactionAttemptContext extends CompactionWriteContext {
  /** 独立维护使用 null，Turn 内使用实际轮次。 */
  readonly turn: number | null;
  /** 当前占用的取消信号，将原样交给摘要生成。 */
  readonly signal: AbortSignal;
  /** 手动命令的固定压缩身份；ID 不得与历史压缩记录重复，省略时生成独立 ID 且不关联命令。 */
  readonly identity?: Readonly<{ compactionId: string; sourceCommandId: string }>;
}

/** 关联同一次压缩的 start 与后续记录，取自 start 载荷。 */
export type CompactionAttemptIdentity = Extract<SessionAppendInput, { type: "compaction/start" }>["data"];

/** 已组装的摘要模型输出；调用方负责校验模型终态和内容。 */
export type CompactionGeneratedOutput = Readonly<{
  blocks: readonly StreamBlock[];
  finishReason: LlmFinishReason;
  /** 模型报告取消时观察到的调用方取消原因；可能并未观察到取消信号。 */
  cancellation?: { readonly present: boolean; readonly value: unknown };
  /** 摘要路径捕获的 Adapter 原值，可能为 undefined；缺省包括主动交付失败终态或其后清理抛错。 */
  adapterError?: { readonly value: unknown };
  usage?: Readonly<{ inputTokens: number; outputTokens: number }>;
}>;

/** 摘要启动或生成的结论；确认 start 后由调用方在原占用内负责终态。 */
export type CompactionAttemptResult =
  | { readonly status: "no-range" }
  | { readonly status: "generated"; readonly attempt: CompactionAttemptIdentity; readonly value: CompactionGeneratedOutput }
  | { readonly status: "start-not-confirmed"; readonly attempt: CompactionAttemptIdentity; readonly error: unknown }
  | { readonly status: "generation-failed"; readonly attempt: CompactionAttemptIdentity; readonly error: unknown; readonly cancelled?: boolean };

/**
 * 同步捕获摘要输入，确认 start 提交并检查存储准入后消费固定模型的生成流。
 * @param context - 调用方持有的维护或 Turn 占用、会话和取消信号；取消传播到模型流。
 * @param capture - 同步提供相互匹配的固定模型和独立、不可变的输入；无安全范围时跳过。
 * @param options - 是否启用摘要专用终态观察及原异常交接。
 * @returns 无范围、start 未确认、已组装的模型输出或确认 start 后的生成失败。确认提交后，若启动前准入关闭或模型流结束前取消，返回带原身份的生成失败；模型输出可能含失败终态，须由调用方校验。确认 start 后仍需由调用方在原占用内结算。
 * @throws 捕获前后准入关闭、已取消或固定 ID 已存在，或捕获、开始记录追加失败时拒绝。已知错误以原值传播。
 */
export async function runCompactionAttempt(
  context: CompactionAttemptContext,
  capture: () => { readonly kind: "no-range" } | { readonly kind: "ready"; readonly input: ModelInput; readonly model: PreparedModel },
  options?: { readonly preserveFailureTerminal?: boolean },
): Promise<CompactionAttemptResult> {
  if (!context.storageOpen()) throw new AgentError("storage_blocked");
  const { turn, signal } = context;
  signal.throwIfAborted();
  if (context.identity && context.session.snapshot().events.some((event) =>
    (event.type === "compaction/start" || event.type === "compaction/end" || event.type === "compaction/summary") && event.data.compactionId === context.identity!.compactionId)) {
    throw new Error("压缩 ID 已存在");
  }
  const captured = capture();
  requireCompactionStorage(context);
  if (captured.kind === "no-range") return { status: "no-range" };
  const { input, model } = captured;
  const attempt: CompactionAttemptIdentity = Object.freeze(context.identity
    ? { compactionId: context.identity.compactionId, sourceCommandId: context.identity.sourceCommandId, turn }
    : { compactionId: randomUUID(), turn });
  if (context.session.stagedOccupied) throw new AgentError("storage_blocked");
  signal.throwIfAborted();
  context.session.append({ type: "compaction/start", data: attempt });
  try {
    await flushCompaction(context);
  } catch (error) {
    context.blockStorage(error);
    return { status: "start-not-confirmed", attempt, error };
  }
  let observed: Extract<LlmFinishReason, { kind: "error" | "aborted" }> | undefined;
  let cancellation: { readonly present: boolean; readonly value: unknown } | undefined;
  let cancelled = false;
  let runtimeCancellation: { readonly value: unknown } | undefined;
  let adapterError: { readonly value: unknown } | undefined;
  const checkCancellation = () => { if (signal.aborted) { cancelled = true; signal.throwIfAborted(); } };
  try {
    const assembler = new BlockAssembler();
    if (!context.storageOpen()) throw new AgentError("storage_blocked");
    checkCancellation();
    for await (const chunk of model.generate(input, signal, options?.preserveFailureTerminal ? { onFailureTerminal: (reason, evidence) => { observed = reason; cancellation = evidence; }, onCancellationGuard: (value) => { runtimeCancellation = { value }; }, onAdapterError: (value) => { adapterError = { value }; } } : undefined)) {
      if (runtimeCancellation && !observed) { cancelled = true; throw runtimeCancellation.value; }
      assembler.push(chunk);
      if (chunk.type === "finish") {
        if (options?.preserveFailureTerminal && !observed && (chunk.reason.kind === "error" || chunk.reason.kind === "aborted")) {
          observed = chunk.reason;
          cancellation = { present: signal.aborted, value: signal.aborted ? signal.reason : undefined };
        }
        break;
      }
    }
    if (!observed) checkCancellation();
    const value = {
      blocks: assembler.content,
      finishReason: assembler.finish ?? new LlmError("STREAM_CLOSED").toFinishReason(),
      ...(cancellation ? { cancellation } : {}),
      ...(adapterError ? { adapterError } : {}),
      ...(assembler.usage ? { usage: assembler.usage } : {}),
    };
    return { status: "generated", attempt, value };
  } catch (error) {
    if (observed) return { status: "generated", attempt, value: { blocks: [], finishReason: observed, ...(cancellation ? { cancellation } : {}), ...(adapterError ? { adapterError } : {}) } };
    return { status: "generation-failed", attempt, error, ...(cancelled ? { cancelled: true } : {}) };
  }
}
