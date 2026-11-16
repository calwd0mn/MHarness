import { sessionRecordSchema, type SessionRecord } from "../api/history.ts";
import { DatabaseSync } from "node:sqlite";

type Unsequenced<T> = T extends SessionRecord ? Omit<T, "seq" | "timestamp"> : never;
type SessionEvent = Unsequenced<SessionRecord>;

/** 已有 Turn 的持久更新。用户消息只能与新 Turn 一起提交。 */
export type SessionUpdate = Exclude<SessionEvent, { type: "user/message" }>;

/** 从同一次读取获得的持久历史，记录按会话序号升序排列。 */
export interface SessionHistory {
  /** 按会话序号升序排列的已提交记录。 */
  records: SessionRecord[];
  /** 最后一条已提交记录的序号，空会话为 0。 */
  cursor: number;
}

/** 只有 accepted 携带已提交的记录，其他结果不写入用户消息。 */
export type AcceptTurnResult =
  | { status: "accepted"; records: SessionRecord[] }
  | { status: "busy" }
  | { status: "not_found" };

function parseStoredRecord(raw: unknown): SessionRecord {
  if (typeof raw !== "string") throw new Error("持久记录格式无效");
  return sessionRecordSchema.parse(JSON.parse(raw));
}

function interruptionUpdates(turnId: string, records: SessionRecord[]): SessionUpdate[] {
  const startedCalls = new Map<string, Extract<SessionRecord, { type: "tool/started" }>["data"]>();
  const pendingApprovals = new Map<
    string, Extract<SessionRecord, { type: "approval/requested" }>["data"]
  >();

  for (const record of records) {
    if (record.type === "tool/started" || record.type === "tool/result") {
      const key = JSON.stringify([record.data.stepId, record.data.callId]);
      if (record.type === "tool/started") startedCalls.set(key, record.data);
      else startedCalls.delete(key);
    } else if (record.type === "approval/requested") {
      pendingApprovals.set(record.data.operationId, record.data);
    } else if (record.type === "approval/resolved") {
      pendingApprovals.delete(record.data.operationId);
    }
  }

  const updates: SessionUpdate[] = [];
  for (const { stepId, callId, operationId } of pendingApprovals.values()) {
    updates.push({
      type: "approval/resolved",
      data: { turnId, stepId, callId, operationId, status: "cancelled" },
    });
  }
  for (const { stepId, callId } of startedCalls.values()) {
    updates.push({
      type: "tool/result",
      data: { turnId, stepId, callId, status: "unknown", reason: "process_interrupted" },
    });
  }
  updates.push({
    type: "turn/status",
    data: { turnId, status: "interrupted", reason: "process_interrupted" },
  });
  return updates;
}

/** 管理 SQLite 中的会话历史和活动 Turn 约束。调用方负责关闭连接。 */
export class SessionStore {
  private readonly db: DatabaseSync;

