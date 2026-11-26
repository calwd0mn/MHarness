import { randomUUID } from "node:crypto";
import { createPersistedSession, selectForkCut, Session, type SessionPersistence } from "@mharness/session/server";
import type { SessionHeader } from "@mharness/session/server";
import { isDeepStrictEqual } from "node:util";
import type { SessionDirectory } from "./session/directory.ts";
import { sessionParamsSchema, type CompactRequest, type CompactResponse, type PromptRequest, type PromptResponse } from "@mharness/session/contracts";
import { AgentManager } from "./agent/manager.ts";
import { AgentError } from "./agent/react-agent.ts";
import type { CompactionSettlementResult } from "./agent/settle-compaction-summary.ts";
import type { CommitCompactionSummaryOptions } from "./agent/commit-compaction-summary.ts";

type CompactCommandResult = CompactResponse | { code: "compaction_id_conflict" } | { commandId: string; result: { kind: "error"; text: string } };

type CreationResult = Awaited<ReturnType<typeof createPersistedSession>> | { status: "conflict" };
type CreationAttempt = { header: SessionHeader; result: Promise<CreationResult>; timer?: ReturnType<typeof setTimeout>; registered?: boolean };

/** 管理会话首次创建的共享尝试与后台核实，关闭后不再调度或应用核实结果。 */
export class SessionCreationController {
  readonly #attempts = new Map<string, CreationAttempt>();
  #closed = false;
  /** @param persistence - 创建会话的持久化存储。 @param directory - 当前目录投影。 */
  constructor(private readonly persistence: SessionPersistence, private readonly directory: () => SessionDirectory) {}

