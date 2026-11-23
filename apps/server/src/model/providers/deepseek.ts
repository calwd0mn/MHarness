import { z } from "zod";
import { LlmError, type ModelAdapter, type ModelMessage, type StreamChunk } from "../adapter.ts";

const eventSchema = z.object({
  choices: z.array(z.object({ delta: z.object({ content: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional(), tool_calls: z.array(z.object({ index: z.number().int().nonnegative(), id: z.string().optional(), function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional() })).optional() }).optional(),
    finish_reason: z.string().nullable().optional() })).optional(),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).nullable().optional(),
});

function isContextLimit(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const error = value as Record<string, unknown>;
  if (error.error && isContextLimit(error.error)) return true;
  if ([error.code, error.type].some((item) => item === "context_length_exceeded" || item === "context_window_exceeded")) return true;
  return typeof error.message === "string" && (/\binput tokens? exceed(?:s|ed)? the limit\b/i.test(error.message) || /\bmaximum context length\b[\s\S]*\b(?:exceeded|requested)\b/i.test(error.message));
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : NaN;
  const httpDate = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4})$/.test(value);
  const legacyYear = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-\w{3}-(\d{2}) /.exec(value);
  const limit = new Date(Date.now());
  limit.setUTCFullYear(limit.getUTCFullYear() + 50);
  let dateText = value;
  if (legacyYear) {
    let year = Math.floor(limit.getUTCFullYear() / 100) * 100 + Number(legacyYear[1]);
    dateText = value.replace(`-${legacyYear[1]} `, `-${year} `);
    if (Date.parse(dateText) > limit.getTime()) {
      year -= 100;
      dateText = value.replace(`-${legacyYear[1]} `, `-${year} `);
    }
  }
  const parsedDate = httpDate ? Date.parse(dateText.endsWith(" GMT") ? dateText : `${dateText} GMT`) : NaN;
  const instant = new Date(parsedDate);
  const canonical = Number.isFinite(parsedDate) ? instant.toUTCString() : "";
  const parts = /^(\w{3}), (\d{2}) (\w{3}) (\d{4}) (\d{2}:\d{2}:\d{2}) GMT$/.exec(canonical);
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const obsolete = parts ? `${weekdays[instant.getUTCDay()]}, ${parts[2]}-${parts[3]}-${parts[4]?.slice(2)} ${parts[5]} GMT` : "";
  const asctime = parts ? `${parts[1]} ${parts[3]} ${parts[2]?.replace(/^0/, " ")} ${parts[5]} ${parts[4]}` : "";
  const date = [canonical, obsolete, asctime].includes(value) ? parsedDate : NaN;
  const result = Number.isNaN(seconds) ? date - Date.now() : seconds;
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}
function includesReasoning(params: import("../adapter.ts").GenerationParams, tools: readonly import("../adapter.ts").ModelTool[]): boolean {
  return params.reasoningEffort !== "none" && tools.length > 0;
}

function messageBody(message: ModelMessage, includeReasoning: boolean) {
  if (message.role === "user") return { role: "user", content: message.text };
  if (message.role === "tool") return { role: "tool", tool_call_id: message.callId, content: message.text };
  return { role: "assistant", content: message.text,
    ...(includeReasoning ? { reasoning_content: message.reasoning ?? "" } : {}),
    ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({ id: call.callId, type: "function",
      function: { name: call.name, arguments: call.arguments } })) } : {}) };
}

/** DeepSeek 单次请求的连接配置；凭据不会进入可记录模型路由。 */
export type DeepSeekOptions = Readonly<{ apiKey: string; baseUrl?: string; fetch?: typeof fetch }>;

/**
 * 创建绑定连接凭据的 DeepSeek Chat Completions Adapter。
 * 不支持的显式结束原因在收到 DONE 后以 PROTOCOL 失败，不推断成功或调用方取消。
 * 每次生成至多发送一次请求；超时或取消会中止请求并释放本地 reader、计时器和监听器，
 * 不等待不合作的传输或取消回调完成。
 * @param options - 请求凭据、可选 API 基础地址及受控传输。基础地址缺省或为空时使用 DeepSeek 官方地址，
 * 保留路径前缀并追加 /chat/completions；传输缺省时使用全局 fetch。
 * @returns 可注册到 Runtime 的单次请求 Adapter。
 * @throws 基础地址不是 HTTP(S) URL，或包含用户信息、查询参数或片段时抛出 TypeError。
 */
