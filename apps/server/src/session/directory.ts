import { sessionSummarySchema, type SessionDirectorySnapshot, type SessionSummary, type SessionDirectoryFrame } from "@mharness/session/contracts";
import { Session, type SessionPersistence, type SessionPersistenceSnapshot } from "@mharness/session/server";
import type { ReActAgent } from "../agent/react-agent.ts";

/** 各类目录通知的业务参数；时间为 Unix 毫秒，seq 为来源会话内序号。 */
export type SessionDirectoryListeners = {
  "api-session/added": (summary: SessionSummary) => void;
  "api-session/removed": (sessionId: string) => void;
  "api-session/updated": (sessionId: string, blank: false, seq: number) => void;
  "api-session/status": (sessionId: string, running: boolean) => void;
  "api-session/activity": (sessionId: string, updatedAt: number) => void;
  "api-session/error": (sessionId: string, message: string) => void;
};
/** 可订阅的目录业务事件。 */
export type SessionDirectoryEvent = keyof SessionDirectoryListeners;
/** 指定业务事件对应的监听函数。 */
export type SessionDirectoryListener<E extends SessionDirectoryEvent> = SessionDirectoryListeners[E];
/** 提供按类型订阅目录业务事件的能力。 */
export type SessionDirectorySubscription = {
  /**
   * 按发布顺序同步接收后续事件；监听器异常不会阻止其他监听器。
   * @param type - 要订阅的业务事件类型。
   * @param listener - 接收对应领域参数的监听器。
   * @returns 可重复调用的退订函数，不影响 Agent 或其他订阅。
   */
  on<E extends SessionDirectoryEvent>(type: E, listener: SessionDirectoryListener<E>): () => void;
};

function summarizeCold({ header, eventCount, inheritedEventCount, listMetadata }: SessionPersistenceSnapshot): SessionSummary {
  const valid = listMetadata?.eventCount === eventCount && listMetadata.inheritedEventCount === inheritedEventCount;
  const summary = { sessionId: header.sessionId, createdAt: header.createdAt,
    updatedAt: valid ? Math.max(header.createdAt, listMetadata.lastPromptAt ?? header.createdAt) : header.createdAt,
    running: false, blank: valid ? listMetadata.blank : false };
  if (header.isSeeded) {
    const parent = sessionSummarySchema.shape.parentSessionId.safeParse(header.parentSession);
    if (parent.success) return { ...summary, parentSessionId: parent.data };
  }
  return summary;
}

function summarize(session: Session): SessionSummary {
  const { header } = session;
  const { blank, lastPromptAt } = session.listMetadata;
  const updatedAt = Math.max(header.createdAt, lastPromptAt ?? header.createdAt);
  const summary = { sessionId: header.sessionId, createdAt: header.createdAt, updatedAt, running: false, blank };
  if (header.isSeeded) {
    const parent = sessionSummarySchema.shape.parentSessionId.safeParse(header.parentSession);
    if (parent.success) return { ...summary, parentSessionId: parent.data };
  }
  return summary;
}

