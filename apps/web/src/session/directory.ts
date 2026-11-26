import { sessionParamsSchema } from "@mharness/session/contracts";

/** 预留的子代理地址；父会话必须与顶层选择一致。 */
export type SubagentAddress = Readonly<{
  parentSessionId: string;
  childSessionId: string;
}> & (Readonly<{ mode: "one-shot" }> | Readonly<{ mode: "continuable" }>);
/** 跨窗口保存的选择；当前页面只打开顶层会话。 */
export interface SessionSelection {
  sessionId?: string;
  subagentAddress?: SubagentAddress;
}
/** 启动时读取的提示及来源，用于目录确认时保护其他窗口的写入。 */
export interface SelectionHint {
  source: "current" | "legacy" | "none";
  selection: SessionSelection;
}
type SelectionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const currentKey = "mharness.sessions.current";
const legacyKey = "mharness.session-directory.v1";

function validId(value: unknown): value is string {
  return sessionParamsSchema.safeParse({ sessionId: value }).success;
}
function parseSelection(raw: unknown): SessionSelection {
  if (!raw || typeof raw !== "object" || !("sessionId" in raw) || !validId(raw.sessionId)) return {};
  const sessionId = raw.sessionId;
  if (!("subagentAddress" in raw) || !raw.subagentAddress || typeof raw.subagentAddress !== "object") return { sessionId };
  const address = raw.subagentAddress;
  if (!("parentSessionId" in address) || address.parentSessionId !== sessionId || !("childSessionId" in address) || !validId(address.childSessionId) || !("mode" in address) || (address.mode !== "one-shot" && address.mode !== "continuable")) return { sessionId };
  return { sessionId, subagentAddress: { parentSessionId: sessionId, childSessionId: address.childSessionId, mode: address.mode } };
}
function parseJson(raw: string): unknown {
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}
/**
 * 只读启动提示；新键存在时即使无效也不会回退旧键。
 * @param storage - 可用的浏览器存储；访问失败时视为无提示。
 * @returns 已校验的选择及其来源，旧目录列表不会返回。
 */
export function loadSelection(storage: SelectionStorage | undefined): SelectionHint {
  try {
    if (!storage) return { source: "none", selection: {} };
    const current = storage.getItem(currentKey);
    if (current !== null) return { source: "current", selection: parseSelection(parseJson(current)) };
    const old = storage.getItem(legacyKey);
    if (old === null) return { source: "none", selection: {} };
    const parsed = parseJson(old);
    const selected = parsed && typeof parsed === "object" && "selected" in parsed ? parsed.selected : undefined;
    return { source: "legacy", selection: validId(selected) ? { sessionId: selected } : {} };
  } catch { return { source: "none", selection: {} }; }
}
function writeSelection(storage: SelectionStorage, sessionId: string | null): void {
  try { storage.setItem(currentKey, JSON.stringify(sessionId === null ? {} : { sessionId })); }
  catch { return; }
  try { storage.removeItem(legacyKey); } catch { /* 旧键清理失败不影响已经保存的新键。 */ }
}
function requestSelectionLock(action: () => void): Promise<void> | undefined {
  try {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request(currentKey, action).catch(() => {});
    }
  } catch { return Promise.resolve(); }
  return undefined;
}
/**
 * 尽力保存当前顶层选择；写入成功后尽力清除旧键，失败时保留旧键。
 * 支持 Web Locks 时与启动提示对账使用同源独占锁；缺少 API 时同步写入，请求失败时保留内存选择。
 * @param storage - 浏览器存储；不可用时不影响内存选择。
 * @param sessionId - 当前顶层 ID，null 表示清空。
 * @returns 有锁时返回写入完成或锁请求失败后兑现的 Promise，否则同步完成。
 */
export function saveSelection(storage: SelectionStorage | undefined, sessionId: string | null): void | Promise<void> {
  if (!storage) return;
  const pending = requestSelectionLock(() => writeSelection(storage, sessionId));
  if (pending) return pending;
  writeSelection(storage, sessionId);
}
/**
 * 目录确认后在同源锁内重新读取并核对，迁移旧提示或清除失效提示；缺少锁 API 或请求失败时跳过写入。
 * @param storage - 与启动读取相同的存储。
 * @param hint - 启动时读取的来源和选择。
 * @param valid - 目录是否确认顶层会话存在。
 * @returns 有锁时返回对账完成或锁请求失败后兑现的 Promise，无锁时不写入。
 */
export function confirmInitialSelection(storage: SelectionStorage | undefined, hint: SelectionHint, valid: boolean): void | Promise<void> {
  if (!storage || !hint.selection.sessionId || hint.source === "none" || (valid && hint.source === "current")) return;
  return requestSelectionLock(() => {
    const current = loadSelection(storage);
    const actual = current.selection;
    const expected = hint.selection;
    if (current.source !== hint.source || actual.sessionId !== expected.sessionId ||
        actual.subagentAddress?.parentSessionId !== expected.subagentAddress?.parentSessionId ||
        actual.subagentAddress?.childSessionId !== expected.subagentAddress?.childSessionId ||
        actual.subagentAddress?.mode !== expected.subagentAddress?.mode) return;
    if (!valid) writeSelection(storage, null);
    else if (hint.source === "legacy") writeSelection(storage, hint.selection.sessionId ?? null);
  });
}
/** 取得可用的本地存储；访问被拒绝时返回 undefined。 */
export function browserStorage(): SelectionStorage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}
