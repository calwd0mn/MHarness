import { snapshotSessionEvent, type SessionAppendInput, type SessionEvent } from "./events.ts";
import { Session } from "./session.ts";

const route = { provider: "mock", model: "fixture" } as const;
const opening = "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>";

function user(turn: number): SessionAppendInput {
  return { type: "user/message", surfaceOp: "append", data: { id: `user-${turn}`, role: "user", source: { kind: "user" }, turn, requestId: `request-${turn}`, content: [{ type: "text", text: "用户请求 ".repeat(150) }] } };
}

function assistant(turn: number, step: number): SessionAppendInput {
  const text = "助手回答 ".repeat(150);
  const block = { type: "text", text } as const;
  return { type: "assistant/message", surfaceOp: "append", data: { turn, step, message: { id: `assistant-${turn}`, role: "assistant", source: route, content: [block] }, finishReason: { kind: "stop" }, includeInModelContext: true, stream: [
    { time: 0, chunk: { type: "block-start", index: 0, blockType: "text" } },
    { time: 1, chunk: { type: "text-delta", index: 0, text } },
    { time: 2, chunk: { type: "block-end", index: 0, block } },
    { time: 3, chunk: { type: "finish", reason: { kind: "stop" } } },
  ] } };
}

function closedTurn(withTool = false): SessionAppendInput[] {
  return [
    { type: "turn/start", data: { turn: 1 } }, user(1),
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "request/header", data: { reason: "initial", header: { config: route, ...(withTool ? { tools: [{ name: "lookup", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }] } : {}) } } },
    assistant(1, 1), { type: "step/end", data: { turn: 1, step: 1 } },
    { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ];
}

function build(inputs: readonly SessionAppendInput[]): readonly SessionEvent[] {
  return Object.freeze(inputs.map((input, seq) => snapshotSessionEvent({ ...input, time: 1000 + seq }, seq, "append")));
}

function run(commandId: string): SessionAppendInput {
  return { type: "command/run", data: { commandId, name: "compact", source: { kind: "user" } } };
}

function done(commandId: string): SessionAppendInput {
  return { type: "command/done", data: { commandId, kind: "error", text: "busy" } };
}

function input(id: string, events: readonly SessionAppendInput[]) {
  return { header: { sessionId: id, createdAt: 1000 }, inheritedEventCount: 0, events: build(events) };
}

/**
 * 创建可重复恢复的压缩历史输入；每次调用返回独立且冻结的事件数组。
 * @returns 按场景命名的会话元数据、只读的已提交前缀与继承边界。
 */
