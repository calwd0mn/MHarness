/**
 * 判断会话标识能否在 HTTP 和持久存储间无损使用。
 * @param value - 调用方或持久记录提供的原始标识。
 * @returns 标识非空、不含 NUL 且没有孤立的 UTF-16 代理项时为 true。
 */
export function isValidSessionId(value: unknown): value is string {
  // SQLite 读取文本时会截断 NUL，UTF-8 编码会替换孤立代理项。
  return typeof value === "string" && value.length > 0 && !/[\0\uD800-\uDFFF]/u.test(value);
}
