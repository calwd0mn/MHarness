import { sessionDirectoryFrameSchema, type SessionDirectoryFrame } from "@mharness/session/contracts";
import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import type { SessionDirectory } from "./directory.ts";

const maxPendingBytes = 1_048_576;

function encode(frame: SessionDirectoryFrame): string {
  return `data: ${JSON.stringify(sessionDirectoryFrameSchema.parse(frame))}\n\n`;
}

/**
 * 注册观察后发送就绪，再依序发送本连接捕获的实时帧。
 * @param directory - 当前实例的目录，仅使用实时观察，不查询存储。
 * @param signal - 取消本连接并释放观察。
 * @param reportError - 记录编码失败的服务端诊断。
 * @param onFailure - 积压溢出或编码失败时同步关闭传输；此回调不得等待生成器继续产出。
 * @returns 可用作 SSE 响应的消息；连接积压过大或编码失败时结束，客户端可重连。
 */
export async function* streamDirectoryEvents(
  directory: Pick<SessionDirectory, "onObservation">,
  signal: AbortSignal,
  reportError: (error: unknown) => void = console.error,
  onFailure?: () => void,
): AsyncGenerator<string> {
  if (signal.aborted) return;
  let frames: string[] = [];
  let pendingBytes = 0;
  let stopped = false;
  let heartbeat = false;
  let wake: (() => void) | undefined;
  const notify = () => wake?.();
  signal.addEventListener("abort", notify);
  const unsubscribe = directory.onObservation((frame) => {
    if (stopped || signal.aborted) return;
    try {
      const encoded = encode(frame);
      pendingBytes += Buffer.byteLength(encoded);
      if (pendingBytes > maxPendingBytes) stopped = true;
      else frames.push(encoded);
    } catch (error) {
      stopped = true;
      reportError(error);
    }
    notify();
    if (stopped) {
      frames = [];
      // 写侧背压会使生成器停在 yield，必须通知传输层主动断开。
      onFailure?.();
    }
  });
  const timer = setInterval(() => {
    heartbeat = true;
    notify();
  }, 15_000);
  timer.unref();
  try {
    if (signal.aborted) return;
    yield encode({ type: "api-session/ready" });
    while (!signal.aborted && !stopped) {
      if (frames.length) {
        const pending = frames;
        frames = [];
        for (const frame of pending) {
          if (signal.aborted || stopped) return;
          pendingBytes -= Buffer.byteLength(frame);
          yield frame;
        }
      } else if (heartbeat) {
        heartbeat = false;
        yield ": heartbeat\n\n";
      } else {
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    }
  } finally {
    clearInterval(timer);
    signal.removeEventListener("abort", notify);
    unsubscribe();
  }
}

/**
 * 装配独立目录 SSE 路由，应用关闭时终止尚在等待的连接。
 * @param app - 持有 HTTP 连接的应用。
 * @param path - 完整的目录 SSE 路径。
 * @param getDirectory - 在每次连接建立时提供已初始化的目录。
 */
export function registerDirectoryEvents(
  app: FastifyInstance,
  path: string,
  getDirectory: () => SessionDirectory,
): void {
  const connections = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const close of connections) close();
  });
  app.get(path, async (request, reply) => {
    const connection = new AbortController();
    const stream = Readable.from(streamDirectoryEvents(
      getDirectory(),
      connection.signal,
      (error) => request.log.error({ err: error }, "目录订阅失败"),
      () => close(),
    ));
    const release = () => {
      connections.delete(close);
      connection.abort();
    };
    const close = () => {
      release();
      stream.destroy();
      reply.raw.destroy();
    };
    connections.add(close);
    reply.raw.once("close", release);
    stream.once("close", release);
    return reply
      .header("Cache-Control", "no-cache")
      .type("text/event-stream; charset=utf-8")
      .send(stream);
  });
}
