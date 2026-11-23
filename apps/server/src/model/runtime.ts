import { localConfig } from "../../../../config/local.ts";
import { LlmError } from "./adapter.ts";
import type {
  GenerationParams,
  StreamChunk,
  LlmFinishReason,
  ModelAdapter,
  ModelBudget,
  ModelInput,
  ModelTool,
  ModelRequest,
  ModelRoute,
  RequestTimeouts,
} from "./adapter.ts";

/** 一次模型调用的配置。请求参数优先于 Adapter 默认值。 */
export type ModelConfig = ModelRoute & Readonly<{
  params?: GenerationParams;
  timeouts?: Partial<RequestTimeouts>;
}>;

/** 已选定 Adapter 的配置快照，可在会话检查点完成后用于生成。 */
export interface PreparedModel {
  /** 当前模型的本地容量快照，缺省表示没有声明。 */
  readonly modelBudget?: ModelBudget;
  /** Adapter 明确支持关闭推理时，可作为摘要推理设置使用的值。 */
  readonly disableReasoningEffort?: "none";
  /** 按本次固定参数判断工具列表下是否发送助手推理；缺省表示发送。 */
  includesAssistantReasoning?(tools: readonly ModelTool[]): boolean;
  /** 可记录的实际路由。 */
  readonly route: ModelRoute;
  /** 合并 Adapter 默认值后的可记录参数。 */
  readonly effectiveParams: GenerationParams;
  /** 模型信息或旧 Adapter 默认值补入的可记录参数。 */
  readonly adapterDefaults?: Readonly<{ maxTokens?: number; reasoningEffort?: string }>;

  /**
   * 消费时启动一次生成，交付按序增量和一个终止事件，随后结束。
   * 提前退出迭代时关闭 Adapter 流，不交付额外事件。
   * @param input - 已准备的上下文，消费完成前应保持不变。
   * @param signal - 调用方取消信号，可用于用户取消或 Turn 预算耗尽。调用方负责区分来源。
   * @param options - 可选的摘要观察回调；已交付的失败或取消终态在检查迟到取消及 Adapter 清理前通知，取消检查回调只在本运行时检查触发时通知；尚无失败终态且非本地取消检查时，Adapter 抛出的原值通过 onAdapterError 同步通知，该回调不得抛错。原值无法归一化时交付安全 UNKNOWN 终态。
   * @returns 统一异步流，Adapter 失败或取消通过终止事件交付。
   */
  generate(input: ModelInput, signal: AbortSignal, options?: { readonly onFailureTerminal?: (reason: Extract<LlmFinishReason, { kind: "error" | "aborted" }>, cancellation: { readonly present: boolean; readonly value: unknown }) => void; readonly onCancellationGuard?: (reason: unknown) => void; readonly onAdapterError?: (error: unknown) => void }): AsyncIterable<StreamChunk>;
}

function requiredId(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function validateParams({ temperature, topP, maxOutputTokens, reasoningEffort, stop }: GenerationParams): GenerationParams {
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new RangeError("temperature must be between 0 and 2");
  }
  if (topP !== undefined && (!Number.isFinite(topP) || topP < 0 || topP > 1)) {
    throw new RangeError("topP must be between 0 and 1");
  }
  if (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)) {
    throw new RangeError("maxOutputTokens must be a positive integer");
  }

  if (reasoningEffort !== undefined && (typeof reasoningEffort !== "string" || reasoningEffort.length === 0)) {
    throw new TypeError("reasoningEffort must be a non-empty string");
  }
  if (stop !== undefined && (!Array.isArray(stop) || stop.some((value) => typeof value !== "string"))) {
    throw new TypeError("stop must be an array of strings");
  }
  return Object.freeze({
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(stop === undefined ? {} : { stop: Object.freeze([...stop]) }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  });
}

function timeoutMs(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RangeError("Model timeouts must be positive milliseconds within the Node.js timer range");
  }
  return value;
}

/** 解析模型配置并统一流终态。每次生成只调用一次选定的 Adapter。 */
export class LlmRuntime {
  readonly #adapters: ReadonlyMap<string, ModelAdapter | (() => ModelAdapter)>;
  readonly #preparedAdapters = new WeakMap<PreparedModel, ModelAdapter>();

