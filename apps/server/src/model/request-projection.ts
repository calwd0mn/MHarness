import type { Session } from "@mharness/session/server";
import type { ModelMessage } from "./adapter.ts";

/** 当前 surface 的不可变消息；引用属于 Session。 */
export type SurfaceMessage = ReturnType<Session["deriveMessages"]>[number];

/** 保留原内容块引用和工具关联的模型可见投影。 */
export type SurfaceProjection =
  | { role: "assistant"; content: Extract<SurfaceMessage, { role: "assistant" }>["content"] }
  | { role: "tool"; callId: string; content: Extract<SurfaceMessage, { role: "user" }>["content"] }
  | { role: "user"; content: Extract<SurfaceMessage, { role: "user" }>["content"] };

/** 按消息角色保留模型可见块；内容仍由 Session 持有。
 * @param message - 当前 surface 消息。
 * @returns 保留原块顺序和工具关联的投影。
 */
export function projectSurfaceMessage(message: SurfaceMessage): SurfaceProjection {
  if (message.role === "assistant") return { role: "assistant", content: message.content };
  if (message.source.kind === "tool") return { role: "tool", callId: message.source.callId, content: message.content };
  return { role: "user", content: message.content };
}

/** 将当前 surface 消息投影为模型输入；返回新数组并保留工具结果 JSON。
 * @param messages - 按 surface 顺序排列的消息。
 * @returns 可供 Adapter 发送的消息。
 */
export function projectModelMessages(messages: readonly SurfaceMessage[]): ModelMessage[] {
  return messages.map(projectSurfaceMessage).map((message): ModelMessage => {
    if (message.role === "assistant") {
      const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      const reasoningBlocks = message.content.filter((block) => block.type === "reasoning");
      const reasoning = reasoningBlocks.map((block) => block.text).join("");
      const toolCalls = message.content.filter((block) => block.type === "tool-call")
        .map((block) => ({ callId: block.id, name: block.name, arguments: block.arguments }));
      return { role: "assistant", text, ...(reasoningBlocks.length ? { reasoning } : {}), ...(toolCalls.length ? { toolCalls } : {}) };
    }
    if (message.role === "tool") return {
      role: "tool", callId: message.callId,
      text: JSON.stringify(message.content.find((block) => block.type === "tool-result")?.content),
    };
    return { role: "user", text: message.content.filter((block) => block.type === "text").map((block) => block.text).join("") };
  });
}
