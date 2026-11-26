import { randomUUID } from "node:crypto";
import type { PromptRequest } from "@mharness/session/contracts";
import { isDeepStrictEqual } from "node:util";
import { projectInterruptedSession, type Session, type SessionHandle } from "@mharness/session/server";
import type { ExecutionNotice, ModelTurnContext } from "./model-turn.ts";
import type { CompactionAttemptContext } from "./compaction-lifecycle.ts";
import type { CommitCompactionSummaryOptions } from "./commit-compaction-summary.ts";
import { settleCompactionSummary, type CompactionSettlementIntent, type CompactionSettlementResult } from "./settle-compaction-summary.ts";

type Event = ReturnType<Session["snapshot"]>["events"][number];
type Chunk =
  | { type: "text" | "reasoning"; delta: string }
  | { type: "tool-call-delta"; toolIndex: number; callId?: string; name?: string; argumentsDelta: string };
type StreamFrame =
  | (Omit<Extract<ExecutionNotice, { type: "assistant/start" }>, "type"> & { type: "start"; revision: number })
  | { type: "chunk"; attemptId: string; index: number; chunk: Chunk; revision: number }
  | (Omit<Extract<ExecutionNotice, { type: "assistant/end" }>, "type"> & { type: "end"; revision: number });
/** 已接受事件与实时通知按同一同步观察顺序交付。 */
export type AgentObservation = { type: "event"; event: Event } | { type: "assistant-stream"; frame: StreamFrame }
  | Extract<ExecutionNotice, { type: "agent/error" }>;
type ActiveAttempt = { attemptId: string; turn: number; step: number; chunks: Chunk[]; nextIndex: number };
/** 驱动一次已受理 Turn；驱动负责开启并结算执行范围，压缩写入待核对时保留未闭合范围。 */
export type RunTurn = (context: ModelTurnContext & { storageOpen: () => boolean }) => Promise<void>;

/** 可由 HTTP 层映射的命令失败代码。 */
export class AgentError extends Error {
  constructor(readonly code: "agent_busy" | "session/not-found" | "session/fork-unavailable" | "storage_blocked" | "agent_closed", options?: ErrorOptions) { super(code, options); }
}

/** 会话级执行占用、存储准入和实时观察；运行对象跨 Turn 存活。 */
export class ReActAgent {
  #state: "idle" | "running" | "maintenance" = "idle";
  #storageError: unknown;
  #storageBlocked = false;
  #storageGeneration = 0;
  #closing = false;
  #controller?: AbortController;
  #turn: number | null = null;
  #settling = false;
  readonly #intents = new Map<string, CompactionSettlementIntent>();
  #running: Promise<void> = Promise.resolve();
  #busyWrites: Promise<void> = Promise.resolve();
  #pendingBusyWrites = 0;
  #recovering?: Promise<void>;
  #revision = 0;
  #active?: ActiveAttempt;
  #toolIndices = new Map<number, number>();
  readonly #listeners = new Set<(notice: AgentObservation) => void>();
  readonly #unsubscribe: () => void;
  #publishingIdle = false;
  #directoryErrorTurn: number | undefined;
  readonly #directoryErrorListeners = new Set<(turn: number, message: string) => void>();
  readonly #stateListeners = new Set<(state: "idle" | "running" | "maintenance") => void>();
  readonly #stopListeners = new Set<() => void>();

