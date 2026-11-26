import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { snapshotSessionEvent, type SessionEvent } from "../events.ts";
import { SessionCreationCleanupError, SessionPersistence, type SessionAccess, type SessionHandle, type SessionPersistenceCreateOptions, type SessionPersistenceSnapshot } from "../persistence.ts";
import { isValidSessionId } from "../session-id.ts";
import type { Session, SessionHeader, StagedPersistenceResult } from "../session.ts";
import { SessionWriter } from "../writer.ts";
import { acquireSessionOwnership, OwnershipAcquisitionCleanupError, type Ownership } from "./ownership.ts";

type Row = Record<string, unknown>;
type Pending = { events: readonly SessionEvent[]; start: number; first: boolean; fromWriter?: boolean; staged?: boolean; preflightFailed?: boolean };
class StagedPrefixError extends Error {}

interface HandleStorage {
  readonly db: DatabaseSync;
  readonly reader: DatabaseSync;
  beginWrite(owner: SqliteHandle, transaction: object): void;
  rollbackWrite(owner: SqliteHandle): void;
  clearEndedTransaction(): void;
  abortWriteConnection(owner: SqliteHandle): void;
  confirmCreationEnded(owner: SqliteHandle, transaction: object | undefined): boolean;
  readFresh(id: string): SessionPersistenceSnapshot | undefined;
  release(ownership: Ownership): Promise<void>;
  forget(handle: SqliteHandle): void;
}

function position(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function alreadyExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function parseHeader(raw: unknown): SessionHeader {
  if (typeof raw !== "string") throw new Error("会话 header 无效");
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("会话 header 无效");
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (!isValidSessionId(item.sessionId)) throw new Error("会话标识无效");
  if (!position(item.createdAt) ||
    (item.isSeeded !== undefined && typeof item.isSeeded !== "boolean") ||
    (item.isSeeded === true ? typeof item.parentSession !== "string" || !item.parentSession : item.parentSession !== undefined) ||
    keys.some((key) => !["sessionId", "createdAt", "isSeeded", "parentSession"].includes(key))) {
    throw new Error("会话 header 无效");
  }
  return Object.freeze(value) as SessionHeader;
}

function metadata(row: Row): SessionPersistenceSnapshot {
  const header = parseHeader(row.header_json);
  if (header.sessionId !== row.session_id || !position(row.inherited_count) || !position(row.event_count) ||
    (header.isSeeded === true ? row.inherited_count >= row.event_count : row.inherited_count !== 0)) {
    throw new Error("会话元数据无效");
  }
  const result: SessionPersistenceSnapshot = { header, inheritedEventCount: row.inherited_count, eventCount: row.event_count };
  if ((row.blank === 0 || row.blank === 1) && (row.last_prompt_at === null || position(row.last_prompt_at)) &&
      (row.event_count !== 0 || row.last_prompt_at === null) &&
      position(row.checkpoint_event_count) && position(row.checkpoint_inherited_count)) {
    return { ...result, listMetadata: { blank: row.blank === 1, lastPromptAt: row.last_prompt_at,
      eventCount: row.checkpoint_event_count, inheritedEventCount: row.checkpoint_inherited_count } };
  }
  return result;
}

function verifySchema(db: DatabaseSync): void {
  const tables = db.prepare("SELECT name, strict FROM pragma_table_list WHERE name IN ('mh_sessions', 'mh_events') AND type = 'table'").all();
  if (tables.length !== 2 || tables.some((row) => row.strict !== 1)) throw new Error("数据库格式无效");
  for (const [table, expected] of [
    ["mh_sessions", ["session_id:TEXT:1", "header_json:TEXT:0", "inherited_count:INTEGER:0", "event_count:INTEGER:0"]],
    ["mh_events", ["session_id:TEXT:1", "seq:INTEGER:2", "event_json:TEXT:0"]],
  ] as const) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => `${row.name}:${row.type}:${row.pk}`);
    if (!isDeepStrictEqual(columns, expected)) throw new Error("数据库格式无效");
  }
  if (db.prepare("PRAGMA user_version").get()?.user_version === 2) {
    const table = db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'mh_session_list_metadata' AND type = 'table'").get();
    const columns = db.prepare("PRAGMA table_info(mh_session_list_metadata)").all().map((row) => `${row.name}:${row.type}:${row.pk}`);
    if (table?.strict !== 1 || !isDeepStrictEqual(columns, ["session_id:TEXT:1", "blank:INTEGER:0", "last_prompt_at:INTEGER:0", "event_count:INTEGER:0", "inherited_count:INTEGER:0"])) throw new Error("数据库格式无效");
  }
}

