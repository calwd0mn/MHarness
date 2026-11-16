import { z } from "zod";

function checkInputSchema(schema: z.ZodType): void {
  const def = schema._zod.def;
  if ("coerce" in def && def.coerce) throw new Error("输入 Schema 不支持隐式转换");
  if ("checks" in def && Array.isArray(def.checks)) {
    for (const check of def.checks) {
      const checkDef: unknown = Reflect.get(Reflect.get(check, "_zod"), "def");
      const kind: unknown = typeof checkDef === "object" && checkDef !== null ? Reflect.get(checkDef, "check") : undefined;
      if (!["min_length", "max_length", "length_equals", "greater_than", "less_than", "number_format"].includes(String(kind))) throw new Error("输入 Schema 包含不支持的约束");
      if (kind === "number_format" && Reflect.get(Object(checkDef), "format") !== "safeint") throw new Error("输入 Schema 包含不支持的数字格式");
    }
  }
  switch (def.type) {
    case "object":
      if (!(schema instanceof z.ZodObject) || !(schema._zod.def.catchall instanceof z.ZodNever)) throw new Error("输入对象必须严格拒绝未知字段");
      for (const child of Object.values(schema._zod.def.shape)) {
        if (!(child instanceof z.ZodType)) throw new Error("无效的输入 Schema");
        checkInputSchema(child);
      }
      return;
    case "array": if (!(schema instanceof z.ZodArray)) throw new Error("无效的输入 Schema"); const child = schema.element; if (!(child instanceof z.ZodType)) throw new Error("无效的输入 Schema"); checkInputSchema(child); return;
    case "optional": case "nullable": if (!(schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)) throw new Error("无效的输入 Schema"); const inner = schema.unwrap(); if (!(inner instanceof z.ZodType)) throw new Error("无效的输入 Schema"); checkInputSchema(inner); return;
    case "string": case "number": case "boolean": case "null": case "enum": case "literal": return;
    default: throw new Error(`输入 Schema 不支持 ${def.type}`);
  }
}
/**
 * 校验工具 Schema 是否属于可与 JSON Schema 等价的受限子集，并导出输入侧定义。
 * 对象必须严格拒绝未知字段；支持数组、可选值、可空值、字符串、数字、布尔值、null、枚举及字面量，
 * 以及受支持的长度和数字范围约束。隐式转换、默认值、变换和自定义校验不受支持。
 * @param schema - 由调用方持有的 Zod 工具参数或输出定义。
 * @returns 与该定义同源的 JSON Schema。
 * @throws 定义或约束不受支持，或 Zod 无法导出时抛出错误。
 */
export function toToolJsonSchema(schema: z.ZodType): Record<string, unknown> {
  checkInputSchema(schema);
  return z.toJSONSchema(schema, { io: "input" });
}
