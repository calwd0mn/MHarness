import { SessionCreationCleanupError, type SessionHandle, type SessionPersistence } from "../persistence.ts";
import type { SessionHeader } from "../session.ts";
import type { RawSessionHistory } from "./raw-history.ts";

type SessionCreationResult =
  | { status: "committed" }
  | { status: "failed"; error: unknown }
  | { status: "unknown"; error: unknown; verify: () => Promise<"committed" | "failed" | "unknown"> };

/**
 * 提交空会话头并单独报告句柄释放错误。
 * @param persistence - 拥有会话存储的服务。
 * @param header - 新会话身份和创建时间。
 * @param reportCloseError - 句柄释放失败的记录入口。
 * @param onPrepared - 取得句柄后、提交前同步通知，用于注册临时目录项。
 * @returns 创建结果。提交报错时释放句柄并核对创建身份；准备失败且写入权未确认释放时也返回未知结果。未知结果携带可独立重试的核实函数。
 */
export async function createPersistedSession(
  persistence: SessionPersistence,
  header: SessionHeader,
  reportCloseError: (error: unknown) => void = (error) => console.error("关闭新会话句柄失败", error),
  onPrepared: () => void = () => {},
): Promise<SessionCreationResult> {
  let handle: SessionHandle;
  try {
    handle = await persistence.create(header);
  } catch (error) {
    if (error instanceof SessionCreationCleanupError) {
      return { status: "unknown", error, verify: error.verify };
    }
    return { status: "failed", error };
  }

  let flushError: unknown;
  const verifyCreation = handle.creationVerifier?.();
  try {
    onPrepared();
    await handle.flush();
    return { status: "committed" };
  } catch (error) {
    flushError = error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      reportCloseError(error);
    }
  }

  const verify = async (): Promise<"committed" | "failed" | "unknown"> => {
    try { return verifyCreation ? await verifyCreation() : "unknown"; }
    catch { return "unknown"; }
  };
  const result = await verify();
  if (result === "committed") return { status: "committed" };
  if (result === "failed") return { status: "failed", error: flushError };
  return { status: "unknown", error: flushError, verify };
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