/** SQLite 持久化选项；只读模式不会创建或初始化数据库。 */
export interface SqliteSessionPersistenceOptions {
  readonly readOnly?: boolean;
}

/**
 * 新版 SQLite 事件存储；调用方关闭所有句柄后关闭此实例。
 * 会话标识必须非空、不含 NUL，并能经 UTF-8 无损往返。
 */
export class SqliteSessionPersistence extends SessionPersistence {
  readonly #path: string;
  readonly #db: DatabaseSync;
  readonly #reader: DatabaseSync;
  readonly #handleStorage: HandleStorage;
  readonly #handles = new Set<SqliteHandle>();
  readonly #cleanup = new Map<Ownership, ReturnType<typeof setTimeout> | undefined>();
  readonly #releasing = new Map<Ownership, Promise<void>>();
  readonly #acquiring = new Set<Promise<Ownership>>();
  readonly #readOnly: boolean;
  #closing?: Promise<void>;
  #writeClosed = false;
  #transactionOwner?: SqliteHandle;
  #transaction?: object;

  /**
   * 打开或初始化新版库；已有旧格式及未知版本均拒绝打开。
   * @param path - 显式指定的 SQLite 文件路径。
   * @param options - 只读模式不允许创建库或写入会话。
   * @throws 数据库格式、版本不受支持或打开失败时抛出。
   */
  constructor(path: string, options: SqliteSessionPersistenceOptions = {}) {
    super();
    this.#readOnly = options.readOnly ?? false;
    if (path === ":memory:") throw new Error("存储需要可由独立连接观察的数据库路径");
    this.#path = resolve(path);
    const existed = alreadyExists(this.#path);
    if (existed) {
      const probe = new DatabaseSync(this.#path, { readOnly: true });
      try {
        if (![1, 2].includes(Number(probe.prepare("PRAGMA user_version").get()?.user_version))) throw new Error("不支持的数据库格式或版本");
        verifySchema(probe);
      } finally { probe.close(); }
    }
    this.#db = new DatabaseSync(this.#path, { readOnly: this.#readOnly, enableForeignKeyConstraints: true, timeout: 5000 });
    try {
      const version = this.#db.prepare("PRAGMA user_version").get()?.user_version;
      const objects = this.#db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
      if (!existed && version === 0 && objects.length === 0 && !this.#readOnly) {
        this.#db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE mh_sessions (session_id TEXT PRIMARY KEY NOT NULL, header_json TEXT NOT NULL, inherited_count INTEGER NOT NULL CHECK(inherited_count >= 0), event_count INTEGER NOT NULL CHECK(event_count >= 0)) STRICT;
          CREATE TABLE mh_events (session_id TEXT NOT NULL REFERENCES mh_sessions(session_id), seq INTEGER NOT NULL CHECK(seq >= 0), event_json TEXT NOT NULL, PRIMARY KEY(session_id, seq)) STRICT;
          PRAGMA user_version = 1;
          COMMIT;`);
      } else if (version !== 1 && version !== 2) throw new Error("不支持的数据库格式或版本");
      verifySchema(this.#db);
      this.#reader = new DatabaseSync(this.#path, { readOnly: true, timeout: 5000 });
    } catch (error) { this.#db.close(); throw error; }
    this.#handleStorage = {
      db: this.#db,
      reader: this.#reader,
      beginWrite: (owner, transaction) => this.#beginWrite(owner, transaction),
      rollbackWrite: (owner) => this.#rollbackWrite(owner),
      clearEndedTransaction: () => this.#clearEndedTransaction(),
      abortWriteConnection: (owner) => this.#abortWriteConnection(owner),
      confirmCreationEnded: (owner, transaction) => {
        if (!transaction || this.#transaction !== transaction || this.#transactionOwner !== owner || this.#writeClosed || !this.#db.isTransaction) return true;
        try { this.#rollbackWrite(owner); } catch { try { this.#abortWriteConnection(owner); } catch { if (!this.#writeClosed) return false; } }
        return this.#writeClosed || !this.#db.isTransaction || this.#transactionOwner !== owner;
      },
      readFresh: (id) => {
        const reader = new DatabaseSync(this.#path, { readOnly: true, timeout: 5000 });
        try {
          const row = reader.prepare("SELECT * FROM mh_sessions WHERE session_id=?").get(id);
          return row ? metadata(row) : undefined;
        } finally { reader.close(); }
      },
      forget: (handle) => this.#handles.delete(handle),
      release: (ownership) => this.#release(ownership),
    };
  }

  async create(header: SessionHeader, options: SessionPersistenceCreateOptions = {}): Promise<SessionHandle> {
    this.#writable();
    const checked = parseHeader(JSON.stringify(header));
    const inherited = options.inheritedEventCount ?? 0;
    if (!position(inherited) || (checked.isSeeded !== true && inherited !== 0)) throw new Error("继承数量无效");
    options.signal?.throwIfAborted();
    let ownership: Ownership;
    try { ownership = await this.#acquire(checked.sessionId); }
    catch (error) {
      if (error instanceof OwnershipAcquisitionCleanupError) {
        throw new SessionCreationCleanupError(error, async () => {
          try { await this.#release(error.ownership); return "failed"; } catch { return "unknown"; }
        });
      }
      throw error;
    }
    try {
      options.signal?.throwIfAborted();
      this.#assertOpen();
      if (this.#stat(checked.sessionId)) throw new Error("会话已存在");
      return this.#track(new SqliteHandle(this.#handleStorage, checked, "write", inherited, ownership, false));
    } catch (error) {
      try { await this.#release(ownership); } catch {
        throw new SessionCreationCleanupError(error, async () => {
          try { await this.#release(ownership); return "failed"; } catch { return "unknown"; }
        });
      }
      throw error;
    }
  }

  async open(sessionId: string, access: SessionAccess): Promise<SessionHandle | undefined> {
    this.#assertOpen();
    if (!isValidSessionId(sessionId) || (access !== "read" && access !== "write")) {
      throw new Error("会话标识或访问模式无效");
    }
    if (access === "write") this.#writable();
    if (!this.#stat(sessionId)) return undefined;
    const ownership = access === "write" ? await this.#acquire(sessionId) : undefined;
    try {
      this.#assertOpen();
      const info = this.#stat(sessionId);
      if (!info) { if (ownership) await this.#release(ownership); return undefined; }
      return this.#track(new SqliteHandle(this.#handleStorage, info.header, access, info.inheritedEventCount, ownership, true));
    } catch (error) { if (ownership) await this.#release(ownership); throw error; }
  }

  async stat(sessionId: string): Promise<SessionPersistenceSnapshot | undefined> {
    this.#assertOpen();
    if (!isValidSessionId(sessionId)) throw new Error("会话标识无效");
    return this.#stat(sessionId);
  }
  async list(): Promise<readonly SessionPersistenceSnapshot[]> {
    this.#assertOpen();
    const version = this.#reader.prepare("PRAGMA user_version").get()?.user_version;
    return this.#reader.prepare(version === 2
      ? `SELECT s.*,
          CASE WHEN c.blank BETWEEN 0 AND 9007199254740991 THEN c.blank END AS blank,
          CASE WHEN c.last_prompt_at BETWEEN 0 AND 9007199254740991 THEN c.last_prompt_at WHEN c.last_prompt_at IS NULL THEN NULL ELSE -1 END AS last_prompt_at,
          CASE WHEN c.event_count BETWEEN 0 AND 9007199254740991 THEN c.event_count END AS checkpoint_event_count,
          CASE WHEN c.inherited_count BETWEEN 0 AND 9007199254740991 THEN c.inherited_count END AS checkpoint_inherited_count
        FROM mh_sessions s LEFT JOIN mh_session_list_metadata c USING(session_id) ORDER BY s.session_id`
      : "SELECT * FROM mh_sessions ORDER BY session_id").all().map(metadata);
  }

  /**
   * 显式升级目录检查点结构；调用方须先独占实例，旧事件不会被扫描。
   * @throws 只读、存储关闭或升级事务失败时抛出。
   */
  upgradeDirectoryMetadata(): void {
    this.#writable();
    if (this.#db.prepare("PRAGMA user_version").get()?.user_version === 2) return;
    this.#clearEndedTransaction();
    try {
      this.#db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE mh_session_list_metadata (session_id TEXT PRIMARY KEY NOT NULL REFERENCES mh_sessions(session_id), blank INTEGER NOT NULL, last_prompt_at INTEGER, event_count INTEGER NOT NULL, inherited_count INTEGER NOT NULL) STRICT;
        PRAGMA user_version = 2;
        COMMIT;`);
    } catch (error) { if (this.#db.isTransaction) this.#db.exec("ROLLBACK"); throw error; }
  }

  /**
   * 将已经持久化初始前缀的写句柄绑定到在线会话。调用方须在发布会话前完成绑定。
   * @param handle - 本存储持有的已提交写句柄，关闭它会先排空相应缓冲。
   * @param session - 已从该句柄恢复或以相同初始前缀准备的会话。
   * @param reportError - 后台排空失败的告警入口，省略时输出诊断。
   * @throws 句柄不可写、会话身份不符或重复绑定时抛出。
   */
  bindWriter(handle: SessionHandle, session: Session, reportError?: (error: unknown) => void): void {
    this.#assertOpen();
    if (!(handle instanceof SqliteHandle) || !this.#handles.has(handle)) {
      throw new Error("会话句柄不属于本存储");
    }
    handle.bindWriter(session, reportError);
  }

  async flush(): Promise<void> {
    this.#assertOpen();
    const writers = Array.from(this.#handles)
      .flatMap(({ id, writer }) => writer ? [{ id, writer }] : []);
    const errors: Error[] = [];
    for (const { id, writer } of writers) {
      try {
        await writer.flush();
      } catch (cause) {
        errors.push(Object.assign(new Error(`会话 ${id} 排空失败`, { cause }), { sessionId: id }));
      }
    }
    if (errors.length) throw new AggregateError(errors, "会话排空失败");
  }

  /**
   * 关闭各句柄并释放连接，停止写入权清理重试并尝试释放余留锁。任一关闭失败时仍处理其余资源，重复调用共享关闭结果。
   * @returns 所有资源处理完毕后兑现。
   * @throws 排空或关闭失败时以 AggregateError 汇总。
   */
  close(): Promise<void> {
    this.#closing ??= this.#closeHandles();
    return this.#closing;
  }

  async #closeHandles(): Promise<void> {
    const errors: unknown[] = [];
    await Promise.allSettled(this.#acquiring);
    for (const handle of [...this.#handles]) { try { await handle.close(); } catch (error) { errors.push(error); } }
    for (const [ownership, timer] of this.#cleanup) {
      if (timer) clearTimeout(timer);
      const inFlight = this.#releasing.get(ownership);
      if (inFlight) { try { await inFlight; } catch { /* 扫尾须在在途释放结束后独立重试。 */ } }
      if (this.#cleanup.has(ownership)) {
        try { await this.#release(ownership); } catch (error) { errors.push(error); }
      }
    }
    for (const connection of this.#writeClosed ? [this.#reader] : [this.#reader, this.#db]) {
      try { connection.close(); } catch (error) { errors.push(error); }
      finally { if (connection === this.#db && !connection.isOpen) { this.#writeClosed = true; this.#clearEndedTransaction(); } }
    }
    if (errors.length) throw new AggregateError(errors, "关闭存储失败");
  }

  #assertOpen(): void { if (this.#closing) throw new Error("存储已关闭"); }
  #acquire(sessionId: string): Promise<Ownership> {
    const acquiring = acquireSessionOwnership(this.#path, sessionId).then((ownership) => {
      this.#cleanup.set(ownership, undefined);
      return ownership;
    }, (error: unknown) => {
      if (error instanceof OwnershipAcquisitionCleanupError) this.#scheduleCleanup(error.ownership);
      throw error;
    });
    this.#acquiring.add(acquiring);
    void acquiring.finally(() => this.#acquiring.delete(acquiring)).catch(() => {});
    return acquiring;
  }
  #release(ownership: Ownership): Promise<void> {
    const existing = this.#releasing.get(ownership);
    if (existing) return existing;
    const releasing = this.#performRelease(ownership);
    this.#releasing.set(ownership, releasing);
    void releasing.finally(() => this.#releasing.delete(ownership)).catch(() => {});
    return releasing;
  }
  async #performRelease(ownership: Ownership): Promise<void> {
    const timer = this.#cleanup.get(ownership);
    if (timer) clearTimeout(timer);
    this.#cleanup.set(ownership, undefined);
    try {
      await ownership.release();
      this.#cleanup.delete(ownership);
    } catch (error) {
      this.#scheduleCleanup(ownership);
      throw error;
    }
  }
  #scheduleCleanup(ownership: Ownership): void {
    if (this.#closing) { this.#cleanup.set(ownership, undefined); return; }
    const retry = setTimeout(() => { void this.#release(ownership).catch(() => {}); }, 250);
    retry.unref();
    this.#cleanup.set(ownership, retry);
  }
  #writable(): void { this.#assertOpen(); if (this.#readOnly || this.#writeClosed) throw new Error("存储为只读或写连接已关闭"); }
  #track(handle: SqliteHandle): SqliteHandle { this.#handles.add(handle); return handle; }
  #stat(id: string): SessionPersistenceSnapshot | undefined {
    const row = this.#reader.prepare("SELECT * FROM mh_sessions WHERE session_id=?").get(id);
    return row ? metadata(row) : undefined;
  }
  #beginWrite(owner: SqliteHandle, transaction: object): void {
    if (this.#db.isTransaction) throw new Error("其他事务尚未结束");
    this.#clearEndedTransaction();
    this.#transactionOwner = owner;
    this.#transaction = transaction;
    this.#db.exec("BEGIN IMMEDIATE");
  }
  #rollbackWrite(owner: SqliteHandle): void {
    // 失败批次的核对可能晚于另一会话开始写入，只有原所有者可以回滚其事务。
    if (this.#transactionOwner !== owner) return;
    if (this.#writeClosed || !this.#db.isTransaction) { this.#clearEndedTransaction(); return; }
    try { this.#db.exec("ROLLBACK"); } finally { this.#clearEndedTransaction(); }
    if (this.#db.isTransaction) throw new Error("原事务尚未结束");
  }
  #abortWriteConnection(owner: SqliteHandle): void {
    if (this.#transactionOwner === owner && !this.#writeClosed && this.#db.isTransaction) {
      try { this.#db.close(); }
      finally { if (!this.#db.isOpen) this.#writeClosed = true; this.#clearEndedTransaction(); }
    }
  }
  #clearEndedTransaction(): void {
    if (this.#writeClosed || !this.#db.isTransaction) { this.#transactionOwner = undefined; this.#transaction = undefined; }
  }
}

class SqliteHandle implements SessionHandle {
  readonly id: string;
  #closing?: Promise<void>;
  #pending?: Pending;
  #writer?: SessionWriter;
  #session?: Session;
  #creationTransaction?: object;
  constructor(private readonly store: HandleStorage, readonly header: SessionHeader, readonly access: SessionAccess,
    readonly inheritedEventCount: number, private readonly ownership: Ownership | undefined, public published: boolean) { this.id = header.sessionId; }
  get writer(): SessionWriter | undefined { return this.#closing ? undefined : this.#writer; }

  async confirmCreationEnded(): Promise<boolean> {
    if (!this.#closing) return false;
    try { await this.#closing; } catch { /* 关闭失败后仍须核实事务。 */ }
    return this.store.confirmCreationEnded(this, this.#creationTransaction);
  }

  creationVerifier(): () => Promise<"committed" | "failed" | "unknown"> {
    return async () => {
      try {
        const first = this.store.readFresh(this.id);
        if (first) return isDeepStrictEqual(first.header, this.header) ? "committed" : "unknown";
        if (!await this.confirmCreationEnded()) return "unknown";
        const second = this.store.readFresh(this.id);
        if (second) return isDeepStrictEqual(second.header, this.header) ? "committed" : "unknown";
        if (!this.#closing) return "unknown";
        try { if (this.ownership) await this.store.release(this.ownership); } catch { return "unknown"; }
        return "failed";
      } catch { return "unknown"; }
    };
  }

  bindWriter(session: Session, reportError?: (error: unknown) => void): void {
    this.#check(true);
    if (!this.published || this.#writer || session.header.sessionId !== this.id ||
      session.inheritedEventCount !== this.inheritedEventCount) {
      throw new Error("会话写入器要求已提交的同一会话及未绑定的句柄");
    }
    this.#writer = new SessionWriter(session, {
      append: async (events) => this.#append(events, true),
      flush: async () => this.#flush(),
      read: async (offset, length) => this.#read(offset, length),
      commitStaged: async (events) => this.#commitStaged(events),
      reconcileStaged: async () => this.#reconcileStaged(),
    }, reportError);
    this.#session = session;
  }

  #check(write = false): void { if (this.#closing) throw new Error("句柄已关闭"); if (write && this.access !== "write") throw new Error("句柄为只读"); }

  async read(offset = 0, length?: number): Promise<readonly SessionEvent[]> {
    this.#check();
    return this.#read(offset, length);
  }

  #read(offset = 0, length?: number): readonly SessionEvent[] {
    const db = this.store.reader;
    try {
      db.exec("BEGIN");
      const row = db.prepare("SELECT COUNT(*) AS count, MIN(seq) AS first, MAX(seq) AS last FROM mh_events WHERE session_id=?").get(this.id);
      const count = row?.count;
      const meta = db.prepare("SELECT * FROM mh_sessions WHERE session_id=?").get(this.id);
      if (this.published) {
        if (!meta) throw new Error("持久会话元数据缺失");
        const info = metadata(meta);
        if (!isDeepStrictEqual(info.header, this.header) || info.inheritedEventCount !== this.inheritedEventCount) {
          throw new Error("持久会话元数据不一致");
        }
        if (info.eventCount !== count) throw new Error("持久事件数量不一致");
      }
      if (!position(count) || (count > 0 && (row?.first !== 0 || row?.last !== count - 1))) throw new Error("持久事件前缀不连续");
      const size = length ?? (count - offset);
      if (!position(offset) || !position(size) || offset > count || size > count - offset) throw new RangeError("会话事件范围未提交");
      const rows = db.prepare("SELECT seq, event_json FROM mh_events WHERE session_id=? AND seq>=? AND seq<? ORDER BY seq").all(this.id, offset, offset + size);
      if (rows.length !== size) throw new Error("持久事件前缀不连续");
      const events = rows.map((entry, index) => {
        if (entry.seq !== offset + index || typeof entry.event_json !== "string") throw new Error("持久事件无效");
        return snapshotSessionEvent(JSON.parse(entry.event_json), offset + index, "replay");
      });
      db.exec("COMMIT");
      return events;
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  }
  async append(events: readonly SessionEvent[]): Promise<void> {
    this.#check(true);
    if (this.#session?.stagedOccupied) throw new Error("会话暂存写入占用中");
    if (this.#pending?.fromWriter) throw new Error("须先经会话写入器核对待定批次");
    this.#append(events);
  }

  #append(events: readonly SessionEvent[], fromWriter = false): void {
    if (this.#pending) {
      const same = isDeepStrictEqual(events, this.#pending.events);
      if (!same) throw new Error("须先完成原待核对批次");
      const committed = this.#reconcile();
      if (committed) return;
    }
    const row = this.store.reader.prepare("SELECT COUNT(*) AS count, MIN(seq) AS first, MAX(seq) AS last FROM mh_events WHERE session_id=?").get(this.id);
    const start = row?.count;
    const expected = this.store.reader.prepare("SELECT event_count FROM mh_sessions WHERE session_id=?").get(this.id);
    if (this.published && expected?.event_count !== start) throw new Error("持久事件数量不一致");
    if (!position(start) || (start > 0 && (row?.first !== 0 || row?.last !== start - 1))) throw new Error("持久事件前缀不连续");
    const batch = events.map((event, index) => snapshotSessionEvent(event, start + index, "replay"));
    if (batch.length === 0) return;
    const marker = batch.findLast((event) => event.type === "session/end-seed");
    const expectedMarker = !this.published && this.header.isSeeded === true ? this.inheritedEventCount : undefined;
    if (marker?.seq !== expectedMarker) throw new Error("持久批次没有匹配的继承标记");
    this.#commit({ events: batch, start, first: !this.published, fromWriter });
  }
  async flush(): Promise<void> {
    this.#check(true);
    if (this.#session?.stagedOccupied) {
      if (!this.#writer?.stagedReconciliationPending) throw new Error("会话暂存写入占用中");
      await this.#writer.flush();
      return;
    }
    if (this.#pending?.fromWriter) {
      await this.#writer!.confirmPendingBatch(this.#pending.start);
      return;
    }
    this.#flush();
  }

  #flush(): void {
    if (this.#pending) {
      if (this.#pending.staged) throw new Error("暂存批次须先核对");
      const pending = this.#pending;
      if (!this.#reconcile()) this.#commit(pending);
    }
    if (!this.published) {
      if (this.header.isSeeded === true) throw new Error("分支需要原子提交初始前缀和继承标记");
      this.#commit({ events: [], start: 0, first: true });
    }
  }
  #commitStaged(events: readonly SessionEvent[]): StagedPersistenceResult {
    const start = events[0]?.seq;
    if (start === undefined || this.#pending) throw new Error("暂存批次或写入状态无效");
    if (this.store.db.isTransaction) throw new Error("其他事务尚未结束");
    try {
      this.#commit({ events, start, first: false, staged: true, preflightFailed: true });
      return { status: "committed" };
    } catch (error) {
      if (this.#pending) return { status: "pending-reconciliation", error };
      if (error instanceof StagedPrefixError) throw error;
      return { status: "rolled-back", error };
    }
  }
  #reconcileStaged(): StagedPersistenceResult {
    if (!this.#pending?.staged) throw new Error("没有待核对的暂存批次");
    try {
      return this.#reconcile() ? { status: "committed" } : { status: "rolled-back", error: new Error("暂存事务已回滚") };
    } catch (error) { return { status: "pending-reconciliation", error }; }
  }
  close(): Promise<void> {
    this.#closing ??= this.#finishClose();
    return this.#closing;
  }

  async #finishClose(): Promise<void> {
    try {
      await this.#writer?.close();
      if (this.#pending) this.#reconcile();
    } catch (error) {
      this.store.abortWriteConnection(this);
      throw error;
    } finally { this.store.forget(this); if (this.ownership) await this.store.release(this.ownership); }
  }
  #commit(batch: Pending): void {
    const db = this.store.db;
    if (db.isTransaction) throw new Error("其他事务尚未结束");
    this.#pending = batch;
    try {
      const transaction = {};
      if (batch.first) this.#creationTransaction = transaction;
      this.store.beginWrite(this, transaction);
      if (batch.staged) {
        const meta = db.prepare("SELECT * FROM mh_sessions WHERE session_id=?").get(this.id);
        const rows = db.prepare("SELECT COUNT(*) AS count, MIN(seq) AS first, MAX(seq) AS last FROM mh_events WHERE session_id=?").get(this.id);
        let headerMatches = false;
        try { headerMatches = !!meta && isDeepStrictEqual(metadata(meta).header, this.header); } catch { /* 损坏元数据属于前缀故障。 */ }
        if (!meta || !headerMatches || meta.inherited_count !== this.inheritedEventCount ||
          meta.event_count !== batch.start || rows?.count !== batch.start ||
          (batch.start > 0 && (rows.first !== 0 || rows.last !== batch.start - 1))) {
          throw new StagedPrefixError("暂存前持久前缀不一致");
        }
        batch.preflightFailed = false;
      }
      if (batch.first) db.prepare("INSERT INTO mh_sessions VALUES (?, ?, ?, 0)").run(this.id, JSON.stringify(this.header), this.inheritedEventCount);
      if (batch.first && batch.events.length === 0 && db.prepare("PRAGMA user_version").get()?.user_version === 2) {
        db.prepare("INSERT INTO mh_session_list_metadata VALUES (?, 1, NULL, 0, 0)").run(this.id);
      }
      const insert = db.prepare("INSERT INTO mh_events VALUES (?, ?, ?)");
      for (const event of batch.events) insert.run(this.id, event.seq, JSON.stringify(event));
      const result = db.prepare("UPDATE mh_sessions SET event_count=? WHERE session_id=? AND event_count=?").run(batch.start + batch.events.length, this.id, batch.start);
      if (result.changes !== 1) throw new Error("持久游标冲突");
      try { db.exec("COMMIT"); } finally { this.store.clearEndedTransaction(); }
      this.published = true;
      this.#pending = undefined;
    } catch (error) {
      try { this.store.rollbackWrite(this); } catch { throw error; }
      if (error instanceof StagedPrefixError) { this.#pending = undefined; throw error; }
      try { if (this.#reconcile()) return; } catch { /* 保留待核对批次供后续显式操作处理。 */ }
      throw error;
    }
  }
  #reconcile(): boolean {
    const pending = this.#pending;
    if (!pending) return false;
    try { this.store.rollbackWrite(this); } catch (cause) {
      throw new Error("原事务尚未结束", { cause });
    }
    const reader = this.store.reader;
    try {
    reader.exec("BEGIN");
    const row = reader.prepare("SELECT header_json, inherited_count, event_count FROM mh_sessions WHERE session_id=?").get(this.id);
    const shape = reader.prepare("SELECT COUNT(*) AS count, MIN(seq) AS first, MAX(seq) AS last FROM mh_events WHERE session_id=?").get(this.id);
    const rows = reader.prepare("SELECT seq, event_json FROM mh_events WHERE session_id=? AND seq>=? AND seq<? ORDER BY seq").all(this.id, pending.start, pending.start + pending.events.length);
    const contiguous = (count: number) => shape?.count === count && (count === 0 || (shape.first === 0 && shape.last === count - 1));
    const headerMatches = row && typeof row.header_json === "string" && isDeepStrictEqual(parseHeader(row.header_json), this.header) && row.inherited_count === this.inheritedEventCount;
    if ((pending.first ? !row : !!row && headerMatches && row.event_count === pending.start) && contiguous(pending.start) && rows.length === 0 && (pending.events.length > 0 || !row)) {
      reader.exec("COMMIT");
      this.#pending = undefined;
      return false;
    }
    if (!pending.preflightFailed && headerMatches && row.event_count === pending.start + pending.events.length && contiguous(pending.start + pending.events.length) && rows.length === pending.events.length && rows.every((entry, index) =>
      entry.seq === pending.start + index && typeof entry.event_json === "string" && isDeepStrictEqual(JSON.parse(entry.event_json), pending.events[index]))) {
      reader.exec("COMMIT");
      this.published = true;
      this.#pending = undefined;
      return true;
    }
    throw new Error("事务结果冲突或不完整，写入保持阻塞");
    } catch (error) { if (reader.isTransaction) reader.exec("ROLLBACK"); throw error; }
  }
}
