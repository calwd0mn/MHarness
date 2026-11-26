import type { SessionEvent } from "./events.ts";

/** 会话事件前缀上的目录投影。 */
export interface ListProjection {
  readonly blank: boolean;
  readonly lastPromptAt: number | null;
}

/** 将事件应用到目录投影，真实用户消息时间保持单调。 */
export function projectListMetadata(current: ListProjection, event: SessionEvent): ListProjection {
  return {
    blank: current.blank && event.type !== "turn/start",
    lastPromptAt: event.type === "user/message" && event.data.source.kind === "user"
      ? Math.max(current.lastPromptAt ?? 0, event.time) : current.lastPromptAt,
  };
}
