import { localConfig } from "../../../../config/local.ts";
import { STOP_OBSERVING_TOOL_RESULT } from "./dispatch.ts";
import { z } from "zod";
import { toToolJsonSchema } from "./schema.ts";
import { normalizeLocalToolResult, type LocalToolOutput, type ToolResult } from "./result.ts";

/** 工具的可信治理信息，超时单位为毫秒。 */
export interface ToolGovernance {
  readonly executionBoundary: "local" | "remote";
  readonly cancellationGuarantee: "cooperative-exit" | "none";
  readonly sideEffect: "read-only" | "side-effect" | "unknown";
  readonly supportsIdempotency: boolean;
  readonly supportsResultQuery: boolean;
  readonly approvalPolicy: "allow" | "deny" | "ask";
  /** 等待时间以毫秒计，必须大于 0 且不超过 2_147_483_647。 */
  readonly timeoutMs: number;
}
type GovernanceOptions = Partial<Omit<ToolGovernance, "executionBoundary">>;
type LocalOptions<S extends z.ZodType, V> = GovernanceOptions & {
  name: string; version: string; description: string; input: S; handler: (args: z.output<S>, signal: AbortSignal) => V;
  output?: LocalToolOutput<z.output<S>, Awaited<V>>; concludeTurn?: boolean;
};
/** 模型可见的工具定义，不包含治理策略或正文。 */
export interface ToolDefinition { readonly name: string; readonly description: string; readonly inputSchema: Record<string, unknown> }
/** 绑定的已验证调用；调用方须在执行前完成审批、持久化检查点和取消检查。 */
export interface PreparedToolCall {
  readonly name: string; readonly version: string; readonly governance: ToolGovernance; readonly args: unknown;
  /**
   * 执行已绑定正文；兑现或拒绝表示正文返回或抛错。
   * @param signal - 传给正文的取消请求；省略时使用未取消的信号，不保证正文停止。
   * @param operationId - 已持久化的操作标识；需要注入标识的远程工具必须提供。
   * @returns 正文的原始返回值。
   */
  execute(signal?: AbortSignal, operationId?: string): Promise<unknown>;
  /**
   * 执行正文并校验输出；未配置输出契约时返回契约失败，正文抛错时 Promise 拒绝。
   * 派发器停止观察后，迟到值不会进入校验或内容派生，Promise 拒绝；这不证明执行端没有副作用。
   * @param signal - 传给正文的取消请求，不保证正文已经停止。
   * @param operationId - 已持久化的操作标识；需要注入标识的远程工具必须提供。
   * @returns 已校验的成功结果或输出契约失败。
   */
  executeNormalized(signal: AbortSignal, operationId?: string): Promise<ToolResult<unknown>>;
}
/** 准备失败不发起审批或执行。 */
export type PrepareResult = { readonly ok: true; readonly call: PreparedToolCall } | { readonly ok: false; readonly code: "UNKNOWN_TOOL" | "INVALID_JSON" | "INVALID_INPUT" };
/** 可注册工具负责校验输入并绑定不可变参数。 */
export interface RegisteredTool {
  readonly name: string; readonly definition: ToolDefinition; readonly governance: ToolGovernance;
  prepare(input: unknown): PrepareResult;
}
/**
 * 根据可信配置生成不可变治理策略，未指定超时时采用集中默认值。
 * @param options - 治理配置；超时以毫秒计且必须在计时器支持的范围内。
 * @param executionBoundary - 可信执行边界，不由模型指定。
 * @returns 已补全默认值的治理策略。
 * @throws 超时无效时抛错。
 */
export function toolGovernance(options: GovernanceOptions, executionBoundary: "local" | "remote"): ToolGovernance {
  const timeoutMs = options.timeoutMs ?? localConfig.tools.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error("timeoutMs 必须大于 0 且不超过 2_147_483_647 毫秒");
  const sideEffect = options.sideEffect ?? "unknown";
  return Object.freeze({ executionBoundary, cancellationGuarantee: options.cancellationGuarantee ?? "none", sideEffect,
    supportsIdempotency: options.supportsIdempotency ?? false, supportsResultQuery: options.supportsResultQuery ?? false,
    approvalPolicy: options.approvalPolicy ?? (sideEffect === "read-only" ? "allow" : "ask"), timeoutMs });
}
function isLosslessJson(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  return typeof value !== "object" || value === null || Object.values(value).every(isLosslessJson);
}
function freezeJson(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}
/**
 * 以同一 Zod 定义创建本地工具并推导正文参数类型，不调用正文。
 * 仅支持严格对象与可等价导出的 JSON 子集；转换、自定义校验和默认值会被拒绝。
 * @param options - 可信身份、输入与输出定义、治理配置、结束意向和正文；超时须大于 0 且不超过 2_147_483_647 毫秒，未提供时采用集中默认值；未提供输出定义时不能产生规范化成功结果。
 * @returns 可注册的本地工具。
 * @throws 输入定义不受支持或超时无效时抛出错误。
 */
