import type { ModelTool } from "./adapter.ts";
import { projectSurfaceMessage } from "./request-projection.ts";
import type { SurfaceMessage } from "./request-projection.ts";
import type { PreparedModel } from "./runtime.ts";

/** 计量输入使用当前 surface；调用期间调用方须保持输入不变。 */
export type MeterInput = Readonly<{ systemPrompt?: string; tools?: readonly ModelTool[]; messages: readonly SurfaceMessage[] }>;

function blockTokens(value: unknown): number {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const block = value as Record<string, unknown>;
    if ((block.type === "text" || block.type === "reasoning") && typeof block.text === "string") return 4 + Math.ceil(block.text.length / 4);
    if (block.type === "tool-call" && typeof block.name === "string" && typeof block.arguments === "string") return 4 + Math.ceil(block.name.length / 4) + Math.ceil(block.arguments.length / 4);
    if (block.type === "tool-result" && Array.isArray(block.content)) return 4 + block.content.reduce<number>((sum, child: unknown) => sum + blockTokens(child), 0);
  }
  return 4 + Math.ceil(JSON.stringify(value).length / 4);
}

/** 按原块估算一条 surface 消息，助手推理遵循已选 Adapter 的发送规则。
 * @param prepared - 本步固定的模型及其参数。
 * @param message - 当前 surface 中的一条消息。
 * @param tools - 本步实际使用的工具定义。
 * @returns 估算的输入 token 数。
 */
export function estimateSurfaceMessageTokens(prepared: PreparedModel, message: SurfaceMessage, tools: readonly ModelTool[]): number {
  const includeReasoning = prepared.includesAssistantReasoning?.(tools) ?? true;
  return 4 + projectSurfaceMessage(message).content.reduce((sum, block) => sum + (block.type === "reasoning" && !includeReasoning ? 0 : blockTokens(block)), 0);
}

/** 估算请求输入，不包含输出预留；省略 system 与显式空字符串不同。
 * @param prepared - 本步固定的模型。
 * @param input - 当前 surface、系统提示及工具定义。
 * @returns 估算的输入 token 数。
 */
export function estimateRequestTokens(prepared: PreparedModel, input: MeterInput): number {
  const tools = input.tools ?? [];
  return (input.systemPrompt === undefined ? 0 : 4 + Math.ceil(input.systemPrompt.length / 4)) +
    (tools.length ? 4 + Math.ceil(JSON.stringify(tools).length / 4) : 0) +
    input.messages.reduce((sum, message) => sum + estimateSurfaceMessageTokens(prepared, message, tools), 0);
}

/** 压力结果；缺少容量时提供稳定原因，不进行自动阈值判断。
 * pressure 在安全整数范围内为 number，超出时为精确 bigint；JSON 序列化前调用方须转换 bigint。
 */
export type RequestPressure = Readonly<{ status: "unavailable"; reason: "missing-context-window" | "missing-output-budget" }> | Readonly<{
  status: "measured"; inputTokens: number; outputTokens: number; pressure: number | bigint; contextWindow: number; threshold: number; tailBudget: number; triggered: boolean;
}>;

/** 基于固定模型和当前 surface 计算压力，不修改会话或触发请求。
 * @param prepared - 本步固定的模型，显式或生成默认上限优先于计量默认值。
 * @param input - 每次测量使用的当前输入。
 * @returns 可测量压力或容量缺失原因。
 */
export function measureRequestPressure(prepared: PreparedModel, input: MeterInput): RequestPressure {
  const contextWindow = prepared.modelBudget?.contextWindow;
  if (contextWindow === undefined) return { status: "unavailable", reason: "missing-context-window" };
  const outputTokens = prepared.effectiveParams.maxOutputTokens ?? prepared.modelBudget?.defaultOutputTokens;
  if (outputTokens === undefined) return { status: "unavailable", reason: "missing-output-budget" };
  const inputTokens = estimateRequestTokens(prepared, input);
  const exactPressure = BigInt(inputTokens) + BigInt(outputTokens);
  const pressure = exactPressure <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(exactPressure) : exactPressure;
  const threshold = Number(BigInt(contextWindow) * 4n / 5n);
  const tailBudget = Number(BigInt(contextWindow) * 4n / 25n);
  return { status: "measured", inputTokens, outputTokens, pressure, contextWindow, threshold, tailBudget, triggered: exactPressure >= BigInt(threshold) };
}

/** 检查自动压力；容量缺失时调用一次告警并返回缺失原因。
 * @param prepared - 本步固定的模型。
 * @param input - 当前 surface 及固定请求上下文。
 * @param warn - 接收实际路由和缺失原因的告警回调。
 * @returns 压力结果，缺失时由调用方继续执行。
 */
export function checkAutomaticPressure(prepared: PreparedModel, input: MeterInput, warn: (route: PreparedModel["route"], reason: Extract<RequestPressure, { status: "unavailable" }>["reason"]) => void): RequestPressure {
  const result = measureRequestPressure(prepared, input);
  if (result.status === "unavailable") warn(prepared.route, result.reason);
  return result;
}
