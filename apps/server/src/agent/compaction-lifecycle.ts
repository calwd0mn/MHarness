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
}

/**
 * 暂存压缩事件批次，确认提交后由 Session 发布完整批次。
 * @param context - 会话及其存储准入；调用方负责持有相应运行占用。
 * @param build - 根据首序号同步构建待提交事件。
 * @returns 已提交、确认回滚或待核对的持久化结论；待核对时先以原错误关闭准入。
 * @throws 存储准入关闭、暂存竞争或构建和校验失败时拒绝。
 */
export async function commitCompactionBatch(context: CompactionWriteContext, build: (firstSeq: number) => readonly SessionAppendInput[]): Promise<StagedCommitResult> {
  if (!context.storageOpen()) throw new AgentError("storage_blocked");
  const result = await context.session.commitStaged(build);
  if (result.status === "pending-reconciliation") context.blockStorage(result.error);
  return result;
}

/** 调用方已取得独立维护或 Turn 占用，信号由该占用的所有者管理。 */
export interface CompactionAttemptContext extends CompactionWriteContext {
  /** 独立维护使用 null，Turn 内使用实际轮次。 */
  readonly turn: number | null;
  /** 当前占用的取消信号，将原样交给摘要生成。 */
  readonly signal: AbortSignal;
  /** 手动命令的固定压缩身份；省略时生成独立 ID 且不关联命令。 */
  readonly identity?: Readonly<{ compactionId: string; sourceCommandId: string }>;
}

/** 关联同一次压缩的 start 与后续记录，取自 start 载荷。 */
export type CompactionAttemptIdentity = Extract<SessionAppendInput, { type: "compaction/start" }>["data"];

/** 已组装的摘要模型输出；调用方负责校验模型终态和内容。 */
export type CompactionGeneratedOutput = Readonly<{
  blocks: readonly StreamBlock[];
  finishReason: LlmFinishReason;
  usage?: Readonly<{ inputTokens: number; outputTokens: number }>;
}>;

/** 摘要启动或生成的结论；确认 start 后由调用方在原占用内负责终态。 */
export type CompactionAttemptResult =
  | { readonly status: "no-range" }
  | { readonly status: "generated"; readonly attempt: CompactionAttemptIdentity; readonly value: CompactionGeneratedOutput }
  | { readonly status: "start-not-confirmed"; readonly attempt: CompactionAttemptIdentity; readonly commit: Exclude<StagedCommitResult, { status: "committed" }> }
  | { readonly status: "generation-failed"; readonly attempt: CompactionAttemptIdentity; readonly error: unknown };

/**
 * 同步捕获摘要输入，确认 start 提交并检查存储准入后消费固定模型的生成流。
 * @param context - 调用方持有的维护或 Turn 占用、会话和取消信号；取消传播到模型流。
 * @param capture - 同步提供相互匹配的固定模型和独立、不可变的输入；无安全范围时跳过。
 * @returns 无范围、start 未确认、已组装的模型输出或确认 start 后的生成失败。确认提交后，若启动前准入关闭或模型流结束前取消，返回带原身份的生成失败；模型输出可能含失败终态，须由调用方校验。确认 start 后仍需由调用方在原占用内结算。
 * @throws 捕获前准入关闭或已取消，或捕获、start 构建或检查点抛错时拒绝。
 */
export async function runCompactionAttempt(
  context: CompactionAttemptContext,
  capture: () => { readonly kind: "no-range" } | { readonly kind: "ready"; readonly input: ModelInput; readonly model: PreparedModel },
): Promise<CompactionAttemptResult> {
  if (!context.storageOpen()) throw new AgentError("storage_blocked");
  const { turn, signal } = context;
  signal.throwIfAborted();
  const captured = capture();
  if (captured.kind === "no-range") return { status: "no-range" };
  const { input, model } = captured;
  const attempt: CompactionAttemptIdentity = Object.freeze(context.identity
    ? { compactionId: context.identity.compactionId, sourceCommandId: context.identity.sourceCommandId, turn }
    : { compactionId: randomUUID(), turn });
  const commit = await commitCompactionBatch(context, () => [{ type: "compaction/start", data: attempt }]);
  if (commit.status !== "committed") return { status: "start-not-confirmed", attempt, commit };
  try {
    const assembler = new BlockAssembler();
    if (!context.storageOpen()) throw new AgentError("storage_blocked");
    signal.throwIfAborted();
    for await (const chunk of model.generate(input, signal)) {
      assembler.push(chunk);
      if (chunk.type === "finish") break;
    }
    signal.throwIfAborted();
    const value = {
      blocks: assembler.content,
      finishReason: assembler.finish ?? new LlmError("STREAM_CLOSED").toFinishReason(),
      ...(assembler.usage ? { usage: assembler.usage } : {}),
    };
    return { status: "generated", attempt, value };
  } catch (error) {
    return { status: "generation-failed", attempt, error };
  }
}
