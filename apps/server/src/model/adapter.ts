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

/** 按模型可见顺序交付的消息。工具结果以 callId 关联对应的 assistant 调用。 */
export type ModelMessage =
  | Readonly<{ role: "user"; text: string }>
  | Readonly<{ role: "assistant"; text: string; toolCalls?: readonly ModelToolCall[] }>
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

/** 单次模型请求的结束原因。output_limit 表示模型输出被截断。 */
export type LlmFinishReason =
  | Readonly<{ kind: "stop" | "tool_calls" | "output_limit" }>
  | Readonly<{ kind: "aborted" }>
  | Readonly<{ kind: "error"; failure: LlmFailure }>;

/**
 * 单次请求内按序交付的统一流。工具分片以从 0 开始的 index 归组，按到达顺序拼接 argumentsDelta。
 * 首个分片提供 callId 和 name，后续分片可以省略它们。usage 表示截至该事件的累计 token 数。
 */
export type AdapterChunk =
  | Readonly<{ type: "text" | "reasoning"; delta: string }>
  | Readonly<{ type: "tool_call"; index: number; callId?: string; name?: string; argumentsDelta: string }>
  | Readonly<{ type: "usage"; inputTokens: number; outputTokens: number }>
  | Readonly<{ type: "finish"; reason: Extract<LlmFinishReason, { kind: "stop" | "tool_calls" | "output_limit" }> }>;

/** Runtime 的统一输出流，在 Adapter 的正常流之外还可用 finish 表示失败或取消。 */
export type LlmChunk = Exclude<AdapterChunk, { type: "finish" }> | Readonly<{
  type: "finish";
  reason: LlmFinishReason;
}>;

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
   * 发起一次模型请求并交付统一流。正常结束时交付 finish，失败或取消时抛出 LlmError。
   * 迭代关闭时释放底层流及其资源。
   * @param request - 准备阶段确定的输入和配置快照。
   * @param signal - 取消当前请求和流读取的信号，Turn 的预算由调用方管理。
   * @returns 模型增量和正常结束事件组成的异步流。
   * @throws 请求失败或取消时在消费流期间抛出 LlmError。
   */
  generate(request: ModelRequest, signal: AbortSignal): AsyncIterable<AdapterChunk>;
}
