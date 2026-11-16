import { sessionParamsSchema } from "@mharness/session/contracts";

/** 浏览器本地的会话目录；会话内容仍由 follow 快照恢复。 */
export interface SessionDirectory {
  sessions: string[];
  selected: string | null;
}
type DirectoryStorage = Pick<Storage, "getItem" | "setItem">;
const key = "mharness.session-directory.v1";

/** 读取并校验本地目录；存储不可用或内容损坏时返回空目录。 */
export function loadDirectory(
  storage: DirectoryStorage | undefined,
): SessionDirectory {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(key) ?? "null");
    if (
      !raw ||
      typeof raw !== "object" ||
      !("sessions" in raw) ||
      !Array.isArray(raw.sessions)
    )
      return { sessions: [], selected: null };
    const sessions: string[] = [];
    for (const id of raw.sessions) {
      const result = sessionParamsSchema.safeParse({ sessionId: id });
      if (result.success && !sessions.includes(result.data.sessionId))
        sessions.push(result.data.sessionId);
    }
    const selected =
      "selected" in raw &&
      typeof raw.selected === "string" &&
      sessions.includes(raw.selected)
        ? raw.selected
        : null;
    return { sessions, selected };
  } catch {
    return { sessions: [], selected: null };
  }
}
/** 尽力保存目录；浏览器禁用存储时保留当前内存状态。 */
export function saveDirectory(
  storage: DirectoryStorage | undefined,
  directory: SessionDirectory,
): void {
  try {
    storage?.setItem(key, JSON.stringify(directory));
  } catch {
    /* 浏览器可禁用本地存储。 */
  }
}
/** 取得可用的本地存储；访问被拒绝时返回 undefined。 */
export function browserStorage(): DirectoryStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
