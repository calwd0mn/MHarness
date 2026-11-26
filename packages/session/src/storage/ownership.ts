import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 所有权竞争的范围及可选会话标识，可与其他存储错误区分。 */
export class OwnershipConflictError extends Error {
  constructor(readonly scope: "instance" | "session", readonly sessionId?: string) {
    super(scope === "instance" ? "数据库实例已被占用" : `会话写入权已被占用: ${sessionId}`);
    this.name = "OwnershipConflictError";
  }
}

/** 持有操作系统锁的资源；调用方必须在使用结束后释放。 */
export interface Ownership {
  /** 释放锁；关闭失败时可重试，成功后重复调用无操作。 */
  release(): Promise<void>;
}

/** 锁已取得但关闭未确认，持有者必须继续尝试释放。 */
export class OwnershipAcquisitionCleanupError extends Error {
  constructor(cause: unknown, readonly ownership: Ownership) {
    super("取得写入权失败，锁清理待确认", { cause });
  }
}

async function canonicalDatabasePath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    try {
      await lstat(absolute);
    } catch (statError) {
      if (!(statError instanceof Error && "code" in statError && statError.code === "ENOENT")) throw statError;
      return join(await realpath(dirname(absolute)), basename(absolute));
    }
    throw error;
  }
}

async function acquire(path: string, scope: "instance" | "session", sessionId?: string): Promise<Ownership> {
  const canonical = await canonicalDatabasePath(path);
  const lockDir = `${canonical}.locks`;
  await mkdir(lockDir, { recursive: true });
  const name = scope === "instance" ? "instance.sqlite" : `session-${createHash("sha256").update(sessionId ?? "").digest("hex")}.sqlite`;
  const db = new DatabaseSync(join(lockDir, name));
  let released = false;
  const ownership: Ownership = { async release() {
    if (released) return;
    try { db.close(); } catch (error) { if (db.isOpen) throw error; }
    released = true;
  } };
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  } catch (error) {
    const acquired = db.isTransaction;
    try { await ownership.release(); } catch (closeError) {
      if (acquired) throw new OwnershipAcquisitionCleanupError(error, ownership);
      throw closeError;
    }
    if (error instanceof Error && "errcode" in error && error.errcode === 5) {
      throw new OwnershipConflictError(scope, sessionId);
    }
    throw error;
  }
  return ownership;
}

/**
 * 按数据库规范路径取得跨进程实例锁；目录须已存在，锁文件保留供后续进程复用。
 * @param databasePath - 数据库文件路径，支持相对路径及已存在父目录的链接别名。
 * @returns 调用方须持有至存储关闭并负责释放的锁。
 * @throws 所有权冲突时以 OwnershipConflictError 拒绝，路径或数据库错误原样报告；取得锁后关闭未确认时抛出携带清理责任的 OwnershipAcquisitionCleanupError。
 */
export function acquireInstanceOwnership(databasePath: string): Promise<Ownership> {
  return acquire(databasePath, "instance");
}

/**
 * 取得指定会话的跨进程写入权；不同会话的锁互不阻塞。
 * @param databasePath - 数据库文件路径。
 * @param sessionId - 会话标识，锁文件使用其 SHA-256 摘要。
 * @returns 调用方须在写句柄关闭时释放的锁。
 * @throws 同一会话已被持有时以 OwnershipConflictError 拒绝；取得锁后关闭未确认时抛出携带清理责任的 OwnershipAcquisitionCleanupError。
 */
export function acquireSessionOwnership(databasePath: string, sessionId: string): Promise<Ownership> {
  return acquire(databasePath, "session", sessionId);
}
