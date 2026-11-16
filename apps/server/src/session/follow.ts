import { followFrameSchema, type FollowFrame, type RawSessionHistory } from "@mharness/session/contracts";
import type { AgentManager } from "../agent/manager.ts";
import type { ReActAgent } from "../agent/react-agent.ts";

type IncrementalFrame = Exclude<FollowFrame, { type: "snapshot" | "error" }>;

type Snapshot = Extract<FollowFrame, { type: "snapshot" }>;
const maxPendingBytes = 1_048_576;

function syncError(message: string, details: { expectedSeq: number; actualSeq: number } | Record<string, never> = {}): FollowFrame {
  return { type: "error", error: { code: "follow_sync_failed", message, details } };
}

function sse(frame: FollowFrame): string {
  return `data: ${JSON.stringify(followFrameSchema.parse(frame))}\n\n`;
}

/**
 * 以完整快照开始观察会话，并依序发送截点之后的帧。
 * @param agents - 当前在线实例的 Agent 注册表，用于首次加载时交接订阅。
 * @param read - 读取已提交历史的入口，仅在 Agent 尚未加载时调用。
 * @param sessionId - 订阅对应的会话。
 * @param signal - 停止本连接及释放观察，不取消会话中的执行。
 * @param reportError - 记录快照读取或订阅故障的服务端诊断。
 * @returns SSE 数据，快照失败或检测到缺号时发出终止错误后关闭。
 */
export async function* followSession(
  agents: Pick<AgentManager, "get" | "onLoaded">,
  read: () => Promise<RawSessionHistory | undefined>,
  sessionId: string,
  signal: AbortSignal,
  reportError: (error: unknown) => void = console.error,
): AsyncGenerator<string> {
  if (signal.aborted) return;
  let frames: IncrementalFrame[] = [];
  let wake: (() => void) | undefined;
  let heartbeat = false;
  let pendingBytes = 0;
  let overflowed = false;
  let agent: ReActAgent | undefined;
  let unsubscribe: (() => void) | undefined;
  const notify = () => wake?.();
  const connect = (next: ReActAgent) => {
    if (next.session.header.sessionId !== sessionId || agent) return;
    agent = next;
    unsubscribe = next.onObservation((frame) => {
      if (overflowed) return;
      pendingBytes += Buffer.byteLength(JSON.stringify(frame));
      // 网络背压不能阻塞 Turn；超出连接窗口后让客户端从完整快照恢复。
      if (pendingBytes > maxPendingBytes) {
        overflowed = true;
        frames = [];
        notify();
        return;
      }
      frames.push(frame);
      notify();
    });
  };
  // 持久读取可能跨过首次加载，提前注册才能观察加载后的首批事件。
  const offLoaded = agents.onLoaded(connect);
  signal.addEventListener("abort", notify);
  const timer = setInterval(() => {
    heartbeat = true;
    notify();
  }, 15_000);
  timer.unref();
  try {
    let snapshot: Snapshot;
    let initial: string;
    try {
      const loaded = agents.get(sessionId);
      if (loaded) connect(loaded);
      const persisted = agent ? undefined : await read();
      if (signal.aborted) return;
      if (agent) {
        snapshot = { type: "snapshot", ...agent.snapshot() };
        // 同步截点已经包含在读取持久历史期间积累的帧。
        frames = [];
        pendingBytes = 0;
        overflowed = false;
      } else if (persisted) {
        snapshot = { type: "snapshot", ...persisted, records: [...persisted.records], assistantStream: { revision: 0 } };
      } else {
        throw new Error("会话不可见");
      }
      initial = sse(snapshot);
    } catch (error: unknown) {
      reportError(error);
      if (!signal.aborted) yield sse(syncError("无法读取会话快照"));
      return;
    }
    yield initial;
    let cursor = snapshot.cursor;
    while (!signal.aborted) {
      if (overflowed) {
        yield sse(syncError("客户端读取过慢，请重新同步"));
        return;
      }
      if (frames.length === 0) {
        if (heartbeat) {
          heartbeat = false;
          yield ": heartbeat\n\n";
        } else {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = undefined;
        }
        continue;
      }
      const pending = frames;
      frames = [];
      pendingBytes = 0;
      for (const frame of pending) {
        if (signal.aborted) return;
        if (overflowed) {
          yield sse(syncError("客户端读取过慢，请重新同步"));
          return;
        }
        if (frame.type === "event") {
          if (frame.event.seq <= cursor) continue;
          if (frame.event.seq !== cursor + 1) {
            yield sse(syncError("会话事件不连续", { expectedSeq: cursor + 1, actualSeq: frame.event.seq }));
            return;
          }
          cursor = frame.event.seq;
        }
        yield sse(frame);
      }
    }
  } finally {
    clearInterval(timer);
    signal.removeEventListener("abort", notify);
    offLoaded();
    unsubscribe?.();
  }
}
