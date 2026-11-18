import { recoverInterruptedSession, Session, MemorySessionStore, type SessionHeader, type SessionHandle, type SessionPersistence } from "@mharness/session/server";
import { AgentError, ReActAgent, type RunTurn } from "./react-agent.ts";

type Event = ReturnType<Session["snapshot"]>["events"][number];
type ForkHeader = Extract<SessionHeader, { isSeeded: true }>;
type Persistence = Pick<SessionPersistence, "open" | "create"> & {
  bindWriter(handle: SessionHandle, session: Session, reportError?: (error: unknown) => void): void;
};
type Entry = { agent: ReActAgent; handle: SessionHandle };

/** 合并同会话并发加载并持有写入权，直到管理器显式关闭。 */
export class AgentManager {
  readonly #entries = new Map<string, Entry>();
  readonly #loading = new Map<string, Promise<ReActAgent>>();
  readonly #listeners = new Set<(agent: ReActAgent) => void>();
  readonly #sessions = new MemorySessionStore();
  readonly #lifetime = new AbortController();
  #closing?: Promise<void>;
  /**
   * 创建会话运行对象管理器。
   * @param persistence - 提供写句柄及其写入器绑定的存储。
   * @param runTurn - 接管每个已受理 Turn 的驱动。
   */
  constructor(private readonly persistence: Persistence, private readonly runTurn: RunTurn) {}
  /**
   * 只查询已加载实例，不触发存储读取或加载。
   * @param sessionId - 会话标识。
   * @returns 已加载实例；不存在时返回 undefined。
   */
  get(sessionId: string): ReActAgent | undefined { return this.#entries.get(sessionId)?.agent; }
  /**
   * 注册后续加载通知；加载完成后、受理请求前同步通知。
   * @param listener - 接收新加载的 Agent。
   * @returns 解除订阅的函数。
   */
  onLoaded(listener: (agent: ReActAgent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  /**
   * 取得已加载实例或合并同一会话的并发加载，完成恢复和写入器绑定后发布。
   * @param sessionId - 要加载的会话标识。
   * @returns 已完成装配的唯一会话实例。
   * @throws 会话不存在、写入权不可用、恢复失败或管理器关闭时拒绝。
   */
  load(sessionId: string): Promise<ReActAgent> {
    if (this.#closing) return Promise.reject(new AgentError("agent_closed"));
    const existing = this.get(sessionId);
    if (existing) return Promise.resolve(existing);
    const pending = this.#loading.get(sessionId);
    if (pending) return pending.then((agent) => {
      if (this.#closing) throw new AgentError("agent_closed");
      return agent;
    });
    const task = this.#load(sessionId).finally(() => { this.#loading.delete(sessionId); });
    this.#loading.set(sessionId, task);
    return task;
  }
  /**
   * 观察之后成功发布的分支；回调可立即查询 Agent 和完整初始快照。
   * @param listener - 接收新发布 Session 的观察者。
   * @returns 解除订阅的函数。
   */
  onSessionCreated(listener: (session: Session) => void): () => void {
    return this.#sessions.on("session/created", listener);
  }

  /**
   * 读取一次父会话前缀；已加载时同步截取内存，否则短暂持有只读句柄。
   * @param sessionId - 父会话标识。
   * @returns 一次完整前缀；从存储读取时，释放只读句柄后兑现。
   * @throws 父会话不存在，或只读访问及关闭失败时拒绝。
   */
  async readForkSource(sessionId: string): Promise<readonly Event[]> {
    const agent = this.get(sessionId);
    if (agent) return agent.session.snapshot().events;
    const handle = await this.persistence.open(sessionId, "read");
    if (!handle) throw new AgentError("session/not-found");
    try { return await handle.read(); } finally { await handle.close(); }
  }

  /**
   * 保留子会话激活位置并准备完整首批；同 ID 的 load 等待该次初始化。
   * @param header - 尚未使用的子会话标识和直接父会话元数据。
   * @param readSeed - 读取并选择一次父快照，返回连续的继承前缀。
   * @returns 批次得到确认、绑定写入器且发布后的 Agent。
   * @throws 重复标识、提交前关闭、取种或初始化失败时拒绝。
   */
  initializeFork(header: ForkHeader, readSeed: () => Promise<readonly Event[]>): Promise<ReActAgent> {
    if (this.#closing) return Promise.reject(new AgentError("agent_closed"));
    const { sessionId } = header;
    if (this.#loading.has(sessionId) || this.get(sessionId)) return Promise.reject(new Error("会话 ID 已占用"));
    // 先占据加载位置，防止首批提交后并发 load 再争夺同一写入权。
    const task = Promise.resolve().then(() => this.#initializeFork(header, readSeed)).finally(() => {
      this.#loading.delete(sessionId);
    });
    this.#loading.set(sessionId, task);
    return task;
  }

  async #initializeFork(header: ForkHeader, readSeed: () => Promise<readonly Event[]>): Promise<ReActAgent> {
    const signal = this.#lifetime.signal;
    signal.throwIfAborted();
    const events = await readSeed();
    signal.throwIfAborted();
    const session = this.#sessions.prepare(header, { kind: "fork", events });
    const handle = await this.persistence.create(session.header, { inheritedEventCount: session.inheritedEventCount, signal });
    let agent: ReActAgent | undefined;
    try {
      signal.throwIfAborted();
      await handle.append(session.snapshot().events);
      agent = new ReActAgent(session, this.runTurn, handle);
      this.#bindWriter(handle, agent);
      // append 一旦确认，对应分支已存在；关闭中的 Agent 在交给观察者前封住任务准入。
      const closing = signal.aborted;
      if (closing) agent.beginStop();
      this.#entries.set(header.sessionId, { agent, handle });
      // 持久快照的观察者须先接上增量，创建监听器可能同步追加。
      this.#notifyLoaded(agent);
      this.#sessions.publish(session);
      if (closing) await agent.stop();
      return agent;
    } catch (error) {
      try { await agent?.stop(); } finally { await handle.close(); }
      throw error;
    }
  }
  async #load(sessionId: string): Promise<ReActAgent> {
    const handle = await this.persistence.open(sessionId, "write");
    if (!handle) throw new AgentError("session/not-found");
    try {
      await recoverInterruptedSession(handle);
      const events = await handle.read();
      const session = new Session(handle.header, { seed: { kind: "restore", events, inheritedEventCount: handle.inheritedEventCount } });
      const agent = new ReActAgent(session, this.runTurn, handle);
      this.#bindWriter(handle, agent);
      if (this.#closing) { await agent.stop(); throw new AgentError("agent_closed"); }
      this.#entries.set(sessionId, { agent, handle });
      this.#notifyLoaded(agent);
      return agent;
    } catch (error) { await handle.close(); throw error; }
  }
  #bindWriter(handle: SessionHandle, agent: ReActAgent): void {
    this.persistence.bindWriter(handle, agent.session, (error) => { agent.blockStorage(error); console.error("会话后台写入失败", error); });
  }
  #notifyLoaded(agent: ReActAgent): void {
    for (const listener of [...this.#listeners]) { try { listener(agent); } catch (error) { console.error("Agent 加载监听失败", error); } }
  }
  /**
   * 停止所有输入并同时取消活动，等待加载和活动退出后释放写入权。
   * @returns 所有句柄关闭后兑现；资源与执行失败以 AggregateError 汇总，调用方的会话不存在或分支不可用拒绝不计入。
   */
  close(): Promise<void> {
    if (!this.#closing) {
      let start!: () => void;
      this.#closing = new Promise<void>((resolve, reject) => {
        start = () => { void this.#close().then(resolve, reject); };
      });
      start();
    }
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#lifetime.abort(new AgentError("agent_closed"));
    const stopping = Promise.allSettled([...this.#entries.values()].map(({ agent }) => agent.stop()));
    const loading = await Promise.allSettled([...this.#loading.values()]);
    const errors: unknown[] = [];
    for (const result of loading) {
      if (result.status === "rejected" && !(result.reason instanceof AgentError && ["agent_closed", "session/fork-unavailable", "session/not-found"].includes(result.reason.code))) {
        errors.push(result.reason);
      }
    }
    for (const result of await stopping) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    // 关闭期间新发布的分支已由初始化路径停止，此处也需释放其写入权。
    for (const { agent, handle } of this.#entries.values()) {
      try { await handle.close(); } catch (error) { errors.push(error); }
      finally { this.#sessions.release(agent.session); }
    }
    this.#entries.clear();
    this.#listeners.clear();
    if (errors.length) throw new AggregateError(errors, "关闭 Agent 失败");
  }
}
