import { z } from "zod";
import { LlmError, type ModelAdapter, type ModelMessage, type StreamChunk } from "../adapter.ts";

const eventSchema = z.object({
  choices: z.array(z.object({ delta: z.object({ content: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional(), tool_calls: z.array(z.object({ index: z.number().int().nonnegative(), id: z.string().optional(), function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional() })).optional() }).optional(),
    finish_reason: z.string().nullable().optional() })).optional(),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).nullable().optional(),
});

function messageBody(message: ModelMessage, includeReasoning: boolean) {
  if (message.role === "user") return { role: "user", content: message.text };
  if (message.role === "tool") return { role: "tool", tool_call_id: message.callId, content: message.text };
  return { role: "assistant", content: message.text,
    ...(includeReasoning ? { reasoning_content: message.reasoning ?? "" } : {}),
    ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({ id: call.callId, type: "function",
      function: { name: call.name, arguments: call.arguments } })) } : {}) };
}

/** DeepSeek 单次请求的连接配置；凭据不会进入可记录模型路由。 */
export type DeepSeekOptions = Readonly<{ apiKey: string; fetch?: typeof fetch }>;

/**
 * 创建绑定连接凭据的 DeepSeek Chat Completions Adapter。
 * 不支持的显式结束原因在收到 DONE 后以 PROTOCOL 失败，不推断成功或调用方取消。
 * @param options - 请求凭据与可选的受控传输，未提供时使用全局 fetch。
 * @returns 可注册到 Runtime 的单次请求 Adapter。
 */
export function createDeepSeekAdapter(options: DeepSeekOptions): ModelAdapter {
  const apiKey = options.apiKey;
  const transport = options.fetch ?? globalThis.fetch;
  return {
    modelInfo: { defaultReasoningEffort: "none", supportedReasoningEfforts: ["none", "low", "high", "max"] },
    validateParams(params) {
      if (params.reasoningEffort !== "none" && (params.temperature !== undefined || params.topP !== undefined)) throw new RangeError("推理模式不支持采样参数");
      if (params.maxOutputTokens !== undefined && params.maxOutputTokens > 393216) throw new RangeError("maxOutputTokens 超出模型限制");
      if (params.stop && (params.stop.length > 16 || params.stop.some((value) => new TextEncoder().encode(value).length > 512))) throw new RangeError("stop 超出模型限制");
    },
    async *generate(request, signal) {
      let response: Response;
      try {
        response = await transport("https://api.deepseek.com/chat/completions", {
          method: "POST", redirect: "error", signal,
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: request.route.model, stream: true,
            messages: [{ role: "system", content: request.systemPrompt }, ...request.messages.map((message) => messageBody(message, request.effectiveParams.reasoningEffort !== "none" && request.tools.length > 0))],
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
        });
      } catch (error: unknown) { throw new LlmError(signal.aborted ? "ABORTED" : "TRANSPORT", {}, { cause: error }); }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new LlmError("TRANSPORT", { httpStatus: response.status });
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
          const read = await reader.read();
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
              for (const [type, text] of [["reasoning", choice?.delta?.reasoning_content], ["text", choice?.delta?.content]] as const) {
                if (!text) continue;
                let block = blocks.find((item) => item.type === type);
                if (!block) {
                  block = { index: blocks.length, type, text: "" };
                  blocks.push(block);
                  yield { type: "block-start", index: block.index, blockType: type };
                }
                if (block.type === "tool-call") throw new LlmError("PROTOCOL");
                block.text += text;
                yield { type: type === "text" ? "text-delta" : "reasoning-delta", index: block.index, text };
              }
              for (const call of choice?.delta?.tool_calls ?? []) {
                let block = blocks.find((item) => item.type === "tool-call" && item.providerIndex === call.index);
                if (!block) {
                  block = { index: blocks.length, type: "tool-call", providerIndex: call.index, id: "", name: "", arguments: "", argumentsSeen: false };
                  blocks.push(block);
                  yield { type: "block-start", index: block.index, blockType: "tool-call" };
                }
                if (block.type !== "tool-call") throw new LlmError("PROTOCOL");
                if (call.id !== undefined) block.id += call.id;
                if (call.function?.name !== undefined) block.name += call.function.name;
                if (call.function?.arguments !== undefined) { block.arguments += call.function.arguments; block.argumentsSeen = true; }
                yield { type: "tool-call-delta", index: block.index,
                  ...(call.id === undefined ? {} : { id: call.id }),
                  ...(call.function?.name === undefined ? {} : { name: call.function.name }),
                  argumentsDelta: call.function?.arguments ?? "" };
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
        for (const block of blocks) {
          if (block.type === "tool-call") {
            if (block.argumentsSeen) yield { type: "block-end", index: block.index, block: { type: "tool-call", id: block.id, name: block.name, arguments: block.arguments } };
          } else yield { type: "block-end", index: block.index, block: { type: block.type, text: block.text } };
        }
        if (usage) yield { type: "usage", usage };
        if (unsupportedReason) throw new LlmError("PROTOCOL");
        const tools = blocks.filter((block) => block.type === "tool-call");
        const inferred = tools.length && tools.every((block) => block.type === "tool-call" && block.id && block.name && block.argumentsSeen) ? "tool-calls" : "stop";
        yield { type: "finish", reason: { kind: reason ?? inferred } } satisfies StreamChunk;
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}