  /**
   * 共享相同身份的创建结果，同标识不同身份返回冲突。
   * @param header - 固定的会话身份。
   * @param reportCloseError - 记录写句柄关闭错误。
   * @returns 首次提交的结果；未知结果在后台继续核实。
   */
  create(header: SessionHeader, reportCloseError?: (error: unknown) => void): Promise<CreationResult> {
    const existing = this.#attempts.get(header.sessionId);
    if (existing) return isDeepStrictEqual(existing.header, header) ? existing.result : Promise.resolve({ status: "conflict" });
    if (this.#closed) return Promise.resolve({ status: "conflict" });
    const fixed = Object.freeze({ ...header });
    const attempt: CreationAttempt = { header: fixed, result: Promise.resolve({ status: "conflict" }) };
    this.#attempts.set(fixed.sessionId, attempt);
    attempt.result = createPersistedSession(this.persistence, fixed, reportCloseError, () => {
      if (!this.#closed && this.#attempts.get(fixed.sessionId) === attempt) {
        const directory = this.directory();
        attempt.registered = directory.register(new Session(fixed), true);
      }
    }).then(result => {
      if (this.#closed || this.#attempts.get(fixed.sessionId) !== attempt) return result;
      if (result.status === "committed") { if (attempt.registered) this.directory().confirm(fixed.sessionId); }
      else if (result.status === "failed") {
        if (attempt.registered && this.directory().isPending(fixed.sessionId)) this.directory().remove(fixed.sessionId);
        this.#attempts.delete(fixed.sessionId);
      } else {
        if (attempt.registered) this.directory().markUnknown(fixed.sessionId);
        this.#schedule(attempt, result.verify, 250);
      }
      return result;
    });
    return attempt.result;
  }

  #schedule(attempt: CreationAttempt, verify: () => Promise<"committed" | "failed" | "unknown">, delay: number): void {
    if (this.#closed || this.#attempts.get(attempt.header.sessionId) !== attempt) return;
    attempt.timer = setTimeout(() => {
      if (this.#closed || this.#attempts.get(attempt.header.sessionId) !== attempt) return;
      void verify().catch(() => "unknown" as const).then(result => {
        if (this.#closed || this.#attempts.get(attempt.header.sessionId) !== attempt) return;
        if (result === "unknown") this.#schedule(attempt, verify, Math.min(delay * 2, 10_000));
        else if (result === "committed") {
          if (attempt.registered) this.directory().confirm(attempt.header.sessionId);
          attempt.result = Promise.resolve({ status: "committed" });
        }
        else { if (attempt.registered && this.directory().isPending(attempt.header.sessionId)) this.directory().remove(attempt.header.sessionId); this.#attempts.delete(attempt.header.sessionId); }
      });
    }, delay);
  }

  /** 停止后续调度；已启动的核实结果不再改变目录。 */
  close(): void {
    this.#closed = true;
    for (const attempt of this.#attempts.values()) if (attempt.timer) clearTimeout(attempt.timer);
  }
}

/** 按命令选择激活策略；prompt 和手动压缩按需加载，取消只查询已加载实例。 */
export class SessionCommandController {
  #creation?: SessionCreationController;
  /**
   * 绑定会话命令的 Agent 管理器及可选摘要配置。
   * @param agents - 会话执行对象及其写入资源的所有者。
   * @param prepareCompaction - 可选的生产摘要配置供应者，在取得维护占用后调用。
   */
  constructor(
    private readonly agents: AgentManager,
    prepareCompaction?: () => CommitCompactionSummaryOptions,
  ) {
    if (prepareCompaction) this.compact = request => this.#compact(request, prepareCompaction);
  }
  /**
   * 绑定本实例的会话创建控制器，重复调用返回同一实例。
   * @param persistence - 创建会话的持久化存储。
   * @param directory - 当前目录投影。
   * @returns 应用关闭时须停止的创建控制器。
   */
  creationController(persistence: SessionPersistence, directory: () => SessionDirectory): SessionCreationController {
    return this.#creation ??= new SessionCreationController(persistence, directory);
  }
  /**
   * 从同一次父会话观察快照派生子会话，并以持久化的初始前缀发布子 Agent。
   * @param request - 父会话标识须符合会话标识契约；事件位置缺省时选择最近已结束的 Turn。
   * @returns 子会话初始批次得到确认并完成发布后的会话标识。
   * @throws 父会话标识无效或不存在、找不到闭合 Turn、锚点无效、关闭或初始化失败时拒绝。
   */
  async fork({ sessionId: parentSession, atSeq }: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }> {
    sessionParamsSchema.parse({ sessionId: parentSession });
    if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq < 0)) {
      throw new RangeError("分支锚点必须是非负安全整数");
    }
    const sessionId = randomUUID();
    await this.agents.initializeFork({ sessionId, createdAt: Date.now(), parentSession, isSeeded: true }, async () => {
      const events = await this.agents.readForkSource(parentSession);
      const cut = selectForkCut(events, atSeq);
      if (cut === undefined) throw new AgentError("session/fork-unavailable");
      return events.slice(0, cut);
    });
    return { sessionId };
  }
  /** 首次提交按需加载 Agent；重发和首次受理均返回确认，不等待执行结束。 */
  async prompt(request: PromptRequest & { sessionId: string }): Promise<PromptResponse> {
    const agent = await this.agents.load(request.sessionId);
    return agent.prompt(request);
  }
  /**
   * 执行已通过入口校验的手动压缩，并确认可报告的命令终态。
   * @param request - 会话、本次固定压缩身份及可选的原始命令参数。
   * @returns 确认落盘的业务结果、同会话的压缩身份冲突或已落盘的 busy 拒绝。
   * @throws 会话不可用、持久化结局未确认或处理器异常时拒绝。结算异常时保留原错误。
   */
  readonly compact?: (request: CompactRequest & { sessionId: string }) => Promise<CompactCommandResult>;

  async #compact(
    { sessionId, compactionId, args }: CompactRequest & { sessionId: string },
    prepare: () => CommitCompactionSummaryOptions,
  ): Promise<CompactCommandResult> {
    const agent = await this.agents.load(sessionId);
    const { session } = agent;
    if (session.snapshot().events.some(event =>
      (event.type === "compaction/start" || event.type === "compaction/summary" || event.type === "compaction/end") &&
      event.data.compactionId === compactionId)) return { code: "compaction_id_conflict" };

    const commandId = randomUUID();
    const run = { commandId, name: "compact", source: { kind: "user" }, ...(args === undefined ? {} : { args }) } as const;
    if (agent.busy) {
      const text = "会话正忙";
      try { await agent.recordBusyCommand(run, text); }
      catch (cause) { throw new AgentError("agent_busy", { cause }); }
      return { commandId, result: { kind: "error", text } };
    }
    return agent.runMaintenance(async signal => {
      const requireStorage = () => {
        if (!agent.storageOpen) throw new AgentError("storage_blocked");
      };
      const writeDone = async (result: { kind: "success"; text?: string; sourceEventSeq?: number } | { kind: "error"; text: string }) => {
        requireStorage();
        try {
          session.append({ type: "command/done", data: { commandId, ...result } });
          await session.flush();
          requireStorage();
        } catch (cause) {
          if (agent.storageOpen) agent.blockStorage(cause);
          throw new AgentError("storage_blocked", { cause });
        }
      };
      requireStorage();
      session.append({ type: "command/run", data: run });
      let result: CompactionSettlementResult;
      try {
        result = await agent.settleCompaction({
          session, signal, turn: null, identity: { compactionId, sourceCommandId: commandId },
          storageOpen: () => agent.storageOpen, blockStorage: error => agent.blockStorage(error),
        }, prepare());
      } catch (original) {
        if (agent.storageOpen) {
          try { await writeDone({ kind: "error", text: signal.aborted ? "压缩已取消" : "压缩失败" }); }
          catch { /* 命令处理器原错仍是调用方可观察的失败。 */ }
        }
        throw original;
      }
      if (result.status === "unsettled") {
        if (result.source.status !== "commit-checkpoint-failed" && result.original.present) throw result.original.value;
        throw new AgentError("storage_blocked", { cause: result.storageFailure?.value });
      }
      if (result.status === "no-range") {
        await writeDone({ kind: "success", text: "No compactable history yet." });
        return { compactionId, commandId, status: "no_safe_range" };
      }
      if (result.outcome === "succeeded") {
        await writeDone({ kind: "success", sourceEventSeq: result.summarySeq });
      } else {
        try { await writeDone({ kind: "error", text: result.outcome === "cancelled" ? "压缩已取消" : "压缩失败" }); }
        catch (error) { throw result.original.present ? result.original.value : error; }
      }
      return { compactionId, commandId, status: result.outcome };
    });
  }
  /** 请求取消当前活动；未加载会话返回 session/not-found，不触发加载。 */
  async cancel(sessionId: string): Promise<{ accept: true }> {
    const agent = this.agents.get(sessionId);
    if (!agent) throw new AgentError("session/not-found");
    agent.cancel(); return { accept: true };
  }
}