export function createDeepSeekAdapter(options: DeepSeekOptions): ModelAdapter {
  const apiKey = options.apiKey;
  const transport = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl?.trim() || "https://api.deepseek.com";
  const endpoint = URL.parse(baseUrl);
  if (!endpoint || !/^https?:\/\//i.test(baseUrl) || endpoint.username || endpoint.password || /[?#]/.test(baseUrl)) {
    throw new TypeError("DeepSeek 基础地址必须是无用户信息、查询参数和片段的 HTTP(S) URL");
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/chat/completions`;
  const requestUrl = endpoint.href;
  return {
    includesAssistantReasoning: includesReasoning,
    modelInfo: { defaultReasoningEffort: "none", supportedReasoningEfforts: ["none", "low", "high", "max"] },
    validateParams(params) {
      if (params.reasoningEffort !== "none" && (params.temperature !== undefined || params.topP !== undefined)) throw new RangeError("推理模式不支持采样参数");
      if (params.maxOutputTokens !== undefined && params.maxOutputTokens > 393216) throw new RangeError("maxOutputTokens 超出模型限制");
      if (params.stop && (params.stop.length > 16 || params.stop.some((value) => new TextEncoder().encode(value).length > 512))) throw new RangeError("stop 超出模型限制");
    },
    async *generate(request, signal) {
      const controller = new AbortController();
      let terminal: LlmError | undefined;
      let phase: "request" | "idle" = "request";
      let remaining = request.timeouts.requestTimeoutMs;
      const check = () => { if (terminal) throw terminal; };
      const abort = () => { terminal ??= new LlmError("ABORTED"); controller.abort(); };
      const timeout = () => { terminal ??= new LlmError("TIMEOUT", { timeoutPhase: phase }); controller.abort(); };
      const checkBudget = () => { check(); if (remaining <= 0) timeout(); check(); };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      const wait = async <T>(promise: Promise<T>, late?: (value: T) => void): Promise<T> => {
        if (!terminal && remaining <= 0) timeout();
        if (terminal) {
          void promise.then(late ?? (() => {}), () => {});
          throw terminal;
        }
        const start = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        const stopped = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(terminal ?? new LlmError("ABORTED"));
          controller.signal.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(timeout, remaining);
        });
        try {
          const value = await Promise.race([promise, stopped]);
          check();
          if (Date.now() - start >= remaining) timeout();
          check();
          return value;
        } catch (error: unknown) {
          if (terminal && late) void promise.then(late, () => {});
          throw terminal ?? error;
        } finally {
          remaining = Math.max(0, remaining - (Date.now() - start));
          if (timer !== undefined) clearTimeout(timer);
          if (onAbort) controller.signal.removeEventListener("abort", onAbort);
        }
      };
      try {
        checkBudget();
        let response: Response;
        try {
          response = await wait(transport(requestUrl, {
            method: "POST", redirect: "error", signal: controller.signal,
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ model: request.route.model, stream: true,
              messages: [{ role: "system", content: request.systemPrompt }, ...request.messages.map((message) => messageBody(message, includesReasoning(request.effectiveParams, request.tools)))],
              thinking: { type: request.effectiveParams.reasoningEffort === "none" ? "disabled" : "enabled" },
              ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: "function", function: {
                name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), parameters: tool.inputSchema,
              } })) } : {}),
              ...(request.effectiveParams.reasoningEffort && request.effectiveParams.reasoningEffort !== "none" ? { reasoning_effort: request.effectiveParams.reasoningEffort } : {}),
              ...(request.effectiveParams.temperature === undefined ? {} : { temperature: request.effectiveParams.temperature }),
              ...(request.effectiveParams.topP === undefined ? {} : { top_p: request.effectiveParams.topP }),
              ...(request.effectiveParams.maxOutputTokens === undefined ? {} : { max_tokens: request.effectiveParams.maxOutputTokens }),
              ...(request.effectiveParams.stop === undefined ? {} : { stop: request.effectiveParams.stop }),
            }),
          }), (lateResponse) => { void lateResponse.body?.cancel().catch(() => {}); });
        } catch (error: unknown) { if (error instanceof LlmError) throw error; throw new LlmError("TRANSPORT", {}, { cause: error }); }
        if (!response.ok) {
          const status = response.status;
          if (status === 401 || status === 403) {
            void response.body?.cancel().catch(() => {});
            throw new LlmError("AUTH", { httpStatus: status });
          }
          if (status === 429) {
            const delay = retryAfter(response.headers.get("retry-after"));
            void response.body?.cancel().catch(() => {});
            throw new LlmError("RATE_LIMIT", { httpStatus: status, ...(delay === undefined ? {} : { retryAfterMs: delay }) });
          }
          let contextLimit = false;
          if (response.body) {
            const errorReader = response.body.getReader();
            const errorDecoder = new TextDecoder();
            let errorBody = "";
            try {
              while (errorBody.length <= 65536) {
                checkBudget();
                const part = await wait(errorReader.read());
                errorBody += errorDecoder.decode(part.value, { stream: !part.done });
                if (part.done) break;
              }
              try { contextLimit = isContextLimit(JSON.parse(errorBody)); } catch { /* 非 JSON 错误没有可识别的超限信息。 */ }
            } catch (error: unknown) {
              if (error instanceof LlmError) throw error;
            } finally {
              void errorReader.cancel().catch(() => {});
              errorReader.releaseLock();
            }
          }
          throw new LlmError(contextLimit ? "CONTEXT_WINDOW_EXCEEDED" : "TRANSPORT", { httpStatus: status });
        }
        if (!response.body) throw new LlmError("STREAM_CLOSED");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        let data: string[] = [];
        const blocks: ({ index: number; type: "text" | "reasoning"; text: string } |
          { index: number; type: "tool-call"; providerIndex: number; id: string; name: string; arguments: string; argumentsSeen: boolean })[] = [];
        let reason: "stop" | "tool-calls" | "max-tokens" | undefined;
        let unsupportedReason = false;
        let usage: { inputTokens: number; outputTokens: number } | undefined;
        let done = false;
        try {
          while (!done) {
            checkBudget();
            let read: Awaited<ReturnType<typeof reader.read>>;
            try { read = await wait(reader.read()); } catch (error: unknown) { if (error instanceof LlmError) throw error; throw new LlmError("TRANSPORT", {}, { cause: error }); }
            check();
            pending += decoder.decode(read.value, { stream: !read.done });
            let lineEnd: number;
            while ((lineEnd = pending.indexOf("\n")) >= 0) {
              let line = pending.slice(0, lineEnd); pending = pending.slice(lineEnd + 1);
              if (line.endsWith("\r")) line = line.slice(0, -1);
              if (line === "") {
                if (!data.length) continue;
                const payload = data.join("\n"); data = [];
                if (payload === "[DONE]") { done = true; break; }
                let parsed: z.infer<typeof eventSchema>;
                try { parsed = eventSchema.parse(JSON.parse(payload)); } catch { throw new LlmError("PROTOCOL"); }
                const choice = parsed.choices?.[0];
                if (parsed.usage || choice?.delta !== undefined || choice?.finish_reason != null) {
                  phase = "idle"; remaining = request.timeouts.idleTimeoutMs;
                }
                for (const [type, text] of [["reasoning", choice?.delta?.reasoning_content], ["text", choice?.delta?.content]] as const) {
                  if (!text) continue;
                  let block = blocks.find((item) => item.type === type);
                  if (!block) {
                    block = { index: blocks.length, type, text: "" };
                    blocks.push(block);
                    yield { type: "block-start", index: block.index, blockType: type }; check();
                  }
                  if (block.type === "tool-call") throw new LlmError("PROTOCOL");
                  block.text += text;
                  yield { type: type === "text" ? "text-delta" : "reasoning-delta", index: block.index, text }; check();
                }
                for (const call of choice?.delta?.tool_calls ?? []) {
                  let block = blocks.find((item) => item.type === "tool-call" && item.providerIndex === call.index);
                  if (!block) {
                    block = { index: blocks.length, type: "tool-call", providerIndex: call.index, id: "", name: "", arguments: "", argumentsSeen: false };
                    blocks.push(block);
                    yield { type: "block-start", index: block.index, blockType: "tool-call" }; check();
                  }
                  if (block.type !== "tool-call") throw new LlmError("PROTOCOL");
                  if (call.id !== undefined) block.id += call.id;
                  if (call.function?.name !== undefined) block.name += call.function.name;
                  if (call.function?.arguments !== undefined) { block.arguments += call.function.arguments; block.argumentsSeen = true; }
                  yield { type: "tool-call-delta", index: block.index,
                    ...(call.id === undefined ? {} : { id: call.id }),
                    ...(call.function?.name === undefined ? {} : { name: call.function.name }),
                    argumentsDelta: call.function?.arguments ?? "" }; check();
                }
                if (choice?.finish_reason === "stop") reason = "stop";
                else if (choice?.finish_reason === "tool_calls") reason = "tool-calls";
                else if (choice?.finish_reason === "length") reason = "max-tokens";
                else if (choice?.finish_reason != null) unsupportedReason = true;
                if (parsed.usage) usage = { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens };
              } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
            }
            if (read.done && !done) throw new LlmError("STREAM_CLOSED");
          }
          check();
          for (const block of blocks) {
            check();
            if (block.type === "tool-call") {
              if (block.argumentsSeen) yield { type: "block-end", index: block.index, block: { type: "tool-call", id: block.id, name: block.name, arguments: block.arguments } };
            } else yield { type: "block-end", index: block.index, block: { type: block.type, text: block.text } };
          }
          check();
          if (usage) { yield { type: "usage", usage }; check(); }
          if (unsupportedReason) throw new LlmError("PROTOCOL");
          const tools = blocks.filter((block) => block.type === "tool-call");
          const inferred = tools.length && tools.every((block) => block.type === "tool-call" && block.id && block.name && block.argumentsSeen) ? "tool-calls" : "stop";
          check();
          yield { type: "finish", reason: { kind: reason ?? inferred } } satisfies StreamChunk;
        } finally {
          // 不合作的底层取消回调可能不兑现，不能让本地迭代清理无限等待。
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } finally {
        controller.abort();
        signal.removeEventListener("abort", abort);
      }

    },
  };
}