/** 维护实例内的目录投影，启动数据不占用变更版本。 */
export class SessionDirectory implements SessionDirectorySubscription {
  readonly #sessions = new Map<string, SessionSummary>();
  readonly #temporary = new Map<string, SessionSummary>();
  readonly #unknown = new Set<string>();
  readonly #listeners = new Set<(notice: SessionDirectoryFrame) => void>();
  readonly #queue: { notice: SessionDirectoryFrame; listeners: readonly ((notice: SessionDirectoryFrame) => void)[] }[] = [];
  readonly #live = new Map<string, { header: Session["header"]; inheritedEventCount: number; summary: SessionSummary; revision: number; fieldRevision: number; fieldSeq: number }>();
  #emitting = false;
  #revision = 0;
  #confirmations = 0;
  /** @param initial - 已提交会话的完整日志快照。 */
  constructor(initial: readonly Session[] = []) {
    for (const session of initial) this.#sessions.set(session.header.sessionId, summarize(session));
  }
  /**
   * 从已提交清单和可用检查点建立初始投影，不读取事件正文。
   * @param persistence - 提供已提交视图的存储。
   * @returns 版本为零的目录；清单读取失败时拒绝。
   */
  static async restore(persistence: SessionPersistence): Promise<SessionDirectory> {
    const directory = new SessionDirectory();
    for (const item of await persistence.list()) directory.#sessions.set(item.header.sessionId, summarizeCold(item));
    return directory;
  }
  /**
   * @returns 同步截点的版本与按活动时间降序、ID 升序排列的独立摘要。
   * 旧分支的父 ID 无法按会话标识契约传输时，仅省略该可选字段。
   */
  snapshot(): SessionDirectorySnapshot {
    return { revision: this.#revision, sessions: [...this.#sessions.values()].map((item) => ({ ...item })).sort((a, b) => b.updatedAt - a.updatedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)) };
  }
  /**
   * 同步观察此后产生的实时目录通知；取消订阅不影响 Agent。
   * @param listener - 接收通知的监听器。
   * @returns 解除订阅的函数。
   */
  onObservation(listener: (notice: SessionDirectoryFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  /** @inheritdoc */
  on<E extends SessionDirectoryEvent>(type: E, listener: SessionDirectoryListener<E>): () => void {
    return this.onObservation(frame => {
      if (frame.type !== type) return;
      switch (frame.type) {
        case "api-session/added": (listener as SessionDirectoryListeners["api-session/added"])(frame.summary); break;
        case "api-session/removed": (listener as SessionDirectoryListeners["api-session/removed"])(frame.sessionId); break;
        case "api-session/updated": (listener as SessionDirectoryListeners["api-session/updated"])(frame.sessionId, frame.blank, frame.seq); break;
        case "api-session/status": (listener as SessionDirectoryListeners["api-session/status"])(frame.sessionId, frame.running); break;
        case "api-session/activity": (listener as SessionDirectoryListeners["api-session/activity"])(frame.sessionId, frame.updatedAt); break;
        case "api-session/error": (listener as SessionDirectoryListeners["api-session/error"])(frame.sessionId, frame.message); break;
      }
    });
  }
  #emit(notice: SessionDirectoryFrame): void {
    this.#queue.push({ notice, listeners: [...this.#listeners] });
    if (this.#emitting) return;
    this.#emitting = true;
    try {
      while (this.#queue.length) {
        const item = this.#queue.shift()!;
        for (const listener of item.listeners) { try { listener(structuredClone(item.notice)); } catch (error) { console.error("目录监听失败", error); } }
      }
    } finally { this.#emitting = false; }
  }
  /**
   * 从当前会话建立比较基线并观察后续变化，Agent 停止后自动解除观察。
   * @param agent - 已完成加载且尚未受理新任务的 Agent。
   */
  observeAgent(agent: ReActAgent): void {
    const id = agent.session.header.sessionId;
    let baseline = { ...summarize(agent.session), running: agent.state === "running" };
    this.#live.set(id, { header: agent.session.header, inheritedEventCount: agent.session.inheritedEventCount, summary: baseline, revision: this.#revision, fieldRevision: 0, fieldSeq: -1 });
    if (this.#sessions.has(id)) this.#sessions.set(id, baseline);
    if (this.#temporary.has(id)) this.#temporary.set(id, baseline);
    const update = (summary: SessionSummary, fieldSeq?: number) => {
      baseline = summary;
      const prior = this.#live.get(id)!;
      this.#live.set(id, { ...prior, summary, revision: this.#revision + 1,
        fieldRevision: fieldSeq === undefined ? prior.fieldRevision : this.#revision + 1,
        fieldSeq: fieldSeq === undefined ? prior.fieldSeq : fieldSeq });
      if (this.#sessions.has(id)) this.#sessions.set(id, summary);
      if (this.#temporary.has(id)) this.#temporary.set(id, summary);
    };
    const stateOff = agent.onStateChange(state => {
      const running = state === "running";
      if (baseline.running === running) return;
      update({ ...baseline, running });
      this.#emit({ type: "api-session/status", sessionId: id, running, revision: ++this.#revision });
    });
    const observationOff = agent.onObservation(notice => {
      if (notice.type === "event") {
        const event = notice.event;
        if (event.type === "turn/start" && baseline.blank) {
          update({ ...baseline, blank: false }, event.seq);
          this.#emit({ type: "api-session/updated", sessionId: id, blank: false, seq: event.seq, revision: ++this.#revision });
        } else if (event.type === "user/message" && event.data.source.kind === "user" && event.time > baseline.updatedAt) {
          update({ ...baseline, updatedAt: event.time }, event.seq);
          this.#emit({ type: "api-session/activity", sessionId: id, updatedAt: event.time, revision: ++this.#revision });
        }
      }
    });
    const errorOff = agent.onDirectoryError((_turn, message) => this.#emit({ type: "api-session/error", sessionId: id, message }));
    agent.onStopped(() => { stateOff(); observationOff(); errorOff(); });
  }
  /**
   * 查询已提交清单，并同步合并尚在创建的条目与已加载会话。
   * @param persistence - 提供已提交清单的存储。
   * @param getOnline - 只读访问已加载会话及其运行状态，不触发加载。
   * @returns 同一合并截点的摘要与目录版本；清单读取失败时拒绝。
   */
  async query(persistence: Pick<SessionPersistence, "list">, getOnline: (id: string) => { session: Session; state: string } | undefined): Promise<SessionDirectorySnapshot> {
    let records: readonly SessionPersistenceSnapshot[];
    let before: number;
    let readRevision: number;
    let retriedOfflineChange = false;
    const startRevision = this.#revision;
    for (;;) {
      before = this.#confirmations;
      readRevision = this.#revision;
      records = await persistence.list();
      if (before !== this.#confirmations) continue;
      const offlineChanged = records.some(record => {
        const live = this.#live.get(record.header.sessionId);
        return live !== undefined && live.revision > readRevision && !getOnline(record.header.sessionId);
      });
      if (offlineChanged && !retriedOfflineChange) { retriedOfflineChange = true; continue; }
      break;
    }
    const summaries = new Map<string, SessionSummary>();
    for (const record of records) {
      const online = getOnline(record.header.sessionId);
      const a = record.header;
      const b = online?.session.header;
      const compatible = b && a.createdAt === b.createdAt && !!a.isSeeded === !!b.isSeeded &&
        (!a.isSeeded || (b.isSeeded && a.parentSession === b.parentSession && record.inheritedEventCount === online.session.inheritedEventCount));
      if (online && !compatible) console.error("在线会话与已提交身份冲突", a.sessionId);
      const live = this.#live.get(a.sessionId);
      const liveHeader = live?.header;
      const liveCompatible = liveHeader && a.createdAt === liveHeader.createdAt && !!a.isSeeded === !!liveHeader.isSeeded &&
        (!a.isSeeded || (liveHeader.isSeeded && a.parentSession === liveHeader.parentSession && record.inheritedEventCount === live.inheritedEventCount));
      const cold = summarizeCold(record);
      const checkpointCoversLive = live && record.listMetadata?.eventCount === record.eventCount &&
        record.listMetadata.inheritedEventCount === record.inheritedEventCount && record.eventCount > live.fieldSeq;
      const observedDuringRead = !online && live && liveCompatible && live.fieldRevision > startRevision && !checkpointCoversLive;
      summaries.set(a.sessionId, online && compatible ? { ...summarize(online.session), running: online.state === "running" } :
        observedDuringRead ? { ...cold, blank: cold.blank && live.summary.blank, updatedAt: Math.max(cold.updatedAt, live.summary.updatedAt) } : cold);
    }
    for (const [id, summary] of this.#temporary) if (!summaries.has(id)) summaries.set(id, summary);
    return { revision: this.#revision, sessions: [...summaries.values()].sort((a, b) => b.updatedAt - a.updatedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)) };
  }
  /**
   * 注册完整初始快照；同 ID 已存在时保持原摘要。
   * @param session - 已准备或发布的会话。
   * @param pending - 是否仍需确认首次提交。
   * @returns 新增目录项时为 true，已有同 ID 条目时为 false。
   */
  register(session: Session, pending = false): boolean {
    const summary = summarize(session);
    if (this.#sessions.has(summary.sessionId)) return false;
    this.#sessions.set(summary.sessionId, summary);
    if (pending) this.#temporary.set(summary.sessionId, summary);
    else this.#confirmations++;
    this.#emit({ type: "api-session/added", revision: ++this.#revision, summary: { ...summary } });
    return true;
  }
  /** @param sessionId - 已确认提交的会话标识；确认不改变版本。 */
  confirm(sessionId: string): void { if (this.#temporary.delete(sessionId)) this.#confirmations++; this.#unknown.delete(sessionId); }
  /** @param sessionId - 首次提交结果待核实的会话标识。 */
  markUnknown(sessionId: string): void { if (this.#temporary.has(sessionId)) this.#unknown.add(sessionId); }
  /** @param sessionId - 确认创建失败的会话标识。 */
  remove(sessionId: string): void {
    this.#temporary.delete(sessionId);
    this.#unknown.delete(sessionId);
    if (this.#sessions.delete(sessionId)) this.#emit({ type: "api-session/removed", sessionId, reason: "creation-failed", revision: ++this.#revision });
  }
  /** @param sessionId - 待读取核实的会话标识。 */
  isPending(sessionId: string): boolean { return this.#temporary.has(sessionId); }
  /** @param sessionId - 提交结果待核实的会话标识。 */
  isUnknown(sessionId: string): boolean { return this.#unknown.has(sessionId); }
}