  /**
   * 打开存储并初始化表结构。
   * @param path - SQLite 文件路径，传入 `:memory:` 可创建仅当前连接可见的存储。
   * @throws 数据库无法打开、使用新版格式或表结构无法初始化时抛出错误。
   */
  constructor(path: string) {
    this.db = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });

    try {
      this.writeTransaction(() => {
        if (this.db.prepare("PRAGMA user_version").get()?.user_version !== 0) {
          throw new Error("旧版会话存储不能打开已版本化的数据库");
        }
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY NOT NULL
          ) STRICT;

          CREATE TABLE IF NOT EXISTS turns (
            session_id TEXT NOT NULL REFERENCES sessions(session_id),
            turn_id TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL CHECK (status IN (
              'running', 'awaiting_approval', 'succeeded', 'truncated', 'failed', 'cancelled', 'interrupted'
            )),
            PRIMARY KEY (session_id, turn_id)
          ) STRICT;

          CREATE UNIQUE INDEX IF NOT EXISTS one_active_turn_per_session
          ON turns(session_id) WHERE status IN ('running', 'awaiting_approval');

          CREATE TABLE IF NOT EXISTS session_records (
            session_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            seq INTEGER NOT NULL CHECK (seq > 0),
            record_json TEXT NOT NULL,
            PRIMARY KEY (session_id, seq),
            FOREIGN KEY (session_id, turn_id) REFERENCES turns(session_id, turn_id)
          ) STRICT;
        `);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /**
   * 提交一个空会话，读取时初始游标为 0。
   * @param sessionId - 新会话的唯一标识。
   * @throws 标识为空、重复或写入失败时抛出错误。
   */
  createSession(sessionId: string): void {
    if (!sessionId) throw new Error("会话标识不能为空");
    this.db.prepare("INSERT INTO sessions (session_id) VALUES (?)").run(sessionId);
  }

  /**
   * 同时提交用户消息和初始 Turn 状态。等待审批的 Turn 仍占用会话。
   * @param sessionId - 接收用户输入的会话。
   * @param turnId - 为本次提交分配的唯一 Turn 标识。
   * @param text - 要持久保存的非空用户消息。
   * @returns accepted 表示两条记录已一起提交。busy 或 not_found 表示本次没有写入。
   * @throws Turn 标识重复、消息不符合协议或存储失败时抛出错误。
   */
  acceptTurn(sessionId: string, turnId: string, text: string): AcceptTurnResult {
    return this.writeTransaction(() => {
      if (!this.hasSession(sessionId)) return { status: "not_found" };

      const active = this.db.prepare(`
        SELECT 1 FROM turns WHERE session_id = ? AND status IN ('running', 'awaiting_approval')
      `).get(sessionId);
      if (active) return { status: "busy" };

      this.db.prepare(`
        INSERT INTO turns (session_id, turn_id, status) VALUES (?, ?, 'running')
      `).run(sessionId, turnId);

      const records = this.insertRecords(sessionId, [
        { type: "user/message", data: { turnId, text } },
        { type: "turn/status", data: { turnId, status: "running" } },
      ]);
      return { status: "accepted", records };
    });
  }

  /**
   * 按提供顺序一次提交整批更新。Turn 状态记录和活动状态约束随批次一起更新。
   * @param sessionId - 已存在的目标会话。
   * @param updates - 属于该会话已有 Turn 的更新，按预期的持久顺序提供。
   * @returns 本批已提交的记录。空批次返回空数组，不消耗序号。
   * @throws 会话或关联 Turn 不存在、更新不符合协议、为已结算的 Turn 再写入状态或存储失败时整批回滚。
   */
  appendRecords(sessionId: string, updates: readonly SessionUpdate[]): SessionRecord[] {
    return this.writeTransaction(() => {
      if (!this.hasSession(sessionId)) throw new Error("会话不存在");
      return this.insertRecords(sessionId, updates);
    });
  }

  /**
   * 启动时结算遗留活动 Turn，在一个事务中保存工具未知结果、审批作废和 Turn 中断。
   * 只在独占此数据库的服务开始处理请求前调用。已经结算的 Turn 不会重复追加记录。
   * @throws 读到不符合协议的记录或恢复写入失败时回滚，调用方应中止启动。
   */
  recoverInterruptedTurns(): void {
    this.writeTransaction(() => {
      const activeTurns = this.db.prepare(`
        SELECT session_id, turn_id FROM turns WHERE status IN ('running', 'awaiting_approval')
      `).all();
      const readTurnRecords = this.db.prepare(`
        SELECT record_json FROM session_records WHERE session_id = ? AND turn_id = ? ORDER BY seq
      `);

      for (const { session_id: sessionId, turn_id: turnId } of activeTurns) {
        if (typeof sessionId !== "string" || typeof turnId !== "string") {
          throw new Error("遗留 Turn 标识无效");
        }
        const records = readTurnRecords.all(sessionId, turnId)
          .map(({ record_json }) => parseStoredRecord(record_json));
        this.insertRecords(sessionId, interruptionUpdates(turnId, records));
      }
    });
  }

  /**
   * 从同一次读取返回完整的已提交历史和游标。
   * @param sessionId - 要读取的会话。
   * @returns 会话不存在时返回 undefined。存在但没有事件时返回空历史及游标 0。
   * @throws 数据库读取失败或存储中的记录不符合协议时抛出错误。
   */
  readSession(sessionId: string): SessionHistory | undefined {
    const rows = this.db.prepare(`
      SELECT r.record_json FROM sessions AS s
      LEFT JOIN session_records AS r ON r.session_id = s.session_id
      WHERE s.session_id = ?
      ORDER BY r.seq
    `).all(sessionId);
    if (rows.length === 0) return undefined;

    const records = rows.flatMap(({ record_json }) =>
      record_json === null ? [] : [parseStoredRecord(record_json)],
    );
    return { records, cursor: records.at(-1)?.seq ?? 0 };
  }

  /** 释放当前实例的 SQLite 连接。调用后不再使用该实例。 */
  close(): void {
    this.db.close();
  }

  private hasSession(sessionId: string): boolean {
    return this.db.prepare("SELECT 1 FROM sessions WHERE session_id = ?").get(sessionId) !== undefined;
  }

  private insertRecords(sessionId: string, events: readonly SessionEvent[]): SessionRecord[] {
    const cursor = this.db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS cursor FROM session_records WHERE session_id = ?
    `).get(sessionId)?.cursor;
    if (typeof cursor !== "number") throw new Error("会话序号无效");

    const insert = this.db.prepare(`
      INSERT INTO session_records (session_id, turn_id, seq, record_json) VALUES (?, ?, ?, ?)
    `);
    const timestamp = new Date().toISOString();

    return events.map((event, index) => {
      const record = sessionRecordSchema.parse({ ...event, seq: cursor + index + 1, timestamp });
      if (record.type === "turn/status") {
        const result = this.db.prepare(`
          UPDATE turns SET status = ? WHERE session_id = ? AND turn_id = ?
          AND status IN ('running', 'awaiting_approval')
        `).run(record.data.status, sessionId, record.data.turnId);
        if (result.changes === 0) throw new Error("Turn 不存在或已结算");
      }
      insert.run(sessionId, record.data.turnId, record.seq, JSON.stringify(record));
      return record;
    });
  }

  private writeTransaction<T>(write: () => T): T {
    // 在读取活动状态和游标前取得写锁，避免独立连接同时认领同一 Turn 或序号。
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = write();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
