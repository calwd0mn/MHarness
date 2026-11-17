/** 可记录的模型路由。endpointId 是后端配置标识。 */
export type ModelRoute = Readonly<{ provider: string; model: string; endpointId?: string }>;

/** 统一生成参数。省略的字段由 Adapter 或 Provider 决定。 */
export type GenerationParams = Readonly<{
  /** 采样温度，取值 0 至 2。 */
  temperature?: number;
  /** 核采样概率，取值 0 至 1。 */
  topP?: number;
  /** 允许生成的最大 token 数，须为正整数；会话请求头将其记录为 maxTokens。 */
  maxOutputTokens?: number;
  /** 模型推理强度；支持值由模型信息约束。 */
  reasoningEffort?: string;
  /** 生成遇到任一停止序列时结束。 */
  stop?: readonly string[];
}>;

/** 独立于 Turn 总预算的请求级等待上限，单位为毫秒。 */
export type RequestTimeouts = Readonly<{
  /** 从启动请求到首个流事件。 */
  requestTimeoutMs: number;
  /** 消费方等待下一个流事件的时限。 */
  idleTimeoutMs: number;
}>;

/** 模型发出的完整调用，arguments 保留原始字符串，供工具层解析。 */
export type ModelToolCall = Readonly<{ callId: string; name: string; arguments: string }>;

/** 按模型可见顺序交付的消息。工具结果以 callId 关联对应的 Assistant 调用；reasoning 来自已结算的推理块，由 Adapter 决定是否发送。 */
export type ModelMessage =
  | Readonly<{ role: "user"; text: string }>
  | Readonly<{ role: "assistant"; text: string; reasoning?: string; toolCalls?: readonly ModelToolCall[] }>
  | Readonly<{ role: "tool"; callId: string; text: string }>;

/** 模型可见的工具定义，inputSchema 为 JSON Schema 对象。 */
export type ModelTool = Readonly<{
  name: string;
  description?: string;
  inputSchema: Readonly<Record<string, unknown>>;
}>;

/** 调用方为本次生成准备的上下文，消费完成前应保持不变。 */
export type ModelInput = Readonly<{
  systemPrompt: string;
  messages: readonly ModelMessage[];
  tools: readonly ModelTool[];
}>;

/** Adapter 生成期间使用的有效路由、参数和上下文。 */
export type ModelRequest = ModelInput & Readonly<{
  route: ModelRoute;
  effectiveParams: GenerationParams;
  timeouts: RequestTimeouts;
}>;

const failureMessages = {
  AUTH: "Provider authentication failed",
  RATE_LIMIT: "Provider rate limit exceeded",
  TRANSPORT: "Provider transport failed",
  PROTOCOL: "Provider stream violated the expected protocol",
  EMPTY_RESPONSE: "Provider returned an empty response",
  STREAM_CLOSED: "Provider stream ended without a finish event",
  TIMEOUT: "Provider request timed out",
  UNKNOWN: "Unexpected model adapter failure",
} as const;

/** 取消走独立终态，其余代码用于归类失败。 */
export type LlmErrorCode = keyof typeof failureMessages | "ABORTED";

/** 可随失败结算保存的诊断。重试间隔仅供诊断，单位为毫秒。 */
export type LlmDiagnostics = Readonly<{
  httpStatus?: number;
  retryAfterMs?: number;
  timeoutPhase?: "request" | "idle";
}>;

/** 可交付给上层的失败信息，message 使用固定文案。 */
export type LlmFailure = Readonly<{
  code: Exclude<LlmErrorCode, "ABORTED">;
  message: string;
}> & LlmDiagnostics;

/** Adapter 用于报告已归类的失败或取消。 */
export class LlmError extends Error {
  /**
   * 创建带稳定代码的错误，使用固定文案以便安全归一化。
   * @param code - 接入层识别出的错误类别。
   * @param diagnostics - 可交付给上层的结构化诊断。
   * @param options - 可包含原始 cause，Runtime 不将它放入流。
   */
  constructor(
    readonly code: LlmErrorCode,
    readonly diagnostics: LlmDiagnostics = {},
    options?: ErrorOptions,
  ) {
    super(code === "ABORTED" ? "Model request aborted" : failureMessages[code], options);
    this.name = "LlmError";
  }

  /**
   * 生成只含固定文案和通过检查的诊断字段的终态。
   * @returns 取消终态或附带安全诊断的失败终态。
   */
  toFinishReason(): Extract<LlmFinishReason, { kind: "error" | "aborted" }> {
    if (this.code === "ABORTED") return { kind: "aborted" };

    const { httpStatus, retryAfterMs, timeoutPhase } = this.diagnostics;
    return {
      kind: "error",
      failure: {
        code: this.code,
        message: failureMessages[this.code],
        ...(httpStatus !== undefined && Number.isInteger(httpStatus) &&
          httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
        ...(retryAfterMs !== undefined && Number.isSafeInteger(retryAfterMs) &&
          retryAfterMs >= 0 ? { retryAfterMs } : {}),
        ...(this.code === "TIMEOUT" && (timeoutPhase === "request" || timeoutPhase === "idle")
          ? { timeoutPhase } : {}),
      },
    };
  }
}

/** 单次模型请求的结束原因。max-tokens 表示模型输出被截断。 */
export type LlmFinishReason =
  | Readonly<{ kind: "stop" | "tool-calls" | "max-tokens" }>
  | Readonly<{ kind: "aborted" }>
  | Readonly<{ kind: "error"; failure: LlmFailure }>;

/** 模型流格式由 Adapter、Runtime 与 Attempt 共用。 */
export type { StreamBlock, StreamChunk } from "./stream-types.ts";
import type { StreamChunk } from "./stream-types.ts";
/** Adapter 提供的模型默认值和推理能力。 */
export type ModelInfo = Readonly<{
  defaultMaxTokens?: number;
  supportedReasoningEfforts?: readonly string[];
  defaultReasoningEffort?: string;
}>;

/** 模型接入边界。Adapter 持有厂商连接、鉴权和取消所需资源。 */
export interface ModelAdapter {
  /** 请求省略字段时使用的 Adapter 生成参数默认值。 */
  readonly defaultParams?: GenerationParams;
  /** 当前 Adapter 模型的能力和可记录默认值。 */
  readonly modelInfo?: ModelInfo;

  /**
   * 检查合并默认值后的生成参数；准备阶段执行，失败时不得发起请求。
   * @param params - Runtime 已通用校验的有效参数。
   * @throws 参数不受该模型支持时抛出错误。
   */
  validateParams?(params: GenerationParams): void;

  /**
   * 发起一次模型请求并交付统一流。正常结束时交付 finish，失败或取消时抛出 LlmError。
   * 迭代关闭时释放底层流及其资源。
   * @param request - 准备阶段确定的输入和配置快照。
   * @param signal - 取消当前请求和流读取的信号，Turn 的预算由调用方管理。
   * @returns 模型增量和正常结束事件组成的异步流。
   * @throws 请求失败或取消时在消费流期间抛出 LlmError。
   */
  generate(request: ModelRequest, signal: AbortSignal): AsyncIterable<StreamChunk>;
}