  /**
   * 固定此实例可选择的 Provider 及其 Adapter。
   * @param adapters - 以后端配置中的 Provider 标识为键的 Adapter 或每次准备时调用的 Adapter 供应者。
   */
  constructor(adapters: Readonly<Record<string, ModelAdapter | (() => ModelAdapter)>>) {
    this.#adapters = new Map(Object.entries(adapters));
  }

  /**
   * 校验配置并选择 Adapter，可在发起模型请求前读取可记录的路由和有效参数。
   * @param config - 请求的路由、生成参数和可选的请求级超时覆盖值。
   * @param options - recordable 为 true 时，未显式覆盖 Adapter 的 temperature 默认值会被拒绝。
   * @returns 冻结的配置快照和绑定该快照的生成入口。
   * @throws Provider 未注册、路由或参数无效，或可记录模式依赖未覆盖的 temperature 默认值时抛出错误。
   */
  prepare(config: ModelConfig, options: { recordable?: boolean } = {}): PreparedModel {
    const provider = requiredId(config.provider, "provider");
    const registration = this.#adapters.get(provider);
    if (!registration) throw new TypeError("Model provider is not registered");
    const adapter = typeof registration === "function" ? registration() : registration;
    return this.#prepareWithAdapter(config, adapter, options);
  }

  /**
   * 在同一路由上准备派生请求，沿用已选的 Adapter 及其连接配置。
   * @param snapshot - 由本 Runtime 固定的业务模型。
   * @param config - 相同路由上的独立请求参数与超时。
   * @returns 独立的请求快照，准备期间不会再次调用 Provider 工厂。
   * @throws 快照不属于本 Runtime、路由不一致或新参数无效时抛出。
   */
  prepareForSameRoute(snapshot: PreparedModel, config: ModelConfig): PreparedModel {
    const adapter = this.#preparedAdapters.get(snapshot);
    if (!adapter || config.provider !== snapshot.route.provider || config.model !== snapshot.route.model ||
      config.endpointId !== snapshot.route.endpointId) throw new TypeError("派生请求须使用本次已准备的模型路由");
    return this.#prepareWithAdapter(config, adapter);
  }

  #prepareWithAdapter(config: ModelConfig, adapter: ModelAdapter, options: { recordable?: boolean } = {}): PreparedModel {
    const route = Object.freeze({
      provider: requiredId(config.provider, "provider"),
      model: requiredId(config.model, "model"),
      ...(config.endpointId === undefined ? {} : { endpointId: requiredId(config.endpointId, "endpointId") }),
    });
    const modelBudgets = adapter.modelBudgets;
    const declaration = modelBudgets && Object.hasOwn(modelBudgets, route.model)
      ? modelBudgets[route.model] : undefined;
    const contextWindow = declaration?.contextWindow;
    const defaultOutputTokens = declaration?.defaultOutputTokens;
    for (const value of [contextWindow, defaultOutputTokens]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new RangeError("Invalid model budget");
    }
    const modelBudget = declaration ? Object.freeze({
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(defaultOutputTokens === undefined ? {} : { defaultOutputTokens }),
    }) : undefined;
    if (options.recordable && config.params?.temperature === undefined && adapter.defaultParams?.temperature !== undefined) {
      throw new TypeError("当前日志不能记录未显式覆盖的模型默认温度");
    }
    const info = adapter.modelInfo;
    const reasoningEffort = config.params?.reasoningEffort ?? info?.defaultReasoningEffort ?? adapter.defaultParams?.reasoningEffort;
    if (reasoningEffort !== undefined && info?.supportedReasoningEfforts &&
        !info.supportedReasoningEfforts.includes(reasoningEffort)) {
      throw new RangeError("reasoningEffort is not supported by the model");
    }
    const maxOutputTokens = config.params?.maxOutputTokens ?? info?.defaultMaxTokens ?? adapter.defaultParams?.maxOutputTokens;
    const effectiveParams = validateParams({
      temperature: config.params?.temperature ?? adapter.defaultParams?.temperature,
      topP: config.params?.topP ?? adapter.defaultParams?.topP,
      maxOutputTokens,
      reasoningEffort,
      stop: config.params?.stop,
    });
    adapter.validateParams?.(effectiveParams);
    const defaults = {
      ...(config.params?.maxOutputTokens === undefined && maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
      ...(config.params?.reasoningEffort === undefined && reasoningEffort !== undefined ? { reasoningEffort } : {}),
    };
    const adapterDefaults = Object.keys(defaults).length ? Object.freeze(defaults) : undefined;
    const timeouts = Object.freeze({
      requestTimeoutMs: timeoutMs(config.timeouts?.requestTimeoutMs ?? localConfig.model.requestTimeoutMs),
      idleTimeoutMs: timeoutMs(config.timeouts?.idleTimeoutMs ?? localConfig.model.idleTimeoutMs),
    });

    const includesAssistantReasoning = adapter.includesAssistantReasoning?.bind(adapter);
    const snapshot: PreparedModel = Object.freeze({
      route,
      effectiveParams,
      ...(modelBudget ? { modelBudget } : {}),
      ...(info?.supportedReasoningEfforts?.includes("none") ? { disableReasoningEffort: "none" as const } : {}),
      ...(includesAssistantReasoning ? { includesAssistantReasoning: (tools: readonly ModelTool[]) => includesAssistantReasoning(effectiveParams, tools) } : {}),
      ...(adapterDefaults ? { adapterDefaults } : {}),
      generate: (input: ModelInput, signal: AbortSignal, options?: { readonly onFailureTerminal?: (reason: Extract<LlmFinishReason, { kind: "error" | "aborted" }>, cancellation: { readonly present: boolean; readonly value: unknown }) => void; readonly onCancellationGuard?: (reason: unknown) => void; readonly onAdapterError?: (error: unknown) => void }) =>
        generate(adapter, { ...input, route, effectiveParams, timeouts }, signal, options),
    });
    this.#preparedAdapters.set(snapshot, adapter);
    return snapshot;
  }
}

