import { randomUUID } from "node:crypto";
import { snapshotSessionEvent, type SessionAppendInput, type SessionEvent } from "./events.ts";
import type { SessionHandle } from "./persistence.ts";
import { Session } from "./session.ts";
import { SessionToolCalls } from "./tool-calls.ts";

/**
 * 校验持久前缀中的调用关联，并计算一次中断修复批次；不执行模型或工具。
 * @param events - 从零连续排列的已提交事件。
 * @param time - 修复事件使用的 Unix 毫秒，默认取当前时间。
 * @returns 从前缀末尾开始编号的修复事件；无需修复时为空。
 * @throws 事件无效、范围冲突或工具声明、调度、操作及结果的关联不匹配时抛出。
 */
export function interruptedTurnClosers(events: readonly SessionEvent[], time = Date.now()): readonly SessionEvent[] {
  const calls = new SessionToolCalls();
  let turn: number | undefined;
  let step: number | undefined;
  for (const [seq, raw] of events.entries()) {
    const event = snapshotSessionEvent(raw, seq, "replay");
    calls.prepare(event)?.();
    switch (event.type) {
      case "turn/start":
        if (turn !== undefined) throw new Error("Turn 范围重叠");
        turn = event.data.turn; break;
      case "turn/end":
        if (turn !== event.data.turn || step !== undefined) throw new Error("Turn 终态不匹配");
        turn = undefined; break;
      case "step/start":
        if (turn !== event.data.turn || step !== undefined) throw new Error("Step 范围无效");
        step = event.data.step; break;
      case "step/end":
        if (turn !== event.data.turn || step !== event.data.step) throw new Error("Step 终态不匹配");
        step = undefined; break;
    }
  }
  const result: SessionEvent[] = [];
  const append = (input: SessionAppendInput) => result.push(snapshotSessionEvent({ ...input, time }, events.length + result.length, "append"));
  if (turn !== undefined) {
    for (const entry of calls.unsettled(turn)) {
      const scheduled = entry.callSeq !== undefined;
      const code = scheduled ? "TOOL_OUTCOME_UNKNOWN" : "TOOL_NOT_STARTED";
      append({ type: "tool/result", surfaceOp: "append", sourceEventSeqs: [entry.callSeq ?? entry.assistantSeq], data: {
        turn, step: entry.step, ...(entry.operationId === undefined ? {} : { operationId: entry.operationId }),
        message: { id: randomUUID(), role: "user", source: { kind: "tool", callId: entry.callId }, content: [{
          type: "tool-result", toolCallId: entry.callId, isError: true, content: [{ type: "text", text: scheduled ? "进程中断，工具结果未确认" : "进程中断，工具尚未派发" }],
        }] }, error: { name: "ToolError", code },
      } });
    }
  }
  if (turn !== undefined && step !== undefined) append({ type: "step/end", data: { turn, step } });
  if (turn !== undefined) append({ type: "turn/end", data: { turn, reason: { kind: "interrupted" } } });
  return result;
}

/**
 * 从已提交前缀构建隔离的中断视图，不改变句柄或持久游标。
 * @param handle - 用于读取已提交前缀的句柄，调用方负责关闭。
 * @returns 包含临时修复事件的 Session；真实游标仍为读取前缀的末尾。
 * @throws 前缀读取或语义校验失败时拒绝。
 */
export async function projectInterruptedSession(handle: SessionHandle): Promise<{ session: Session; cursor: number }> {
  const events = await handle.read();
  const session = new Session(handle.header, { seed: { kind: "restore", events, inheritedEventCount: handle.inheritedEventCount } });
  const closers = interruptedTurnClosers(events);
  for (const event of closers) {
    const { seq: _seq, ...input } = event;
    if (input.type !== "session/end-seed") session.append(input);
  }
  return { session, cursor: events.length - 1 };
}

/**
 * 使用调用方持有的写句柄读取真实前缀并原子提交一次中断修复；不关闭句柄。
 * @param handle - 已取得写入权的会话句柄。
 * @returns 新提交的修复事件；无需修复时为空。
 * @throws 读取、语义校验或原子追加失败时拒绝。
 */
export async function recoverInterruptedSession(handle: SessionHandle): Promise<readonly SessionEvent[]> {
  if (handle.access !== "write") throw new Error("恢复需要写入权");
  const events = await handle.read();
  new Session(handle.header, { seed: { kind: "restore", events, inheritedEventCount: handle.inheritedEventCount } });
  const closers = interruptedTurnClosers(events);
  if (closers.length) await handle.append(closers);
  return closers;
}
