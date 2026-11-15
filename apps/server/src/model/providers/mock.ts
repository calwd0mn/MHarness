import { setTimeout } from "node:timers/promises";
import { LlmError } from "../adapter.ts";
import type { AdapterChunk, ModelAdapter, ModelRequest } from "../adapter.ts";

/** 模拟脚本中的一次产出。delayMs 是本步产出前的等待时间，缺省时立即产出。 */
export type MockStep = Readonly<{ delayMs?: number }> & (
  | Readonly<{ chunk: AdapterChunk }>
  | Readonly<{ error: LlmError }>
);

/**
 * 创建进程内模拟 Adapter。脚本可以按实际请求选择文本、工具分片、usage 和结束事件，也可以抛出错误。
 * 首个事件和后续事件分别受请求等待、流空闲超时限制。取消会释放模拟等待。
 * @param script - 每次启动生成时执行一次，返回按交付顺序排列的步骤。
 * @returns 可注册到 LlmRuntime 的模拟 Adapter。
 */
export function createMockAdapter(script: (request: ModelRequest) => readonly MockStep[]): ModelAdapter {
  return {
    async *generate(request, signal) {
      if (signal.aborted) throw new LlmError("ABORTED");
      let timeoutPhase: "request" | "idle" = "request";
      for (const step of script(request)) {
        const timeoutMs = timeoutPhase === "request" ? request.timeouts.requestTimeoutMs : request.timeouts.idleTimeoutMs;
        const delayMs = step.delayMs ?? 0;
        if (delayMs > 0) {
          try {
            await setTimeout(Math.min(delayMs, timeoutMs), undefined, { signal });
          } catch (error: unknown) {
            if (signal.aborted) throw new LlmError("ABORTED");
            throw error;
          }
        }
        if (signal.aborted) throw new LlmError("ABORTED");
        if (delayMs >= timeoutMs) throw new LlmError("TIMEOUT", { timeoutPhase });
        if ("error" in step) throw step.error;

        yield step.chunk;
        if (step.chunk.type === "finish") return;
        timeoutPhase = "idle";
      }
    },
  };
}
