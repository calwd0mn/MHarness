import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import type { SessionEvent } from "../../../../packages/session/src/events.ts";

/** 以实际事务内容选择一条压缩 start、成功批次或单条失败终态。 */
export interface CompactionSqliteFaultTarget {
  readonly path: string;
  readonly sessionId: string;
  readonly compactionId: string;
  readonly firstSeq: number;
  readonly kind: "start" | "success" | "end";
  readonly mode: "committed" | "rolled-back";
  /** 已知写连接时限定连接身份；省略时捕获目标库的写事务连接。 */
  readonly writer?: DatabaseSync;
}

/**
 * 在指定 SQLite 写事务上模拟提交结果未知，并保持核对不可用直到调用 release。
 * @param t - 拥有模拟方法的测试上下文；调用方仍须调用 restore。
 * @param target - 目标数据库、会话、压缩身份、批次首序号与故障模式。
 * @returns 原故障、命中和核对读取计数，以及放行和恢复方法。
 */
export function injectCompactionSqliteFault(t: TestContext, target: CompactionSqliteFaultTarget) {
  const execute = DatabaseSync.prototype.exec;
  const prepare = DatabaseSync.prototype.prepare;
  const failure = new Error("压缩事务提交结果未知");
  let writer: DatabaseSync | undefined;
  let candidate: DatabaseSync | undefined;
  let held = true;
  let hits = 0;
  let reads = 0;
  let notifyHit!: () => void;
  const entered = new Promise<void>((resolveHit) => { notifyHit = resolveHit; });
  const sameDatabase = (db: DatabaseSync) => {
    const row = prepare.call(db, "PRAGMA database_list").all().find((entry) => entry.name === "main");
    return typeof row?.file === "string" && resolve(row.file) === resolve(target.path);
  };
  const matches = (db: DatabaseSync) => {
    const rows = prepare.call(db, "SELECT event_json FROM mh_events WHERE session_id=? AND seq>=? ORDER BY seq").all(target.sessionId, target.firstSeq);
    const events = rows.map((row) => JSON.parse(String(row.event_json)) as SessionEvent);
    if (!events.every((event, index) => event.seq === target.firstSeq + index)) return false;
    if (target.kind === "start") return events.length === 1 && events[0]?.type === "compaction/start" && events[0].data.compactionId === target.compactionId;
    if (target.kind === "end") return events.length === 1 && events[0]?.type === "compaction/end" && events[0].data.compactionId === target.compactionId && events[0].data.status !== "succeeded";
    const [summary, checkpoint, end] = events;
    return events.length === 3 && summary?.type === "compaction/summary" && summary.data.compactionId === target.compactionId &&
      checkpoint?.type === "user/message" && checkpoint.data.source.kind === "compact" && checkpoint.data.source.compactionId === target.compactionId &&
      checkpoint.sourceEventSeqs?.[0] === summary.seq && end?.type === "compaction/end" && end.data.compactionId === target.compactionId && end.data.status === "succeeded" &&
      summary.data.sourceCommandId === end.data.sourceCommandId;
  };
  const execMock = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && !writer && (!target.writer || target.writer === this) && sameDatabase(this)) candidate = this;
    if (sql === "COMMIT" && this === candidate && this.isTransaction && matches(this)) {
      writer = this;
      hits++;
      if (hits === 1) {
        notifyHit();
        if (target.mode === "committed") execute.call(this, sql);
        throw failure;
      }
    }
    if (this === writer && sql === "ROLLBACK" && held && target.mode === "rolled-back") throw failure;
    return execute.call(this, sql);
  });
  const prepareMock = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (writer && this !== writer && sql.startsWith("SELECT header_json, inherited_count, event_count") && sameDatabase(this)) {
      reads++;
      if (held && target.mode === "committed") throw failure;
    }
    return prepare.call(this, sql);
  });
  return {
    failure,
    entered,
    get targetCommits() { return hits; },
    get reconciliationReads() { return reads; },
    release() { held = false; },
    restore() { held = false; prepareMock.mock.restore(); execMock.mock.restore(); },
  };
}