  constructor(readonly session: Session, private readonly runTurn: RunTurn, private readonly handle: SessionHandle) {
    this.#unsubscribe = session.on("session/event", (event) => {
      this.#emit({ type: "event", event });
      if (event.type === "turn/end" && event.data.reason.kind === "error") this.#reportDirectoryError(event.data.turn);
    });
  }
  /** 当前进程内占用；不代表持久化 Turn 的终态。 */
  get state(): "idle" | "running" | "maintenance" { return this.#state; }
  /**
   * 同步观察后续占用状态；idle 通知完成前新活动仍会被判为忙碌。解除订阅不会影响活动。
   * @param listener - 状态变化时同步调用的监听器。
   * @returns 解除订阅的函数。
   */
  onStateChange(listener: (state: "idle" | "running" | "maintenance") => void): () => void {
    this.#stateListeners.add(listener);
    return () => { this.#stateListeners.delete(listener); };
  }
  /**
   * 观察当前 Turn 的公开失败，每轮最多通知一次，不改变聊天观察流。
   * @param listener - 接收失败 Turn 编号及公开文案的同步监听器。
   * @returns 解除订阅的函数。
   */
  onDirectoryError(listener: (turn: number, message: string) => void): () => void {
    this.#directoryErrorListeners.add(listener);
    return () => { this.#directoryErrorListeners.delete(listener); };
  }
  #reportDirectoryError(turn: number, message = "本轮执行失败"): void {
    if (this.#turn !== turn || this.#directoryErrorTurn === turn) return;
    this.#directoryErrorTurn = turn;
    for (const listener of [...this.#directoryErrorListeners]) { try { listener(turn, message); } catch (error) { console.error("Agent 错误监听失败", error); } }
  }
  /**
   * 观察 Agent 停止完成；回调在活动退出后的状态通知之后执行。
   * @param listener - 停止完成时调用的监听器。
   * @returns 解除订阅的函数。
   */
  onStopped(listener: () => void): () => void {
    this.#stopListeners.add(listener);
    return () => { this.#stopListeners.delete(listener); };
  }
  #setState(state: "idle" | "running" | "maintenance"): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#publishingIdle = state === "idle";
    try {
      for (const listener of [...this.#stateListeners]) { try { listener(state); } catch (error) { console.error("Agent 状态监听失败", error); } }
    } finally { this.#publishingIdle = false; }
  }
  /** 活动任务、其忙碌拒绝日志或空闲状态通知尚未交接完成时，保持新任务忙碌。 */
  get busy(): boolean { return this.#state !== "idle" || this.#publishingIdle || this.#pendingBusyWrites > 0; }
  /** 是否允许新任务进入存储检查点。 */
  get storageOpen(): boolean { return !this.#storageBlocked; }
  /**
   * 存储故障发生时关闭新任务准入，直到显式修复确认。
   * @param error - 用于保留故障原因的原始错误。
   */
  blockStorage(error: unknown): void {
    if (!this.#storageBlocked) this.#storageError = error;
    this.#storageBlocked = true;
    this.#storageGeneration++;
  }
  /**
   * 在当前维护或 Turn 占用内执行摘要结算，并在返回前保留待恢复的原始终态意图。调用方须在原占用内等待返回。
   * @param context - 当前占用的真实信号和轮次；Turn 调用须传入 StepHookContext 的存储回调，以锁存本轮故障。
   * @param options - 摘要模型快照和选区参数。
   * @returns 带原值和检查点结果的结算；未能追加的终态意图由 Agent 保存，供在线恢复使用。
   * @throws 上下文不属于当前占用、同时结算或摘要在 start 前拒绝时抛出。
   */
  async settleCompaction(context: CompactionAttemptContext, options: CommitCompactionSummaryOptions): Promise<CompactionSettlementResult> {
    if (this.#closing || this.#state === "idle" || this.#settling || context.session !== this.session ||
      context.signal !== this.#controller?.signal || context.turn !== this.#turn) throw new Error("摘要上下文不属于当前占用");
    this.#settling = true;
    try {
      const result = await settleCompactionSummary({
        ...context,
        storageOpen: () => this.storageOpen && context.storageOpen(),
        storageFailure: () => this.#storageBlocked ? { value: this.#storageError } : context.storageFailure?.(),
        blockStorage: error => {
          try {
            if (this.storageOpen || this.#state === "running") context.blockStorage(error);
          } finally {
            if (this.storageOpen) this.blockStorage(error);
          }
        },
      }, options);
      if (result.status === "unsettled" && result.intent) {
        this.#intents.set(result.attempt.compactionId, result.intent);
      }
      return result;
    } finally { this.#settling = false; }
  }
  /**
   * 空闲时核验已提交前缀并修复遗留范围，修复检查点成功后才开放准入。
   * @returns 核验及修复完成后兑现；并发调用共享同一恢复。
   * @throws 活动尚未退出、会话关闭或核验和检查点失败时拒绝，准入保持关闭。
   */
  recoverStorage(): Promise<void> {
    if (this.busy || this.#closing) {
      return Promise.reject(new Error("会话活动或关闭期间无法恢复存储"));
    }
    if (this.#recovering) return this.#recovering;
    this.#storageBlocked = true;
    const generation = this.#storageGeneration;
    const recovery = this.#repairStorage(generation).finally(() => { this.#recovering = undefined; });
    this.#recovering = recovery;
    return recovery;
  }
  async #repairStorage(generation: number): Promise<void> {
    await this.session.flush();
    const live = this.session.snapshot().events;
    const projection = await projectInterruptedSession(this.handle, { expectedLivePrefix: live,
      terminalIntents: [...this.#intents.values()].map(intent => ({ ...intent.attempt, status: intent.outcome, reason: intent.reason })) });
    const repaired = projection.session.snapshot().events;
    if (projection.cursor !== live.length - 1 || !isDeepStrictEqual(repaired.slice(0, live.length), live)) {
      throw new Error("已提交前缀与当前会话不一致");
    }
    const guard = () => {
      if (this.#closing || this.#state !== "idle" || generation !== this.#storageGeneration || this.session.seq !== live.length) {
        throw new Error("恢复期间会话状态已变更");
      }
    };
    guard();
    const closers = repaired.slice(live.length);
    if (this.#active) {
      const { attemptId, turn, step, nextIndex } = this.#active;
      this.#publish({ type: "assistant/end", attemptId, turn, step, index: nextIndex, outcome: { kind: "abandoned" } });
      guard();
    }
    if (closers.length) {
      this.session.appendBatch(firstSeq => {
        guard();
        if (firstSeq !== live.length) throw new Error("恢复序号已变更");
        return closers.flatMap(({ seq: _seq, ...input }) => input.type === "session/end-seed" ? [] : [input]);
      });
    }
    const confirmed = this.session.snapshot().events;
    await this.session.flush();
    if (!isDeepStrictEqual(await this.handle.read(), confirmed) || this.#closing || this.#state !== "idle" ||
      generation !== this.#storageGeneration || this.session.seq !== confirmed.length) {
      throw new Error("恢复最终前缀或状态不一致");
    }
    this.#intents.clear();
    this.#storageBlocked = false;
    this.#storageError = undefined;
  }
  /**
   * 同步捕获已接受前缀与实时草稿，调用方可先订阅再取得截点。
   * @returns 独立数组组成的完整观察快照。
   */
  snapshot() {
    const snapshot = this.session.snapshot();
    return { sessionId: this.session.header.sessionId, inheritedEventCount: this.session.inheritedEventCount,
      cursor: snapshot.cursor, records: snapshot.events.map((event) => ({ type: "event" as const, event })),
      assistantStream: { revision: this.#revision, ...(this.#active ? { activeAttempt: { ...this.#active, chunks: structuredClone(this.#active.chunks) } } : {}) } };
  }
  /**
   * 订阅之后的事件与实时通知；解除订阅不会停止 Turn。
   * @param listener - 按观察顺序同步调用的监听器。
   * @returns 解除订阅的函数。
   */
  onObservation(listener: (notice: AgentObservation) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  #emit(notice: AgentObservation): void {
    for (const listener of [...this.#listeners]) { try { listener(notice); } catch (error) { console.error("Agent 观察监听失败", error); } }
  }
  #publish(notice: ExecutionNotice): void {
    if (notice.type === "agent/error") { this.#emit(notice); this.#reportDirectoryError(notice.turn, notice.message); return; }
    if (notice.type === "assistant/start") {
      const revision = ++this.#revision;
      this.#toolIndices.clear();
      this.#active = { attemptId: notice.attemptId, turn: notice.turn, step: notice.step, chunks: [], nextIndex: 0 };
      this.#emit({ type: "assistant-stream", frame: { ...notice, type: "start", revision } });
    } else if (notice.type === "assistant/chunk") {
      const source = notice.chunk;
      if (source.type === "block-start" && source.blockType === "tool-call") {
        this.#toolIndices.set(source.index, this.#toolIndices.size);
        return;
      }
      let chunk: Chunk;
      if (source.type === "text-delta" || source.type === "reasoning-delta") {
        chunk = { type: source.type === "text-delta" ? "text" : "reasoning", delta: source.text };
      } else if (source.type === "tool-call-delta") {
        const toolIndex = this.#toolIndices.get(source.index);
        if (toolIndex === undefined) return;
        chunk = { type: "tool-call-delta", toolIndex, ...(source.id === undefined ? {} : { callId: source.id }),
          ...(source.name === undefined ? {} : { name: source.name }), argumentsDelta: source.argumentsDelta };
      } else return;
      const active = this.#active;
      if (!active) return;
      const index = active.nextIndex++;
      active.chunks.push(structuredClone(chunk));
      const revision = ++this.#revision;
      this.#emit({ type: "assistant-stream", frame: { type: "chunk", attemptId: notice.attemptId, index, chunk, revision } });
    } else {
      const index = this.#active?.nextIndex ?? 0;
      this.#active = undefined;
      const revision = ++this.#revision;
      this.#emit({ type: "assistant-stream", frame: { ...notice, type: "end", index, revision } });
    }
  }
  /**
   * 查重并同步受理一次 prompt，重发优先于占用及存储状态检查。
   * @param request - 客户端编号和待受理文本。
   * @returns 首次受理或此前已受理均返回确认；无需等待模型或落盘。
   * @throws 新编号遇占用、关闭或存储阻塞时抛出 AgentError。
   */
  prompt(request: PromptRequest): { accepted: true } {
    const events = this.session.snapshot().events;
    if (events.some((event) => event.seq >= this.session.inheritedEventCount && event.type === "user/message"
      && event.data.source.kind === "user" && "requestId" in event.data && event.data.requestId === request.requestId)) return { accepted: true };
    this.#assertAdmission();
    const turn = events.reduce((max, event) => event.type === "turn/start" ? Math.max(max, event.data.turn) : max, 0) + 1;
    this.#turn = turn;
    this.#controller = new AbortController();
    let finishRunning!: () => void;
    this.#running = new Promise<void>(resolve => { finishRunning = resolve; });
    this.#setState("running");
    try {
      this.session.append({ type: "turn/start", data: { turn } });
      this.session.append({ type: "user/message", surfaceOp: "append", data: { turn, requestId: request.requestId,
        id: randomUUID(), role: "user", source: { kind: "user" }, content: request.content } });
    } catch (error) { this.blockStorage(error); this.#controller = undefined; this.#turn = null; this.#setState("idle"); finishRunning(); throw error; }
    const signal = this.#controller.signal;
    void Promise.resolve().then(() => this.runTurn({
      session: this.session, turn, step: 1, signal,
      publish: notice => this.#publish(notice), blockStorage: error => this.blockStorage(error),
      storageOpen: () => this.storageOpen, storageFailure: () => this.#storageBlocked ? { value: this.#storageError } : undefined,
      settleCompaction: (context, options) => this.settleCompaction(context, options),
    }))
      .catch((error: unknown) => {
        const storageFailed = !this.storageOpen;
        if (this.storageOpen) this.blockStorage(error);
        console.error("Turn 驱动失败", error);
        if (storageFailed || (!signal.aborted && !(error instanceof Error && error.name === "AbortError"))) this.#reportDirectoryError(turn);
      })
      .finally(() => { this.#controller = undefined; this.#turn = null; this.#setState("idle"); })
      .then(finishRunning, finishRunning);
    return { accepted: true };
  }
  /**
   * 在会话空闲且存储准入开放时独占执行维护任务，取消信号作用于该任务。
   * @param work - 接收取消信号并负责自身收尾的维护任务。
   * @returns 任务退出并释放占用后返回任务结果；任务失败时以原错误拒绝。
   * @throws 会话关闭、忙碌或存储阻塞时拒绝。
   */
  runMaintenance<TResult>(work: (signal: AbortSignal) => Promise<TResult>): Promise<TResult> {
    try { this.#assertAdmission(); } catch (error) { return Promise.reject(error); }
    this.#controller = new AbortController();
    let finishRunning!: () => void;
    this.#running = new Promise<void>(resolve => { finishRunning = resolve; });
    this.#setState("maintenance");
    const signal = this.#controller.signal;
    const task = Promise.resolve().then(() => work(signal)).finally(() => {
      this.#controller = undefined;
      this.#setState("idle");
    });
    void task.then(finishRunning, finishRunning);
    return task;
  }
  /**
   * 等待当前活动交出写入权，再原子接受并确认同一条命令的 busy 记录。
   * @param run - 已识别且在到达时判为忙碌的命令事件数据。
   * @param text - 可保存和返回的忙碌原因。
   * @throws 准入关闭或检查点失败时拒绝；调用方不能据此承诺记录已持久化。
   */
  async recordBusyCommand(run: Extract<Event, { type: "command/run" }>["data"], text: string): Promise<void> {
    if (this.#closing) throw new AgentError("agent_closed");
    if (!this.storageOpen) throw new AgentError("storage_blocked", { cause: this.#storageError });
    this.#pendingBusyWrites++;
    // 原活动仍可同步追加，须在退出后交接；交接期间的新任务同样看见 busy。
    const work = Promise.all([this.#running, this.#busyWrites]).then(async () => {
      if (!this.storageOpen) throw new AgentError("storage_blocked", { cause: this.#storageError });
      try {
        this.session.appendBatch(() => [
          { type: "command/run", data: run },
          { type: "command/done", data: { commandId: run.commandId, kind: "error", text } },
        ]);
        await this.session.flush();
        if (!this.storageOpen) throw new AgentError("storage_blocked", { cause: this.#storageError });
      } catch (error) {
        if (this.storageOpen) this.blockStorage(error);
        throw error;
      }
    }).finally(() => { this.#pendingBusyWrites--; });
    this.#busyWrites = work.then(() => {}, () => {});
    await work;
  }
  #assertAdmission(): void {
    if (this.#closing) throw new AgentError("agent_closed");
    if (this.busy) throw new AgentError("agent_busy");
    if (this.#storageBlocked) throw new AgentError("storage_blocked", { cause: this.#storageError });
  }
  /** 请求取消当前活动；完成仍需等待运行退出。空闲时不产生影响。 */
  cancel(): void { this.#controller?.abort(); }
  /** 等待当前活动退出，不取消活动。 */
  async waitForIdle(): Promise<void> { await this.#running; await this.#busyWrites; }
  /** 同步停止接收新输入并请求取消当前活动；活动退出和观察解绑仍须等待 stop。 */
  beginStop(): void {
    this.#closing = true;
    this.cancel();
  }
  /** 停止接收新输入，取消并等待当前活动，再解绑观察。 */
  async stop(): Promise<void> {
    this.beginStop();
    try {
      await this.waitForIdle();
      await this.#recovering;
    } finally {
      this.#unsubscribe();
      for (const listener of [...this.#stopListeners]) { try { listener(); } catch (error) { console.error("Agent 停止监听失败", error); } }
      this.#stopListeners.clear();
      this.#stateListeners.clear();
      this.#directoryErrorListeners.clear();
    }
  }
}