export function defineLocalTool<S extends z.ZodType, V>(options: LocalOptions<S, V>): RegisteredTool {
  const inputSchema = toToolJsonSchema(options.input);
  const policy = toolGovernance(options, "local");
  const { name, version, handler, input, output, concludeTurn } = options;
  const definition = { name, description: options.description, inputSchema };
  freezeJson(definition);
  return Object.freeze({ name, definition, governance: policy,
    prepare(value: unknown): PrepareResult {
      const parsed = input.safeParse(value);
      if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
      freezeJson(parsed.data);
      return { ok: true, call: Object.freeze({ name, version, governance: policy, args: parsed.data, execute: async (signal = new AbortController().signal) => handler(parsed.data, signal),
        executeNormalized: async (signal: AbortSignal) => {
          const value = await handler(parsed.data, signal);
          if (signal.aborted && signal.reason === STOP_OBSERVING_TOOL_RESULT) throw new Error("工具结果已停止观察");
          if (!output) return { isError: true as const, error: { message: "工具未配置输出契约。", info: { name: "InvalidToolOutputError", code: "INVALID_TOOL_OUTPUT" } }, content: [{ type: "text", text: "工具未配置输出契约。" }] };
          return normalizeLocalToolResult(output, parsed.data, value, concludeTurn);
        } }) };
    },
  });
}
/** 保存可信工具注册信息并准备完整模型参数。 */
export class ToolRegistry {
  private readonly local = new Map<string, RegisteredTool>();
  private readonly policies = new Map<string, ToolGovernance>();
  /** 注册已绑定治理的工具；名称重复时抛错。 */
  register(tool: RegisteredTool): void {
    if (this.policies.has(tool.name)) throw new Error("工具名称已注册");
    this.local.set(tool.name, tool); this.policies.set(tool.name, tool.governance);
  }
  /**
   * 保存远程治理信息，不提供远程输入校验或派发；地址不改变取消退出保证。
   * @param options - 可信远程工具注册信息；超时须大于 0 且不超过 2_147_483_647 毫秒，未提供时采用集中默认值。
   * @throws 名称重复或超时无效时抛出错误。
   */
  registerRemote(options: GovernanceOptions & { name: string; version: string; executionBoundary: "remote"; endpoint: string }): void {
    if (this.policies.has(options.name)) throw new Error("工具名称已注册");
    this.policies.set(options.name, toolGovernance(options, "remote"));
  }
  /** 返回指定工具的可信治理信息；未注册时返回 undefined。 */
  governance(name: string): ToolGovernance | undefined { return this.policies.get(name); }
  /** 返回已注册工具的模型可见定义副本。 */
  definitions(): ToolDefinition[] { return [...this.local.values()].map((tool) => structuredClone(tool.definition)); }
  /**
   * 解析完整 arguments 并校验，不请求审批或执行正文。
   * 非有限数字和负零无法无损持久化，按输入校验失败处理。
   * @param name - 模型选择的工具名称。
   * @param argumentsJson - 完整的 JSON 参数文本。
   * @returns 已绑定调用或可区分的未知工具、JSON 解析、输入校验错误。
   */
  prepare(name: string, argumentsJson: string): PrepareResult {
    const tool = this.local.get(name);
    if (!tool) return { ok: false, code: "UNKNOWN_TOOL" };
    let value: unknown;
    try { value = JSON.parse(argumentsJson); } catch { return { ok: false, code: "INVALID_JSON" }; }
    if (!isLosslessJson(value)) return { ok: false, code: "INVALID_INPUT" };
    return tool.prepare(value);
  }
}
