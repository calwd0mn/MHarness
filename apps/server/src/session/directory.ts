import { sessionSummarySchema, type SessionDirectorySnapshot, type SessionSummary } from "@mharness/session/contracts";
import { Session, type SessionPersistence, type SessionPersistenceSnapshot } from "@mharness/session/server";

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
export class SessionDirectory {
  readonly #sessions = new Map<string, SessionSummary>();
  readonly #temporary = new Map<string, SessionSummary>();
  readonly #unknown = new Set<string>();
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
   * 查询已提交清单，并同步合并尚在创建的条目与已加载会话。
   * @param persistence - 提供已提交清单的存储。
   * @param getOnline - 只读访问已加载会话及其运行状态，不触发加载。
   * @returns 同一合并截点的摘要与目录版本；清单读取失败时拒绝。
   */
  async query(persistence: Pick<SessionPersistence, "list">, getOnline: (id: string) => { session: Session; state: string } | undefined): Promise<SessionDirectorySnapshot> {
    let records: readonly SessionPersistenceSnapshot[];
    let before: number;
    do { before = this.#confirmations; records = await persistence.list(); } while (before !== this.#confirmations);
    const summaries = new Map<string, SessionSummary>();
    for (const record of records) {
      const online = getOnline(record.header.sessionId);
      const a = record.header;
      const b = online?.session.header;
      const compatible = b && a.createdAt === b.createdAt && !!a.isSeeded === !!b.isSeeded &&
        (!a.isSeeded || (b.isSeeded && a.parentSession === b.parentSession && record.inheritedEventCount === online.session.inheritedEventCount));
      if (online && !compatible) console.error("在线会话与已提交身份冲突", a.sessionId);
      summaries.set(a.sessionId, online && compatible ? { ...summarize(online.session), running: online.state === "running" } : summarizeCold(record));
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
    this.#revision++;
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
    if (this.#sessions.delete(sessionId)) this.#revision++;
  }
  /** @param sessionId - 待读取核实的会话标识。 */
  isPending(sessionId: string): boolean { return this.#temporary.has(sessionId); }
  /** @param sessionId - 提交结果待核实的会话标识。 */
  isUnknown(sessionId: string): boolean { return this.#unknown.has(sessionId); }
}
