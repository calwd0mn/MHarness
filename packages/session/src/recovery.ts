import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { snapshotSessionEvent, type SessionAppendInput, type SessionEvent } from "./events.ts";
import type { SessionHandle } from "./persistence.ts";
import { Session } from "./session.ts";
import { SessionToolCalls } from "./tool-calls.ts";

type Start = Extract<SessionEvent, { type: "compaction/start" }>;
type End = Extract<SessionEvent, { type: "compaction/end" }>;
type Summary = Extract<SessionEvent, { type: "compaction/summary" }>;
type Checkpoint = Extract<SessionEvent, { type: "user/message" }>;
type Run = Extract<SessionEvent, { type: "command/run" }>;
type Done = Extract<SessionEvent, { type: "command/done" }>;

/** 在线恢复可提供已核对的 live 前缀和已知终态；默认按进程中断修复。 */
export interface RecoveryOptions {
  /** 可靠持久前缀必须与该快照逐条一致，否则不生成或写入修复。 */
  readonly expectedLivePrefix?: readonly SessionEvent[];
  /** 仅在同身份的自有 start 已持久化且缺少 end 时使用。 */
  readonly terminalIntents?: readonly (Start["data"] & { readonly status: "failed" | "cancelled"; readonly reason: Extract<End["data"], { status: "failed" | "cancelled" | "interrupted" }>["reason"] })[];
}

