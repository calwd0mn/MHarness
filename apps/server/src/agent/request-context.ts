import { isDeepStrictEqual } from "node:util";
import type { Session } from "@mharness/session/server";
import type { ModelInput, ModelMessage, ModelTool } from "../model/adapter.ts";
import type { LlmRuntime, ModelConfig, PreparedModel } from "../model/runtime.ts";

type Event = ReturnType<Session["snapshot"]>["events"][number];
type Header = Extract<Event, { type: "request/header" }>["data"]["header"];

/** 每次模型请求读取的配置和上下文供应者。 */
export type RequestContextOptions = {
  runtime: LlmRuntime;
  config: () => ModelConfig;
  systemPrompt: () => string;
  tools?: () => readonly ModelTool[];
};

function messages(session: Session): ModelMessage[] {
  return session.deriveMessages().map((message): ModelMessage => {
    if (message.role === "assistant") {
      const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      const reasoningBlocks = message.content.filter((block) => block.type === "reasoning");
      const reasoning = reasoningBlocks.map((block) => block.text).join("");
      const toolCalls = message.content.filter((block) => block.type === "tool-call")
        .map((block) => ({ callId: block.id, name: block.name, arguments: block.arguments }));
      return { role: "assistant", text, ...(reasoningBlocks.length ? { reasoning } : {}), ...(toolCalls.length ? { toolCalls } : {}) };
    }
    if (message.source.kind === "tool") return {
      role: "tool", callId: message.source.callId,
      text: JSON.stringify(message.content.find((block) => block.type === "tool-result")?.content),
    };
    return { role: "user", text: message.content.filter((block) => block.type === "text").map((block) => block.text).join("") };
  });
}

function freezeTree(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
}

function modelTools(header: Header): readonly ModelTool[] {
  const tools = header.tools ?? [];
  for (const value of tools) {
    const tool: unknown = value;
    if (tool === null || typeof tool !== "object" || Array.isArray(tool) ||
      !("name" in tool) || typeof tool.name !== "string" || ("description" in tool && tool.description !== undefined && typeof tool.description !== "string") ||
      !("inputSchema" in tool) || tool.inputSchema === null || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
      throw new TypeError("请求头中的工具定义无效");
    }
  }
  return tools as readonly ModelTool[];
}

/**
 * 折叠日志前缀中最近的请求头。
 * @param events - 按日志顺序排列的事件前缀。
 * @returns 最近请求头；前缀没有请求头时返回 undefined。
 */
export function foldRequestHeader(events: readonly Event[]): Header | undefined {
  return events.findLast((event) => event.type === "request/header")?.data.header;
}

/**
 * 从已重放到请求结算之前的会话重建模型输入。
 * @param session - 包含目标请求之前完整日志前缀的会话。
 * @returns 生效请求头和与该前缀对应的独立消息数组。
 * @throws 前缀没有请求头或工具定义无法解释时抛出。
 */
export function rebuildRequestContext(session: Session): { header: Header; input: ModelInput } {
  const header = foldRequestHeader(session.snapshot().events);
  if (!header) throw new Error("请求前缀缺少请求头");
  return { header, input: { systemPrompt: header.system ?? "", messages: messages(session), tools: modelTools(header) } };
}

/**
 * 创建每次独立准备模型配置和上下文的入口，按需向会话追加请求头。
 * @param options - Runtime 及每次请求读取一次的配置、系统提示和工具供应者。
 * @returns 同步准备函数；调用方须在启动生成前 flush 会话。startsSeries 显式开启新消息系列。
 * @throws 准备时无法记录路由或参数、模型配置无效或工具不可记录时抛出。
 */
export function createRequestPreparer(options: RequestContextOptions):
  (session: Session, startsSeries?: boolean) => { prepared: PreparedModel; input: ModelInput } {
  const seen = new WeakMap<Session, { header: Header; generation: number }>();
  return (session, startsSeries = false) => {
    const config = options.config();
    if (config.endpointId !== undefined || config.params?.topP !== undefined) throw new Error("当前日志不能记录该模型配置");
    const prepared = options.runtime.prepare(config, { recordable: true });
    if (prepared.effectiveParams.topP !== undefined) throw new Error("当前日志不能记录该模型配置");
    const params = prepared.effectiveParams;
    const tools = structuredClone(options.tools?.() ?? []);
    const header = {
      config: {
        provider: prepared.route.provider, model: prepared.route.model,
        ...(params.reasoningEffort === undefined ? {} : { reasoningEffort: params.reasoningEffort }),
        ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
        ...(params.maxOutputTokens === undefined ? {} : { maxTokens: params.maxOutputTokens }),
        ...(params.stop === undefined ? {} : { stop: params.stop }),
      },
      ...(prepared.adapterDefaults ? { adapterDefaults: prepared.adapterDefaults } : {}),
      system: options.systemPrompt(), tools,
    };
    modelTools(header as Header);
    const previous = seen.get(session);
    const priorHeader = foldRequestHeader(session.snapshot().events);
    const resumes = priorHeader !== undefined || session.header.isSeeded === true;
    const changed = previous && !isDeepStrictEqual(priorHeader, header);
    const series = startsSeries || (previous !== undefined && previous.generation !== session.replaceGeneration);
    let actualHeader: Header;
    if (!previous || changed || series) {
      const event = session.append({ type: "request/header", data: {
        header: header as Header,
        reason: !previous ? resumes ? "resume" : "initial" : changed ? "change" : "series",
        ...(previous && changed && series ? { startsSeries: true as const } : {}),
      } });
      actualHeader = event.data.header;
    } else actualHeader = priorHeader ?? previous.header;
    seen.set(session, { header: actualHeader, generation: session.replaceGeneration });
    const input: ModelInput = { systemPrompt: actualHeader.system ?? "", messages: messages(session), tools: modelTools(actualHeader) };
    freezeTree(input);
    return { prepared, input };
  };
}