async function* generate(
  adapter: ModelAdapter,
  request: ModelRequest,
  signal: AbortSignal,
  options?: { readonly onFailureTerminal?: (reason: Extract<LlmFinishReason, { kind: "error" | "aborted" }>, cancellation: { readonly present: boolean; readonly value: unknown }) => void; readonly onCancellationGuard?: (reason: unknown) => void; readonly onAdapterError?: (error: unknown) => void },
): AsyncGenerator<StreamChunk> {
  let reason: LlmFinishReason | undefined;
  let observed: Extract<LlmFinishReason, { kind: "error" | "aborted" }> | undefined;
  let guardCancelled = false;
  const checkCancellation = () => { if (signal.aborted) { guardCancelled = true; options?.onCancellationGuard?.(signal.reason); signal.throwIfAborted(); } };
  try {
    checkCancellation();
    for await (const chunk of adapter.generate(request, signal)) {
      if (options?.onFailureTerminal && chunk.type === "finish" &&
        (chunk.reason.kind === "error" || chunk.reason.kind === "aborted")) {
        observed = chunk.reason;
        options.onFailureTerminal(observed, { present: signal.aborted, value: signal.aborted ? signal.reason : undefined });
        break;
      }
      checkCancellation();
      if (chunk.type === "finish") {
        reason = chunk.reason;
        break;
      }
      yield chunk;
      checkCancellation();
    }
  } catch (error: unknown) {
    if (!observed) {
      if (guardCancelled && options?.onCancellationGuard) {
        reason = { kind: "aborted" };
      } else {
        const capture = !guardCancelled ? options?.onAdapterError : undefined;
        capture?.(error);
        const normalize = () => options?.onFailureTerminal && error instanceof Error && error.name === "AbortError"
          ? { kind: "aborted" } as const
          : (error instanceof LlmError ? error : new LlmError("UNKNOWN")).toFinishReason();
        if (capture) {
          try { reason = normalize(); } catch { reason = new LlmError("UNKNOWN").toFinishReason(); }
        } else {
          reason = normalize();
        }
        if (options?.onFailureTerminal && !guardCancelled) observed = reason;
      }
    }
  }

  // 先关闭 Adapter 迭代器，避免清理失败在已经交付 finish 后形成第二个终态。
  yield {
    type: "finish",
    reason: observed ?? (signal.aborted ? { kind: "aborted" } : reason ?? new LlmError("STREAM_CLOSED").toFinishReason()),
  };
}
