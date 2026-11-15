import { localConfig } from "../../../../config/local.ts";
import { LlmError } from "./adapter.ts";
import type {
  GenerationParams,
  LlmChunk,
  LlmFinishReason,
  ModelAdapter,
  ModelInput,
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
  /** 可记录的实际路由。 */
  readonly route: ModelRoute;
  /** 合并 Adapter 默认值后的可记录参数。 */
  readonly effectiveParams: GenerationParams;

  /**
   * 消费时启动一次生成，交付按序增量和一个终止事件，随后结束。
   * 提前退出迭代时关闭 Adapter 流，不交付额外事件。
   * @param input - 已准备的上下文，消费完成前应保持不变。
   * @param signal - 调用方取消信号，可用于用户取消或 Turn 预算耗尽。调用方负责区分来源。
   * @returns 统一异步流，Adapter 失败或取消通过终止事件交付。
   */
  generate(input: ModelInput, signal: AbortSignal): AsyncIterable<LlmChunk>;
}

function requiredId(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function validateParams({ temperature, topP, maxOutputTokens }: GenerationParams): GenerationParams {
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new RangeError("temperature must be between 0 and 2");
  }
  if (topP !== undefined && (!Number.isFinite(topP) || topP < 0 || topP > 1)) {
    throw new RangeError("topP must be between 0 and 1");
  }
  if (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)) {
    throw new RangeError("maxOutputTokens must be a positive integer");
  }

  return Object.freeze({
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
  readonly #adapters: ReadonlyMap<string, ModelAdapter>;

  /**
   * 固定此实例可选择的 Provider 及其 Adapter。
   * @param adapters - 以后端配置中的 Provider 标识为键的 Adapter 注册表。
   */
  constructor(adapters: Readonly<Record<string, ModelAdapter>>) {
    this.#adapters = new Map(Object.entries(adapters));
  }

  /**
   * 校验配置并选择 Adapter，可在发起模型请求前读取可记录的路由和有效参数。
   * @param config - 请求的路由、生成参数和可选的请求级超时覆盖值。
   * @returns 冻结的配置快照和绑定该快照的生成入口。
   * @throws Provider 未注册、路由标识为空或参数超出允许范围时抛出错误。
   */
  prepare(config: ModelConfig): PreparedModel {
    const provider = requiredId(config.provider, "provider");
    const adapter = this.#adapters.get(provider);
    if (!adapter) throw new TypeError("Model provider is not registered");

    const route = Object.freeze({
      provider,
      model: requiredId(config.model, "model"),
      ...(config.endpointId === undefined ? {} : { endpointId: requiredId(config.endpointId, "endpointId") }),
    });
    const effectiveParams = validateParams({
      temperature: config.params?.temperature ?? adapter.defaultParams?.temperature,
      topP: config.params?.topP ?? adapter.defaultParams?.topP,
      maxOutputTokens: config.params?.maxOutputTokens ?? adapter.defaultParams?.maxOutputTokens,
    });
    const timeouts = Object.freeze({
      requestTimeoutMs: timeoutMs(config.timeouts?.requestTimeoutMs ?? localConfig.model.requestTimeoutMs),
      idleTimeoutMs: timeoutMs(config.timeouts?.idleTimeoutMs ?? localConfig.model.idleTimeoutMs),
    });

    return Object.freeze({
      route,
      effectiveParams,
      generate: (input: ModelInput, signal: AbortSignal) =>
        generate(adapter, { ...input, route, effectiveParams, timeouts }, signal),
    });
  }
}

async function* generate(
  adapter: ModelAdapter,
  request: ModelRequest,
  signal: AbortSignal,
): AsyncGenerator<LlmChunk> {
  let reason: LlmFinishReason | undefined;
  try {
    signal.throwIfAborted();
    for await (const chunk of adapter.generate(request, signal)) {
      signal.throwIfAborted();
      if (chunk.type === "finish") {
        reason = chunk.reason;
        break;
      }
      yield chunk;
      signal.throwIfAborted();
    }
  } catch (error: unknown) {
    reason = (error instanceof LlmError ? error : new LlmError("UNKNOWN")).toFinishReason();
  }

  // 先关闭 Adapter 迭代器，避免清理失败在已经交付 finish 后形成第二个终态。
  yield {
    type: "finish",
    reason: signal.aborted ? { kind: "aborted" } : reason ?? new LlmError("STREAM_CLOSED").toFinishReason(),
  };
}
