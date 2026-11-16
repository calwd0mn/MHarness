import type { SessionPersistence } from "../persistence.ts";
import type { SessionHeader } from "../session.ts";
import type { RawSessionHistory } from "./raw-history.ts";

/**
 * 创建只含 header 的已提交会话，并释放准备句柄。
 * @param persistence - 拥有会话存储的服务。
 * @param header - 新会话身份和创建时间。
 * @returns 空 header 的持久性屏障与句柄关闭完成后兑现。
 * @throws 创建、提交或关闭失败时拒绝。
 */
export async function createPersistedSession(persistence: SessionPersistence, header: SessionHeader): Promise<void> {
  const handle = await persistence.create(header);
  try { await handle.flush(); } finally { await handle.close(); }
}

/**
 * 读取指定会话的一致已提交历史，不排空在线写入缓冲。
 * @param persistence - 拥有会话存储的服务。
 * @param sessionId - 会话标识。
 * @returns 已提交完整前缀，不存在时为 undefined；读取结束后关闭句柄。
 * @throws 打开、读取或关闭失败时拒绝。
 */
export async function readPersistedSessionHistory(persistence: SessionPersistence, sessionId: string): Promise<RawSessionHistory | undefined> {
  const handle = await persistence.open(sessionId, "read");
  if (!handle) return undefined;
  try {
    const events = await handle.read();
    return { sessionId: handle.id, inheritedEventCount: handle.inheritedEventCount, cursor: events.length - 1,
      records: events.map((event) => ({ type: "event", event })) };
  } finally { await handle.close(); }
}
