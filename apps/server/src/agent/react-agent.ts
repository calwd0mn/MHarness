import { randomUUID } from "node:crypto";
import type { PromptRequest } from "@mharness/session/contracts";
import { isDeepStrictEqual } from "node:util";
import { projectInterruptedSession, type Session, type SessionHandle } from "@mharness/session/server";
import type { ExecutionNotice } from "./model-turn.ts";

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
/** 驱动一次已受理 Turn；驱动负责结算 Step 和 Turn。 */
export type RunTurn = (context: {
  session: Session; turn: number; step: number; signal: AbortSignal;
  publish: (notice: ExecutionNotice) => void; blockStorage: (error: unknown) => void;
}) => Promise<void>;

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
  #running: Promise<void> = Promise.resolve();
  #recovering?: Promise<void>;
  #revision = 0;
  #active?: ActiveAttempt;
  #toolIndices = new Map<number, number>();
  readonly #listeners = new Set<(notice: AgentObservation) => void>();
  readonly #unsubscribe: () => void;

  constructor(readonly session: Session, private readonly runTurn: RunTurn, private readonly handle: SessionHandle) {
    this.#unsubscribe = session.on("session/event", (event) => this.#emit({ type: "event", event }));
  }
  /** 当前进程内占用；不代表持久化 Turn 的终态。 */
  get state(): "idle" | "running" | "maintenance" { return this.#state; }
  /** 是否允许新任务进入存储检查点。 */
  get storageOpen(): boolean { return !this.#storageBlocked; }
  /**
   * 存储故障发生时关闭新任务准入，直到显式修复确认。
   * @param error - 用于保留故障原因的原始错误。
   */
  blockStorage(error: unknown): void {
    this.#storageBlocked = true;
    this.#storageError = error;
    this.#storageGeneration++;
  }
  /**
   * 空闲时核验已提交前缀并修复遗留范围，修复检查点成功后才开放准入。
   * @returns 核验及修复完成后兑现；并发调用共享同一恢复。
   * @throws 活动尚未退出、会话关闭或核验和检查点失败时拒绝，准入保持关闭。
   */
  recoverStorage(): Promise<void> {
    if (this.#state !== "idle" || this.#closing) {
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
    const projection = await projectInterruptedSession(this.handle);
    const live = this.session.snapshot().events;
    const repaired = projection.session.snapshot().events;
    if (projection.cursor !== live.length - 1 || !isDeepStrictEqual(repaired.slice(0, live.length), live)) {
      throw new Error("已提交前缀与当前会话不一致");
    }
    if (this.#active) {
      const { attemptId, turn, step, nextIndex } = this.#active;
      this.#publish({ type: "assistant/end", attemptId, turn, step, index: nextIndex, outcome: { kind: "abandoned" } });
    }
    for (const event of repaired.slice(live.length)) {
      const { seq: _seq, ...input } = event;
      if (input.type !== "session/end-seed") this.session.append(input);
    }
    await this.session.flush();
    if (generation === this.#storageGeneration) {
      this.#storageBlocked = false;
      this.#storageError = undefined;
    }
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
    if (notice.type === "agent/error") { this.#emit(notice); return; }
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
    if (this.#closing) throw new AgentError("agent_closed");
    if (this.#state !== "idle") throw new AgentError("agent_busy");
    if (this.#storageBlocked) throw new AgentError("storage_blocked", { cause: this.#storageError });
    const turn = events.reduce((max, event) => event.type === "turn/start" ? Math.max(max, event.data.turn) : max, 0) + 1;
    this.#state = "running";
    this.#controller = new AbortController();
    try {
      this.session.append({ type: "turn/start", data: { turn } });
      this.session.append({ type: "step/start", data: { turn, step: 1 } });
      this.session.append({ type: "user/message", surfaceOp: "append", data: { turn, requestId: request.requestId,
        id: randomUUID(), role: "user", source: { kind: "user" }, content: request.content } });
    } catch (error) { this.blockStorage(error); this.#state = "idle"; this.#controller = undefined; throw error; }
    const signal = this.#controller.signal;
    this.#running = Promise.resolve().then(() => this.runTurn({ session: this.session, turn, step: 1, signal,
      publish: (notice) => this.#publish(notice), blockStorage: (error) => this.blockStorage(error) }))
      .catch((error: unknown) => { this.blockStorage(error); console.error("Turn 驱动失败", error); })
      .finally(() => { this.#state = "idle"; this.#controller = undefined; });
    return { accepted: true };
  }
  /**
   * 在会话空闲且存储准入开放时独占执行维护任务，取消信号作用于该任务。
   * @param work - 接收取消信号并负责自身收尾的维护任务。
   * @returns 任务退出并释放占用后兑现；任务失败时以原错误拒绝。
   * @throws 会话关闭、忙碌或存储阻塞时拒绝。
   */
  runMaintenance(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.#closing) return Promise.reject(new AgentError("agent_closed"));
    if (this.#state !== "idle") return Promise.reject(new AgentError("agent_busy"));
    if (this.#storageBlocked) return Promise.reject(new AgentError("storage_blocked", { cause: this.#storageError }));
    this.#state = "maintenance";
    this.#controller = new AbortController();
    const signal = this.#controller.signal;
    const task = Promise.resolve().then(() => work(signal)).finally(() => {
      this.#state = "idle";
      this.#controller = undefined;
    });
    this.#running = task.catch(() => {});
    return task;
  }
  /** 请求取消当前活动；完成仍需等待运行退出。空闲时不产生影响。 */
  cancel(): void { this.#controller?.abort(); }
  /** 等待当前活动退出，不取消活动。 */
  async waitForIdle(): Promise<void> { await this.#running; }
  /** 同步停止接收新输入并请求取消当前活动；活动退出和观察解绑仍须等待 stop。 */
  beginStop(): void {
    this.#closing = true;
    this.cancel();
  }
  /** 停止接收新输入，取消并等待当前活动，再解绑观察。 */
  async stop(): Promise<void> {
    this.beginStop();
    try {
      await this.#running;
      await this.#recovering;
    } finally {
      this.#unsubscribe();
    }
  }
}
