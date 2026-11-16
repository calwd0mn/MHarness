import { z } from "zod";
import { toToolJsonSchema } from "./schema.ts";

/** 可无损持久化的 JSON 数据。 */
export type ToolJson = null | boolean | number | string | ToolJson[] | { [key: string]: ToolJson };

/** 内存中的工具结局；仅成功分支可携带结束意向。 */
export type ToolResult<Value = ToolJson> =
  | { isError: false; value?: Value; content: ToolJson[]; meta?: ToolJson; concludeTurn?: boolean }
  | { isError: true; error: { message: string; info?: { name: string; code: string } }; content: ToolJson[]; meta?: ToolJson };

const outputValidator = Symbol("outputValidator");

/** 由同一 Zod 定义生成的本地输出契约；模型内容与展示数据必须从同一快照纯派生。 */
export interface LocalToolOutput<Args, Value> {
  /** 与运行时校验绑定的不可变 JSON Schema。 */
  readonly schema: Readonly<Record<string, unknown>>;
  readonly [outputValidator]: z.ZodType<Value>;
  readonly render: (args: Args, value: Value) => unknown;
  readonly presentationMeta?: (args: Args, value: Value) => unknown;
}

/**
 * 从唯一 Zod 定义创建本地工具输出契约，导出与运行时校验一致的 JSON Schema。
 * @param definition - 值校验定义和从参数、值派生内容的纯函数。
 * @returns 绑定验证规则的不可变输出契约；其 schema 可供调用方读取。
 * @throws Zod 定义不属于可等价导出的工具 Schema 子集时抛出。
 */
export function defineLocalToolOutput<Args, Value>(definition: {
  schema: z.ZodType<Value>;
  render: (args: Args, value: Value) => unknown;
  presentationMeta?: (args: Args, value: Value) => unknown;
}): LocalToolOutput<Args, Value> {
  // Zod 附加不可枚举的运行时元数据，JSON Schema 快照只保留可传输部分。
  const schema = snapshotToolJson(JSON.parse(JSON.stringify(toToolJsonSchema(definition.schema)))) as Record<string, unknown>;
  return Object.freeze({ schema, [outputValidator]: definition.schema, render: definition.render,
    ...(definition.presentationMeta ? { presentationMeta: definition.presentationMeta } : {}) });
}
/** 表示工具作者明确可公开的业务错误；消息、名称和代码不得包含秘密。 */
export class HarnessError extends Error {
  readonly code: string;
  /**
   * 创建可向模型公开的工具业务错误。
   * @param message - 可公开的失败说明。
   * @param name - 稳定的错误名称。
   * @param code - 稳定的错误代码。
   */
  constructor(message: string, name: string, code: string) {
    super(message);
    this.name = name;
    this.code = code;
  }
}

/**
 * 创建不可变、无损的 JSON 快照。
 * @param value - 待复制的数据。
 * @param ancestors - 内部递归使用的祖先集合；调用方应省略。
 * @returns 不与原数据共享可变对象的快照。
 * @throws 数据无法无损表示为 JSON 或存在循环引用时抛出。
 */
export function snapshotToolJson(value: unknown, ancestors = new Set<object>()): ToolJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (typeof value !== "object" || ancestors.has(value)) throw new TypeError("无效 JSON");
  ancestors.add(value);
  try {
    const read = (key: PropertyKey): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError("无效 JSON");
      return descriptor.value;
    };
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError("无效 JSON");
      return Object.freeze(Array.from({ length: value.length }, (_, i) => snapshotToolJson(read(String(i)), ancestors))) as ToolJson[];
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("无效 JSON");
    const entries = Reflect.ownKeys(value).map((key) => {
      if (typeof key !== "string") throw new TypeError("无效 JSON");
      return [key, snapshotToolJson(read(key), ancestors)] as const;
    });
    return Object.freeze(Object.fromEntries(entries));
  } finally {
    ancestors.delete(value);
  }
}

function failure(message: string, info?: { name: string; code: string }): Extract<ToolResult, { isError: true }> {
  return { isError: true, error: { message, ...(info ? { info } : {}) }, content: [{ type: "text", text: message }] };
}

/**
 * 将工具正文抛出的异常转换为模型可见失败；普通异常不公开原始消息。
 * @param error - 工具正文抛出的值；只有 HarnessError 被视为可公开的业务错误。
 * @returns 不含成功值和结束意向的失败结果。
 */
export function normalizeToolError(error: unknown): Extract<ToolResult, { isError: true }> {
  return error instanceof HarnessError
    ? failure(error.message, { name: error.name, code: error.code })
    : failure("工具执行失败。");
}

/**
 * 校验本地工具候选值，并用独立不可变的参数和值派生模型内容与展示数据。
 * 任一校验或派生失败均返回 INVALID_TOOL_OUTPUT；这不表示工具副作用已撤销。
 * @param output - 由 defineLocalToolOutput 创建的输出契约。
 * @param args - 已校验的工具参数，必须能无损表示为 JSON。
 * @param candidate - 工具正文返回的待校验值。
 * @param concludeTurn - 可信工具定义或成功策略提供的结束意向。
 * @returns 成功结果或不含候选值、原始异常及结束意向的安全失败结果。
 */
export function normalizeLocalToolResult<Args, Value>(
  output: LocalToolOutput<Args, Value>, args: Args, candidate: unknown, concludeTurn?: boolean,
): ToolResult<Value> {
  try {
    const argsSnapshot = snapshotToolJson(args) as Args;
    const parsed = output[outputValidator].parse(snapshotToolJson(candidate));
    const value = snapshotToolJson(parsed) as Value;
    const content = snapshotToolJson(output.render(argsSnapshot, value));
    if (!Array.isArray(content)) throw new TypeError("无效内容");
    const meta = output.presentationMeta ? snapshotToolJson(output.presentationMeta(argsSnapshot, value)) : undefined;
    return { isError: false, value, content, ...(meta !== undefined ? { meta } : {}), ...(concludeTurn !== undefined ? { concludeTurn } : {}) };
  } catch {
    return failure("工具输出不符合结果契约。", { name: "InvalidToolOutputError", code: "INVALID_TOOL_OUTPUT" });
  }
}
