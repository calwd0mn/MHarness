import { recoverInterruptedSession, Session, type SessionHandle, type SessionPersistence } from "@mharness/session/server";
import { AgentError, ReActAgent, type RunTurn } from "./react-agent.ts";

type Persistence = Pick<SessionPersistence, "open"> & {
  bindWriter(handle: SessionHandle, session: Session, reportError?: (error: unknown) => void): void;
};
type Entry = { agent: ReActAgent; handle: SessionHandle };

/** 合并同会话并发加载并持有写入权，直到管理器显式关闭。 */
export class AgentManager {
  readonly #entries = new Map<string, Entry>();
  readonly #loading = new Map<string, Promise<ReActAgent>>();
  readonly #listeners = new Set<(agent: ReActAgent) => void>();
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
    if (pending) return pending;
    const task = this.#load(sessionId).finally(() => { this.#loading.delete(sessionId); });
    this.#loading.set(sessionId, task);
    return task;
  }
  async #load(sessionId: string): Promise<ReActAgent> {
    const handle = await this.persistence.open(sessionId, "write");
    if (!handle) throw new AgentError("session/not-found");
    try {
      await recoverInterruptedSession(handle);
      const events = await handle.read();
      const session = new Session(handle.header, { seed: { kind: "restore", events, inheritedEventCount: handle.inheritedEventCount } });
      const agent = new ReActAgent(session, this.runTurn, handle);
      this.persistence.bindWriter(handle, session, (error) => { agent.blockStorage(error); console.error("会话后台写入失败", error); });
      if (this.#closing) { await agent.stop(); throw new AgentError("agent_closed"); }
      this.#entries.set(sessionId, { agent, handle });
      for (const listener of [...this.#listeners]) { try { listener(agent); } catch (error) { console.error("Agent 加载监听失败", error); } }
      return agent;
    } catch (error) { await handle.close(); throw error; }
  }
  /**
   * 停止所有输入并同时取消活动，等待加载和活动退出后释放写入权。
   * @returns 所有句柄关闭后兑现；失败时以 AggregateError 汇总。
   */
  close(): Promise<void> {
    if (!this.#closing) this.#closing = this.#close();
    return this.#closing;
  }
  async #close(): Promise<void> {
    const entries = [...this.#entries.values()];
    const stopping = Promise.allSettled(entries.map(({ agent }) => agent.stop()));
    const loading = await Promise.allSettled([...this.#loading.values()]);
    const errors: unknown[] = [];
    for (const result of loading) {
      if (result.status === "rejected" &&
        !(result.reason instanceof AgentError && result.reason.code === "agent_closed")) {
        errors.push(result.reason);
      }
    }
    const stopped = await stopping;
    for (const result of stopped) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    for (const { handle } of entries) {
      try { await handle.close(); } catch (error) { errors.push(error); }
    }
    this.#entries.clear();
    if (errors.length) throw new AggregateError(errors, "关闭 Agent 失败");
  }
}
