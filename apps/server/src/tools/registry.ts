import { z } from "zod";
import { toToolJsonSchema } from "./schema.ts";

/** 工具的可信治理信息，超时单位为毫秒。 */
export interface ToolGovernance {
  readonly executionBoundary: "local" | "remote";
  readonly cancellationGuarantee: "cooperative-exit" | "none";
  readonly sideEffect: "read-only" | "side-effect" | "unknown";
  readonly supportsIdempotency: boolean;
  readonly supportsResultQuery: boolean;
  readonly approvalPolicy: "allow" | "deny" | "ask";
  readonly timeoutMs: number;
}
type GovernanceOptions = Partial<Omit<ToolGovernance, "executionBoundary" | "timeoutMs">> & { timeoutMs: number };
type LocalOptions<S extends z.ZodType, V> = GovernanceOptions & {
  name: string; version: string; description: string; input: S; handler: (args: z.output<S>) => V;
};
/** 模型可见的本地工具定义，不包含治理策略或正文。 */
export interface ToolDefinition { readonly name: string; readonly description: string; readonly inputSchema: Record<string, unknown> }
/** 绑定的已验证调用；调用方须在执行前完成审批、持久化检查点和取消检查。 */
export interface PreparedToolCall {
  readonly name: string; readonly version: string; readonly governance: ToolGovernance; readonly args: unknown;
  /** 执行已绑定正文；兑现或拒绝表示正文返回或抛错。 */
  execute(): Promise<unknown>;
}
/** 准备失败不发起审批或执行。 */
export type PrepareResult = { readonly ok: true; readonly call: PreparedToolCall } | { readonly ok: false; readonly code: "UNKNOWN_TOOL" | "INVALID_JSON" | "INVALID_INPUT" };
interface LocalTool {
  readonly name: string; readonly definition: ToolDefinition; readonly governance: ToolGovernance;
  prepare(input: unknown): PrepareResult;
}
function governance(options: GovernanceOptions, executionBoundary: "local" | "remote"): ToolGovernance {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("timeoutMs 必须为正有限数");
  const sideEffect = options.sideEffect ?? "unknown";
  return Object.freeze({ executionBoundary, cancellationGuarantee: options.cancellationGuarantee ?? "none", sideEffect,
    supportsIdempotency: options.supportsIdempotency ?? false, supportsResultQuery: options.supportsResultQuery ?? false,
    approvalPolicy: options.approvalPolicy ?? (sideEffect === "read-only" ? "allow" : "ask"), timeoutMs: options.timeoutMs });
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
 * @param options - 可信身份、输入定义、治理配置和正文。
 * @returns 可注册的本地工具。
 * @throws 输入定义不受支持或超时无效时抛出错误。
 */
export function defineLocalTool<S extends z.ZodType, V>(options: LocalOptions<S, V>): LocalTool {
  const inputSchema = toToolJsonSchema(options.input);
  const policy = governance(options, "local");
  const { name, version, handler, input } = options;
  const definition = { name, description: options.description, inputSchema };
  freezeJson(definition);
  return Object.freeze({ name, definition, governance: policy,
    prepare(value: unknown): PrepareResult {
      const parsed = input.safeParse(value);
      if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
      freezeJson(parsed.data);
      return { ok: true, call: Object.freeze({ name, version, governance: policy, args: parsed.data, execute: async () => handler(parsed.data) }) };
    },
  });
}
/** 保存可信工具注册信息并准备完整模型参数。 */
export class ToolRegistry {
  private readonly local = new Map<string, LocalTool>();
  private readonly policies = new Map<string, ToolGovernance>();
  /** 注册本地工具；名称重复时抛错。 */
  register(tool: LocalTool): void {
    if (this.policies.has(tool.name)) throw new Error("工具名称已注册");
    this.local.set(tool.name, tool); this.policies.set(tool.name, tool.governance);
  }
  /**
   * 保存远程治理信息，不提供远程输入校验或派发；地址不改变取消退出保证。
   * @param options - 可信远程工具注册信息。
   * @throws 名称重复或超时无效时抛出错误。
   */
  registerRemote(options: GovernanceOptions & { name: string; version: string; executionBoundary: "remote"; endpoint: string }): void {
    if (this.policies.has(options.name)) throw new Error("工具名称已注册");
    this.policies.set(options.name, governance(options, "remote"));
  }
  /** 返回指定工具的可信治理信息；未注册时返回 undefined。 */
  governance(name: string): ToolGovernance | undefined { return this.policies.get(name); }
  /** 返回本地工具的模型可见定义副本。 */
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