function compactionClosers(events: readonly SessionEvent[], inherited: number, time: number, options?: RecoveryOptions): readonly SessionEvent[] {
  const starts: Start[] = [], runs: Run[] = [];
  const startsById = new Map<string, Start[]>(), endsById = new Map<string, End[]>(), summariesById = new Map<string, Summary[]>();
  const checkpointsById = new Map<string, Checkpoint[]>(), checkpointsByCommand = new Map<string, Checkpoint[]>();
  const startsByCommand = new Map<string, Start[]>(), endsByCommand = new Map<string, End[]>(), summariesByCommand = new Map<string, Summary[]>();
  const runsByCommand = new Map<string, Run[]>(), donesByCommand = new Map<string, Done[]>();
  const index = <T,>(map: Map<string, T[]>, id: string | undefined, event: T) => {
    if (id === undefined) return;
    const entries = map.get(id);
    if (entries) entries.push(event); else map.set(id, [event]);
  };
  for (const event of events) {
    switch (event.type) {
      case "command/run": runs.push(event); index(runsByCommand, event.data.commandId, event); break;
      case "command/done": index(donesByCommand, event.data.commandId, event); break;
      case "compaction/start": starts.push(event); index(startsById, event.data.compactionId, event); index(startsByCommand, event.data.sourceCommandId, event); break;
      case "compaction/end": index(endsById, event.data.compactionId, event); index(endsByCommand, event.data.sourceCommandId, event); break;
      case "compaction/summary": index(summariesById, event.data.compactionId, event); index(summariesByCommand, event.data.sourceCommandId, event); break;
      case "user/message":
        if (event.data.source.kind === "compact") {
          index(checkpointsById, event.data.source.compactionId, event);
          if ("sourceCommandId" in event.data) index(checkpointsByCommand, event.data.sourceCommandId, event);
        }
        break;
    }
  }
  const result: SessionEvent[] = [];
  const fail = (id: string, records: readonly SessionEvent[]): never => {
    const details = records.map(e => `${e.seq}:${e.type}${"compactionId" in e.data ? `:${e.data.compactionId}` : ""}${"sourceCommandId" in e.data ? `:${e.data.sourceCommandId}` : ""}`);
    throw new Error(`恢复关联冲突 ${id}: ${details.join(",")}`);
  };
  const append = (input: SessionAppendInput) => result.push(snapshotSessionEvent({ ...input, time }, events.length + result.length, "append"));
  const identity = (a: Start["data"], b: End["data"]) => a.compactionId === b.compactionId && a.turn === b.turn && a.sourceCommandId === b.sourceCommandId;
  const ownStarts = starts.filter(s => s.seq >= inherited);
  for (const map of [summariesById, checkpointsById]) {
    for (const [id, artifacts] of map) {
      if (!artifacts.some(event => event.seq >= inherited)) continue;
      const related = startsById.get(id) ?? [];
      if (related.length !== 1 || related[0]!.seq < inherited) fail(id, [...related, ...artifacts]);
    }
  }
  for (const start of ownStarts) {
    const sameStarts = startsById.get(start.data.compactionId) ?? [];
    const sameEnds = endsById.get(start.data.compactionId) ?? [];
    const sameSummaries = summariesById.get(start.data.compactionId) ?? [];
    if (sameStarts.length !== 1 || sameEnds.length > 1 || sameEnds.some(e => !identity(start.data, e.data) || e.seq <= start.seq)) fail(start.data.compactionId, [...sameStarts, ...sameEnds]);
    const checkpoints = checkpointsById.get(start.data.compactionId) ?? [];
    const end = sameEnds[0], summary = sameSummaries[0], checkpoint = checkpoints[0];
    if (end?.data.status === "succeeded") {
      const commandId = checkpoint && "sourceCommandId" in checkpoint.data ? checkpoint.data.sourceCommandId : undefined;
      if (sameSummaries.length !== 1 || checkpoints.length !== 1 || !summary || !checkpoint ||
        summary.data.sourceCommandId !== start.data.sourceCommandId || commandId !== start.data.sourceCommandId ||
        start.seq >= summary.seq || checkpoint.seq !== summary.seq + 1 || end.seq !== checkpoint.seq + 1 ||
        checkpoint.surfaceOp === "append" || checkpoint.surfaceOp.start !== summary.data.shadowedRange.start ||
        checkpoint.surfaceOp.end !== summary.data.shadowedRange.end ||
        !isDeepStrictEqual(checkpoint.sourceEventSeqs, [summary.seq, ...summary.data.shadowedSeqs]) ||
        summary.data.shadowedSeqs[0] !== summary.data.shadowedRange.start ||
        summary.data.shadowedSeqs.at(-1) !== summary.data.shadowedRange.end) {
        fail(start.data.compactionId, [start, ...sameSummaries, ...checkpoints, ...sameEnds]);
      }
    } else if (sameSummaries.length || checkpoints.length) {
      fail(start.data.compactionId, [start, ...sameSummaries, ...checkpoints, ...sameEnds]);
    }
  }
  const openRuns = runs.filter(r => r.seq >= inherited && !donesByCommand.has(r.data.commandId));
  const commandsToCheck = new Set(openRuns.map(run => run.data.commandId));
  for (const map of [startsByCommand, endsByCommand, summariesByCommand, checkpointsByCommand]) {
    for (const [id, related] of map) {
      if (related.some(event => event.seq >= inherited)) commandsToCheck.add(id);
    }
  }
  for (const id of commandsToCheck) {
    const rs = runsByCommand.get(id) ?? [];
    const ss = startsByCommand.get(id) ?? [];
    const es = endsByCommand.get(id) ?? [];
    const ms = summariesByCommand.get(id) ?? [];
    const cs = checkpointsByCommand.get(id) ?? [];
    const records = [...rs, ...ss, ...es, ...ms, ...cs];
    if (rs.length !== 1 || ss.length > 1 || es.length > 1 || ms.length > 1 || cs.length > 1) fail(id, records);
    const run = rs[0]!, s = ss[0], e = es[0], m = ms[0];
    if ((!s && (e || m || cs.length > 0)) ||
      cs.some(checkpoint => checkpoint.data.source.kind !== "compact" || checkpoint.data.source.compactionId !== s?.data.compactionId) ||
      (s && ((run.seq >= inherited && s.seq < inherited) || s.seq <= run.seq)) ||
      (e && (!s || !identity(s.data, e.data) || e.seq <= s.seq)) ||
      (m && (!s || m.data.compactionId !== s.data.compactionId || m.seq <= s.seq || (e && m.seq >= e.seq))) ||
      (e?.data.status === "succeeded" && !m)) fail(id, records);
    const dones = donesByCommand.get(id) ?? [];
    if (s && dones.some(done => !e || done.seq <= e.seq)) fail(id, [...records, ...dones]);
  }
  for (const s of ownStarts) {
    if (endsById.has(s.data.compactionId)) continue;
    const intents = options?.terminalIntents?.filter(i => i.compactionId === s.data.compactionId) ?? [];
    if (intents.length > 1 || intents.some(i => !identity(s.data, i))) fail(s.data.compactionId, [s]);
    const intent = intents[0];
    append({ type: "compaction/end", data: { ...s.data, status: intent?.status ?? "interrupted", reason: intent?.reason ?? { kind: "process_interrupted" } } });
  }
  for (const event of result) if (event.type === "compaction/end") index(endsById, event.data.compactionId, event);
  for (const run of openRuns) {
    const s = startsByCommand.get(run.data.commandId)?.[0];
    const end = s && endsById.get(s.data.compactionId)?.[0];
    const summary = s && summariesById.get(s.data.compactionId)?.[0];
    if (end?.data.status === "succeeded" && summary) append({ type: "command/done", data: { commandId: run.data.commandId, kind: "success", sourceEventSeq: summary.seq } });
    else append({ type: "command/done", data: { commandId: run.data.commandId, kind: "error", text: end?.data.status === "failed" ? "压缩失败" : end?.data.status === "cancelled" ? "压缩已取消" : "进程中断" } });
  }
  return result;
}

