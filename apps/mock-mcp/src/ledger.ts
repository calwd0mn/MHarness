import { DatabaseSync } from "node:sqlite";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type WriteResult = { content: { type: "text"; text: string }[]; structuredContent: { text: string; operationId: string } };

function normalize(value: Json): Json {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key]!)]));
  return value;
}

/** 持有模拟工具独立数据库连接，协调操作记录、效果和结果的事务提交。 */
export class MockLedger {
  readonly #db: DatabaseSync;

  /**
   * 打开模拟工具数据库；调用方须在使用结束后关闭。
   * @param path - SQLite 文件路径，`:memory:` 表示临时内存数据库。
   */
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS mock_operations (operation_id TEXT PRIMARY KEY, tool_name TEXT NOT NULL, arguments TEXT NOT NULL, result TEXT NOT NULL); CREATE TABLE IF NOT EXISTS mock_effects (id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, text TEXT NOT NULL);");
    } catch (error) { this.#db.close(); throw error; }
  }

  /**
   * 首次调用时原子提交效果和成功结果；相同绑定重用已提交结果，冲突不产生效果。
   * @param operationId - 逻辑操作标识。
   * @param toolName - 标识绑定的工具名。
   * @param args - 不含 operationId 的业务参数，含写入文本。
   * @returns 已提交结果；绑定冲突时返回 undefined。
   * @throws 数据库操作失败时回滚事务并抛出错误。
   */
  write(operationId: string, toolName: string, args: { text: string; [key: string]: Json }): WriteResult | undefined {
    const serialized = JSON.stringify(normalize(args));
    // SQLite 文本绑定不能无损保存 NUL 和未配对代理项，JSON 编码保留这些合法输入。
    const key = JSON.stringify(operationId);
    const tool = JSON.stringify(toolName);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#db.prepare("SELECT tool_name, arguments, result FROM mock_operations WHERE operation_id = ?").get(key);
      if (existing) {
        const result = existing.tool_name === tool && existing.arguments === serialized ? JSON.parse(String(existing.result)) as WriteResult : undefined;
        this.#db.exec("COMMIT");
        return result;
      }
      const result: WriteResult = { content: [{ type: "text", text: args.text }], structuredContent: { text: args.text, operationId } };
      this.#db.prepare("INSERT INTO mock_effects (operation_id, text) VALUES (?, ?)").run(key, JSON.stringify(args.text));
      this.#db.prepare("INSERT INTO mock_operations (operation_id, tool_name, arguments, result) VALUES (?, ?, ?, ?)").run(key, tool, serialized, JSON.stringify(result));
      this.#db.exec("COMMIT");
      return result;
    } catch (error) { if (this.#db.isTransaction) this.#db.exec("ROLLBACK"); throw error; }
  }

  /** 返回已提交的效果文本，按写入顺序排列。 */
  effects(): readonly string[] { return this.#db.prepare("SELECT text FROM mock_effects ORDER BY id").all().map((row) => JSON.parse(String(row.text)) as string); }

  /** 关闭当前实例拥有的数据库连接。 */
  close(): void { this.#db.close(); }
}