export function makeCompactionRecoveryFixtures() {
  const prefix = closedTurn();
  const independentInterrupted = input("I", [...prefix, run("I"), { type: "compaction/start", data: { compactionId: "I1", turn: null, sourceCommandId: "I" } }]);
  const preStepInterrupted = input("P", [...prefix, { type: "turn/start", data: { turn: 2 } }, user(2), { type: "compaction/start", data: { compactionId: "P1", turn: 2 } }]);
  const sSummary = { type: "compaction/summary", data: { compactionId: "S1", summary: "摘要", shadowedRange: { start: 1, end: 4 }, shadowedSeqs: [1, 4], route } } satisfies SessionAppendInput;
  const sInputs: SessionAppendInput[] = [...prefix,
      { type: "turn/start", data: { turn: 2 } }, user(2),
      { type: "compaction/start", data: { compactionId: "S1", turn: 2 } },
      sSummary,
  ];
  sInputs.push(
      { type: "user/message", surfaceOp: { op: "replace", start: 1, end: 4 }, sourceEventSeqs: [sInputs.indexOf(sSummary), sInputs.indexOf(prefix[1]!), sInputs.indexOf(prefix[4]!)], data: { id: "checkpoint-S1", role: "user", source: { kind: "compact", compactionId: "S1" }, content: [{ type: "text", text: opening }, { type: "text", text: "摘要" }, { type: "text", text: "</compacted-summary>" }] } },
      { type: "compaction/end", data: { compactionId: "S1", turn: 2, status: "succeeded" } },
      { type: "compaction/start", data: { compactionId: "S2", turn: 2 } },
  );
  const secondSummaryInterrupted = input("S", sInputs);
  const toolBlock = { type: "tool-call", id: "call-R", name: "lookup", arguments: '{"query":"fixture"}' } as const;
  const failure = { code: "CONTEXT_WINDOW_EXCEEDED", message: "context window exceeded" } as const;
  const result = { turn: 2, step: 1, operationId: "operation-R", meta: { visible: true }, message: {
    id: "result-R", role: "user", source: { kind: "tool", callId: "call-R" },
    content: [{ type: "tool-result", toolCallId: "call-R", isError: false, content: [{ type: "text", text: "H".repeat(4096) + "M".repeat(3073) + "T".repeat(1024) }] }],
  } } as const;
  const pruned = { ...result, message: { ...result.message, content: [{ ...result.message.content[0], content: [{ type: "text", text: "H".repeat(4096) + "\n\n[... tool result middle pruned ...]\n\n" + "T".repeat(1024) }] }] } } as const;
  const rInputs: SessionAppendInput[] = [...closedTurn(true),
    { type: "turn/start", data: { turn: 2 } }, user(2), { type: "step/start", data: { turn: 2, step: 1 } },
    { type: "assistant/message", surfaceOp: "append", data: { turn: 2, step: 1, message: { id: "assistant-tool-R", role: "assistant", source: route, content: [toolBlock] }, finishReason: { kind: "tool_calls" }, includeInModelContext: true, stream: [
      { time: 0, chunk: { type: "block-start", index: 0, blockType: "tool-call" } },
      { time: 1, chunk: { type: "tool-call-delta", index: 0, id: toolBlock.id, name: toolBlock.name, argumentsDelta: toolBlock.arguments } },
      { time: 2, chunk: { type: "block-end", index: 0, block: toolBlock } },
      { time: 3, chunk: { type: "finish", reason: { kind: "tool-calls" } } },
    ] } },
  ];
  const dispatch = { type: "tool/call", data: { turn: 2, step: 1, callId: toolBlock.id, name: toolBlock.name, arguments: toolBlock.arguments } } satisfies SessionAppendInput;
  rInputs.push(dispatch,
    { type: "tool/operation", data: { turn: 2, step: 1, callId: toolBlock.id, operationId: "operation-R", toolName: "lookup", toolVersion: "1", validatedArgs: { query: "fixture" } } },
  );
  const original = { type: "tool/result", surfaceOp: "append", sourceEventSeqs: [rInputs.indexOf(dispatch)], data: result } satisfies SessionAppendInput;
  rInputs.push(original);
  rInputs.push(
    { type: "step/end", data: { turn: 2, step: 1 } }, { type: "step/start", data: { turn: 2, step: 2 } },
    { type: "assistant/attempt", data: { turn: 2, step: 2, outcome: "failed", reason: failure, includeInModelContext: false, stream: [{ time: 0, chunk: { type: "finish", reason: { kind: "error", failure } } }] } },
    { type: "compaction/prune", data: { shadowedSeq: 13, beforeTokens: 2061 } },
    { type: "tool/result", surfaceOp: { op: "replace", start: 13, end: 13 }, sourceEventSeqs: [rInputs.indexOf(original)], data: pruned },
    { type: "compaction/start", data: { compactionId: "R1", turn: 2 } },
  );
  const prunedInterrupted = input("R", rInputs);
  const settled = (status: "succeeded" | "failed" | "cancelled") => {
    const commandId = `K-${status}`;
    const compactionId = `K1-${status}`;
    const start = { type: "compaction/start", data: { compactionId, sourceCommandId: commandId, turn: null } } satisfies SessionAppendInput;
    const summary = { type: "compaction/summary", data: { compactionId, sourceCommandId: commandId, summary: "摘要", shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], route } } satisfies SessionAppendInput;
    const kInputs: SessionAppendInput[] = [...prefix, run(commandId), start];
    if (status === "succeeded") {
      kInputs.push(summary);
      kInputs.push(
        { type: "user/message", surfaceOp: { op: "replace", start: 1, end: 1 }, sourceEventSeqs: [kInputs.indexOf(summary), kInputs.indexOf(prefix[1]!)], data: { id: "checkpoint-K", role: "user", source: { kind: "compact", compactionId }, sourceCommandId: commandId, content: [{ type: "text", text: opening }, { type: "text", text: "摘要" }, { type: "text", text: "</compacted-summary>" }] } },
        { type: "compaction/end", data: { compactionId, sourceCommandId: commandId, turn: null, status } },
      );
    } else {
      kInputs.push({ type: "compaction/end", data: { compactionId, sourceCommandId: commandId, turn: null, status, reason: { kind: status, message: `fixture ${status}` } } });
    }
    return input(commandId, kInputs);
  };
  const settledWithoutDone = { succeeded: settled("succeeded"), failed: settled("failed"), cancelled: settled("cancelled") };
  const roundGapRunOnly = input("G", [...prefix, run("G2"), done("G2"), run("G1")]);
  const crossTurnBusy = input("B", [...prefix.slice(0, 6), run("B"), prefix[6]!,
    { type: "turn/start", data: { turn: 2 } }, user(2), done("B"),
    { type: "step/start", data: { turn: 2, step: 1 } }, assistant(2, 1),
    { type: "step/end", data: { turn: 2, step: 1 } }, { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } },
  ]);
  const childHeader = { sessionId: "O", createdAt: 2000, isSeeded: true, parentSession: roundGapRunOnly.header.sessionId } as const;
  const child = new Session(childHeader, { seed: { kind: "fork", events: roundGapRunOnly.events.slice(0, 10) } });
  child.append({ ...run("O"), time: 2011 });
  const inheritedEvents: readonly SessionEvent[] = Object.freeze(child.snapshot().events);
  const inheritedOwnership = { header: childHeader, inheritedEventCount: child.inheritedEventCount, events: inheritedEvents };
  return { independentInterrupted, preStepInterrupted, prunedInterrupted, secondSummaryInterrupted, settledWithoutDone, roundGapRunOnly, crossTurnBusy, inheritedOwnership };
}