function recoveryClosers(events: readonly SessionEvent[], inherited: number, options?: RecoveryOptions): readonly SessionEvent[] {
  if (options?.expectedLivePrefix && !isDeepStrictEqual(events, options.expectedLivePrefix)) throw new Error("恢复持久前缀与 live 不一致");
  const time = Date.now();
  const compact = compactionClosers(events, inherited, time, options);
  const old = interruptedTurnClosers(events, time);
  return [...compact, ...old.map((event, index) => snapshotSessionEvent({ ...event, seq: events.length + compact.length + index }, events.length + compact.length + index, "replay"))];
}

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
 * @param options - 可选的可靠前缀和进程内终态意图。
 * @returns 包含临时修复事件的 Session；真实游标仍为读取前缀的末尾。
 * @throws 前缀读取失败，或压缩、命令与其他事件的关联无法可靠确定时拒绝。
 */
export async function projectInterruptedSession(handle: SessionHandle, options?: RecoveryOptions): Promise<{ session: Session; cursor: number }> {
  const events = await handle.read();
  const session = new Session(handle.header, { seed: { kind: "restore", events, inheritedEventCount: handle.inheritedEventCount } });
  const closers = recoveryClosers(events, handle.inheritedEventCount, options);
  for (const event of closers) {
    const { seq: _seq, ...input } = event;
    if (input.type !== "session/end-seed") session.append(input);
  }
  return { session, cursor: events.length - 1 };
}

/**
 * 使用调用方持有的写句柄读取真实前缀并原子提交一次中断修复；不关闭句柄。
 * @param handle - 已取得写入权的会话句柄。
 * @param options - 可选的可靠前缀和进程内终态意图。
 * @returns 新提交的修复事件；无需修复时为空。
 * @throws 读取失败、事件关联无法可靠确定或原子追加失败时拒绝；调用方仍负责关闭句柄。
 */
export async function recoverInterruptedSession(handle: SessionHandle, options?: RecoveryOptions): Promise<readonly SessionEvent[]> {
  if (handle.access !== "write") throw new Error("恢复需要写入权");
  const events = await handle.read();
  new Session(handle.header, { seed: { kind: "restore", events, inheritedEventCount: handle.inheritedEventCount } });
  const closers = recoveryClosers(events, handle.inheritedEventCount, options);
  if (closers.length) await handle.append(closers);
  return closers;
}
