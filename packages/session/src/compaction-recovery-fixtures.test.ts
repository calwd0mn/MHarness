import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCompactionRecoveryFixtures } from "./compaction-recovery-fixtures.ts";
import { Session, type SessionHeader } from "./session.ts";
import type { SessionEvent } from "./events.ts";
import { SqliteSessionPersistence } from "./storage/sqlite-persistence.ts";

type Input = { readonly header: SessionHeader; readonly events: readonly SessionEvent[]; readonly inheritedEventCount: number };
function restore(input: Input): Session {
  return new Session(input.header, { seed: { kind: "restore", events: input.events, inheritedEventCount: input.inheritedEventCount } });
}
function event<Type extends SessionEvent["type"]>(input: Input, seq: number, type: Type): Extract<SessionEvent, { type: Type }> {
  const value = input.events[seq];
  assert.ok(value);
  assert.equal(value.type, type);
  return value as Extract<SessionEvent, { type: Type }>;
}
function types(input: Input): string[] { return input.events.map((value) => value.type); }
const originalText = "H".repeat(4096) + "M".repeat(3073) + "T".repeat(1024);
const prunedText = "H".repeat(4096) + "\n\n[... tool result middle pruned ...]\n\n" + "T".repeat(1024);
function assertModelToolContent(session: Session, text: string): void {
  const message = session.deriveMessages().find((item) => item.id === "result-R");
  assert.ok(message);
  assert.deepEqual(message.content, [{ type: "tool-result", toolCallId: "call-R", isError: false, content: [{ type: "text", text }] }]);
}

test("所有历史前缀以原始事件和确定的模型视图重复恢复", () => {
  const f = makeCompactionRecoveryFixtures();
  const cases: readonly [Input, number[], string[], number][] = [
    [f.independentInterrupted, [1, 4], ["user-1", "assistant-1"], 0],
    [f.preStepInterrupted, [1, 4, 8], ["user-1", "assistant-1", "user-2"], 0],
    [f.prunedInterrupted, [1, 4, 8, 10, 18], ["user-1", "assistant-1", "user-2", "assistant-tool-R", "result-R"], 1],
    [f.secondSummaryInterrupted, [11, 8], ["checkpoint-S1", "user-2"], 1],
    [f.settledWithoutDone.succeeded, [10, 4], ["checkpoint-K", "assistant-1"], 1],
    [f.settledWithoutDone.failed, [1, 4], ["user-1", "assistant-1"], 0],
    [f.settledWithoutDone.cancelled, [1, 4], ["user-1", "assistant-1"], 0],
    [f.roundGapRunOnly, [1, 4], ["user-1", "assistant-1"], 0],
    [f.crossTurnBusy, [1, 4, 9, 12], ["user-1", "assistant-1", "user-2", "assistant-2"], 0],
    [f.inheritedOwnership, [1, 4], ["user-1", "assistant-1"], 0],
  ];
  for (const [input, surface, ids, generation] of cases) {
    assert.deepEqual(input.events.map((e) => e.seq), input.events.map((_, index) => index));
    for (let iteration = 0; iteration < 2; iteration++) {
      const session = restore(input);
      assert.deepEqual(session.header, input.header);
      assert.deepEqual(session.snapshot(), { events: input.events, cursor: input.events.length - 1 });
      assert.deepEqual(session.deriveSurfaceNodes().map((node) => node.seq), surface);
      assert.deepEqual(session.deriveMessages().map((message) => message.id), ids);
      assert.equal(session.replaceGeneration, generation);
    }
    assert.equal(event(input, 1, "user/message").data.id, "user-1");
    assert.equal(event(input, 4, "assistant/message").data.message.id, "assistant-1");
  }
  const fresh = makeCompactionRecoveryFixtures();
  assert.notStrictEqual(f.prunedInterrupted.events, fresh.prunedInterrupted.events);
  assert.deepEqual(f.prunedInterrupted.events, fresh.prunedInterrupted.events);
  for (const [input] of cases) assert.ok(Object.isFrozen(input.events));
});

test("各崩溃边界保留完整已提交组并且没有伪造终态", () => {
  const f = makeCompactionRecoveryFixtures();
  assert.deepEqual(types(f.independentInterrupted).slice(7), ["command/run", "compaction/start"]);
  assert.deepEqual(event(f.independentInterrupted, 7, "command/run").data, { commandId: "I", name: "compact", source: { kind: "user" } });
  assert.deepEqual(event(f.independentInterrupted, 8, "compaction/start").data, { compactionId: "I1", turn: null, sourceCommandId: "I" });
  assert.deepEqual(types(f.preStepInterrupted).slice(7), ["turn/start", "user/message", "compaction/start"]);
  assert.deepEqual(event(f.preStepInterrupted, 9, "compaction/start").data, { compactionId: "P1", turn: 2 });
  assert.deepEqual(types(f.prunedInterrupted).slice(7), ["turn/start", "user/message", "step/start", "assistant/message", "tool/call", "tool/operation", "tool/result", "step/end", "step/start", "assistant/attempt", "compaction/prune", "tool/result", "compaction/start"]);
  assert.deepEqual(event(f.prunedInterrupted, 19, "compaction/start").data, { compactionId: "R1", turn: 2 });
  assert.deepEqual(types(f.secondSummaryInterrupted).slice(7), ["turn/start", "user/message", "compaction/start", "compaction/summary", "user/message", "compaction/end", "compaction/start"]);
  const s = f.secondSummaryInterrupted;
  assert.deepEqual(event(s, 9, "compaction/start").data, { compactionId: "S1", turn: 2 });
  assert.deepEqual(event(s, 10, "compaction/summary").data, { compactionId: "S1", summary: "摘要", shadowedRange: { start: 1, end: 4 }, shadowedSeqs: [1, 4], route: { provider: "mock", model: "fixture" } });
  const checkpoint = event(s, 11, "user/message");
  assert.deepEqual(checkpoint.surfaceOp, { op: "replace", start: 1, end: 4 });
  assert.deepEqual(checkpoint.sourceEventSeqs, [10, 1, 4]);
  assert.deepEqual(checkpoint.data.source, { kind: "compact", compactionId: "S1" });
  assert.equal("sourceCommandId" in checkpoint.data, false);
  assert.deepEqual(checkpoint.data.content, [
    { type: "text", text: "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>" },
    { type: "text", text: "摘要" }, { type: "text", text: "</compacted-summary>" },
  ]);
  assert.ok(JSON.stringify(checkpoint.data.content).length < JSON.stringify([event(s, 1, "user/message").data.content, event(s, 4, "assistant/message").data.message.content]).length);
  assert.deepEqual(event(s, 12, "compaction/end").data, { compactionId: "S1", turn: 2, status: "succeeded" });
  assert.deepEqual(event(s, 13, "compaction/start").data, { compactionId: "S2", turn: 2 });
  for (const input of [f.independentInterrupted, f.preStepInterrupted, f.prunedInterrupted, s]) {
    assert.deepEqual(types(input).slice(0, 7), ["turn/start", "user/message", "step/start", "request/header", "assistant/message", "step/end", "turn/end"]);
    assert.equal(input.events.filter((e) => e.type === "turn/end").length, 1);
    assert.equal(input.events.filter((e) => e.type === "command/done").length, 0);
  }
  for (const input of [f.independentInterrupted, f.preStepInterrupted, f.prunedInterrupted, s, ...Object.values(f.settledWithoutDone), f.roundGapRunOnly, f.inheritedOwnership]) {
    assert.deepEqual(event(input, 0, "turn/start").data, { turn: 1 });
    assert.deepEqual(event(input, 2, "step/start").data, { turn: 1, step: 1 });
    assert.deepEqual(event(input, 5, "step/end").data, { turn: 1, step: 1 });
    assert.deepEqual(event(input, 6, "turn/end").data, { turn: 1, reason: { kind: "completed" } });
  }
  for (const input of [f.preStepInterrupted, f.prunedInterrupted, s]) assert.deepEqual(event(input, 7, "turn/start").data, { turn: 2 });
  assert.deepEqual(event(f.prunedInterrupted, 9, "step/start").data, { turn: 2, step: 1 });
  assert.deepEqual(event(f.prunedInterrupted, 14, "step/end").data, { turn: 2, step: 1 });
  assert.deepEqual(event(f.prunedInterrupted, 15, "step/start").data, { turn: 2, step: 2 });
  assert.equal(f.preStepInterrupted.events.some((e) => e.type === "step/start" && e.data.turn === 2), false);
  assert.equal(s.events.some((e) => e.type === "step/start" && e.data.turn === 2), false);
  assert.deepEqual(event(f.crossTurnBusy, 7, "turn/end").data, { turn: 1, reason: { kind: "completed" } });
  assert.deepEqual(event(f.crossTurnBusy, 8, "turn/start").data, { turn: 2 });
  assert.deepEqual(event(f.crossTurnBusy, 11, "step/start").data, { turn: 2, step: 1 });
  assert.deepEqual(event(f.crossTurnBusy, 13, "step/end").data, { turn: 2, step: 1 });
  assert.deepEqual(event(f.crossTurnBusy, 14, "turn/end").data, { turn: 2, reason: { kind: "completed" } });
});

test("持久流、工具声明及超限失败与实际消息一致", () => {
  const f = makeCompactionRecoveryFixtures();
  for (const [input, seq] of [[f.independentInterrupted, 4], [f.prunedInterrupted, 4], [f.crossTurnBusy, 12]] as const) {
    const message = event(input, seq, "assistant/message");
    const block = message.data.message.content[0];
    assert.ok(block && block.type === "text");
    assert.deepEqual(message.data.message.content, [block]);
    assert.deepEqual(message.data.stream, [
      { time: 0, chunk: { type: "block-start", index: 0, blockType: "text" } },
      { time: 1, chunk: { type: "text-delta", index: 0, text: block.text } },
      { time: 2, chunk: { type: "block-end", index: 0, block } },
      { time: 3, chunk: { type: "finish", reason: { kind: "stop" } } },
    ]);
    assert.deepEqual(message.data.finishReason, { kind: "stop" });
  }
  const r = f.prunedInterrupted;
  const message = event(r, 10, "assistant/message");
  const block = message.data.message.content[0];
  assert.ok(block && block.type === "tool-call");
  assert.deepEqual(block, { type: "tool-call", id: "call-R", name: "lookup", arguments: '{"query":"fixture"}' });
  assert.deepEqual(message.data.message.content, [block]);
  assert.deepEqual(message.data.finishReason, { kind: "tool_calls" });
  assert.deepEqual(message.data.stream, [
    { time: 0, chunk: { type: "block-start", index: 0, blockType: "tool-call" } },
    { time: 1, chunk: { type: "tool-call-delta", index: 0, id: "call-R", name: "lookup", argumentsDelta: '{"query":"fixture"}' } },
    { time: 2, chunk: { type: "block-end", index: 0, block } },
    { time: 3, chunk: { type: "finish", reason: { kind: "tool-calls" } } },
  ]);
  assert.deepEqual(event(r, 11, "tool/call").data, { turn: 2, step: 1, callId: block.id, name: block.name, arguments: block.arguments });
  assert.deepEqual(event(r, 12, "tool/operation").data.validatedArgs, JSON.parse(block.arguments));
  const header = event(r, 3, "request/header");
  assert.deepEqual(header.data.header, { config: { provider: "mock", model: "fixture" }, tools: [{ name: "lookup", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }] });
  for (const seq of [10, 16]) {
    assert.equal(r.events.slice(0, seq).findLast((e) => e.type === "request/header")?.seq, 3);
  }
  const attempt = event(r, 16, "assistant/attempt");
  assert.equal(attempt.data.turn, 2);
  assert.equal(attempt.data.step, 2);
  assert.deepEqual(attempt.data.reason, { code: "CONTEXT_WINDOW_EXCEEDED", message: "context window exceeded" });
  assert.equal(attempt.data.includeInModelContext, false);
  assert.equal(attempt.data.outcome, "failed");
  assert.deepEqual(attempt.data.stream, [{ time: 0, chunk: { type: "finish", reason: { kind: "error", failure: attempt.data.reason } } }]);
});

test("修剪前后完整前缀保留结果身份及原始内容", () => {
  const r = makeCompactionRecoveryFixtures().prunedInterrupted;
  const before = restore({ ...r, events: r.events.slice(0, 17) });
  assert.deepEqual(before.deriveSurfaceNodes().map((e) => e.seq), [1, 4, 8, 10, 13]);
  assertModelToolContent(before, originalText);
  assert.throws(() => restore({ ...r, events: r.events.slice(0, 18) }), /修剪标记/);
  const after = restore({ ...r, events: r.events.slice(0, 19) });
  assert.deepEqual(after.deriveSurfaceNodes().map((e) => e.seq), [1, 4, 8, 10, 18]);
  assertModelToolContent(after, prunedText);
  assertModelToolContent(restore(r), prunedText);
  const original = event(r, 13, "tool/result");
  const replacement = event(r, 18, "tool/result");
  assert.equal([...originalText].length, 8193);
  assert.equal(4 + 4 + 4 + Math.ceil(originalText.length / 4), 2061);
  assert.deepEqual(event(r, 17, "compaction/prune").data, { shadowedSeq: 13, beforeTokens: 2061 });
  assert.deepEqual(original.sourceEventSeqs, [11]);
  assert.deepEqual(replacement.sourceEventSeqs, [13]);
  assert.deepEqual(replacement.surfaceOp, { op: "replace", start: 13, end: 13 });
  assert.deepEqual({ ...replacement.data, message: { ...replacement.data.message, content: original.data.message.content } }, original.data);
  assert.deepEqual(original.data.meta, { visible: true });
  assert.deepEqual(replacement.data.meta, { visible: true });
  assert.deepEqual(original.data.message.content[0].content, [{ type: "text", text: originalText }]);
  assert.deepEqual(replacement.data.message.content[0].content, [{ type: "text", text: prunedText }]);
});

test("命令结局、跨轮历史和继承边界保持区分", () => {
  const f = makeCompactionRecoveryFixtures();
  for (const status of ["succeeded", "failed", "cancelled"] as const) {
    const k = f.settledWithoutDone[status];
    const id = `K-${status}`; const compactionId = `K1-${status}`;
    assert.deepEqual(types(k).slice(7), status === "succeeded" ? ["command/run", "compaction/start", "compaction/summary", "user/message", "compaction/end"] : ["command/run", "compaction/start", "compaction/end"]);
    assert.deepEqual(event(k, 7, "command/run").data, { commandId: id, name: "compact", source: { kind: "user" } });
    assert.deepEqual(event(k, 8, "compaction/start").data, { compactionId, sourceCommandId: id, turn: null });
    const end = event(k, status === "succeeded" ? 11 : 9, "compaction/end");
    assert.deepEqual(end.data, status === "succeeded" ? { compactionId, sourceCommandId: id, turn: null, status } : { compactionId, sourceCommandId: id, turn: null, status, reason: { kind: status, message: `fixture ${status}` } });
    assert.equal(k.events.some((e) => e.type === "command/done"), false);
    if (status === "succeeded") {
      assert.deepEqual(event(k, 9, "compaction/summary").data, { compactionId, sourceCommandId: id, summary: "摘要", shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], route: { provider: "mock", model: "fixture" } });
      const cp = event(k, 10, "user/message");
      assert.deepEqual(cp.sourceEventSeqs, [9, 1]);
      assert.deepEqual(cp.surfaceOp, { op: "replace", start: 1, end: 1 });
      assert.equal(cp.data.source.kind, "compact");
      if (!("sourceCommandId" in cp.data)) throw new Error("缺少命令来源");
      assert.equal(cp.data.sourceCommandId, id);
      assert.deepEqual(cp.data.source, { kind: "compact", compactionId });
      assert.deepEqual(cp.data.content, event(f.secondSummaryInterrupted, 11, "user/message").data.content);
    }
  }
  assert.deepEqual(types(f.roundGapRunOnly).slice(7), ["command/run", "command/done", "command/run"]);
  assert.deepEqual(event(f.roundGapRunOnly, 8, "command/done").data, { commandId: "G2", kind: "error", text: "busy" });
  assert.equal(event(f.roundGapRunOnly, 9, "command/run").data.commandId, "G1");
  assert.deepEqual(types(f.crossTurnBusy).slice(6), ["command/run", "turn/end", "turn/start", "user/message", "command/done", "step/start", "assistant/message", "step/end", "turn/end"]);
  assert.equal(event(f.crossTurnBusy, 6, "command/run").data.commandId, "B");
  assert.deepEqual(event(f.crossTurnBusy, 10, "command/done").data, { commandId: "B", kind: "error", text: "busy" });
  const o = f.inheritedOwnership;
  assert.equal(o.inheritedEventCount, 10);
  assert.deepEqual(o.events.slice(0, 10), f.roundGapRunOnly.events);
  assert.deepEqual(types(o).slice(10), ["session/end-seed", "command/run"]);
  assert.deepEqual(event(o, 10, "session/end-seed").data, { inherited: true });
  assert.deepEqual(event(o, 11, "command/run").data, { commandId: "O", name: "compact", source: { kind: "user" } });
  assert.deepEqual(restore(o).snapshot().events, o.events);
  assert.throws(() => restore({ ...o, inheritedEventCount: 9 }), /继承/);
});

test("固定输入切片的种子形状与重开视图", () => {
  const f = makeCompactionRecoveryFixtures();
  for (const [input, cut, surface] of [
    [f.crossTurnBusy, 8, [1, 4]], [f.settledWithoutDone.succeeded, 12, [10, 4]],
    [f.settledWithoutDone.failed, 10, [1, 4]], [f.settledWithoutDone.cancelled, 10, [1, 4]],
  ] as const) {
    const header = { sessionId: `child-${input.header.sessionId}`, createdAt: 2000, isSeeded: true, parentSession: input.header.sessionId } as const;
    const child = new Session(header, { seed: { kind: "fork", events: input.events.slice(0, cut) } });
    assert.equal(child.inheritedEventCount, cut);
    assert.deepEqual(child.snapshot().events.slice(0, cut), input.events.slice(0, cut));
    assert.deepEqual(child.snapshot().events[cut], { type: "session/end-seed", seq: cut, time: 2000, data: { inherited: true } });
    const reopened = restore({ header, events: child.snapshot().events, inheritedEventCount: cut });
    assert.deepEqual(reopened.snapshot(), child.snapshot());
    assert.deepEqual(reopened.deriveSurfaceNodes().map((node) => node.seq), surface);
    assert.equal(reopened.replaceGeneration, input === f.settledWithoutDone.succeeded ? 1 : 0);
  }
});

test("SQLite 重开保留根和子会话的元数据、前缀及视图", async () => {
  const f = makeCompactionRecoveryFixtures();
  const beforePrune = { ...f.prunedInterrupted, header: { sessionId: "R-before", createdAt: 1000 }, events: f.prunedInterrupted.events.slice(0, 17) };
  const inputs = [beforePrune, f.prunedInterrupted, f.inheritedOwnership];
  const dir = await mkdtemp(join(tmpdir(), "mh-compaction-fixtures-"));
  const path = join(dir, "events.sqlite");
  try {
    const store = new SqliteSessionPersistence(path);
    try {
      for (const input of inputs) {
        const writer = await store.create(input.header, { inheritedEventCount: input.inheritedEventCount });
        await writer.append(input.events);
        await writer.close();
      }
    } finally { await store.close(); }
    const reader = new SqliteSessionPersistence(path, { readOnly: true });
    try {
      for (const input of inputs) {
        const handle = await reader.open(input.header.sessionId, "read");
        assert.ok(handle);
        assert.deepEqual(handle.header, input.header);
        assert.equal(handle.inheritedEventCount, input.inheritedEventCount);
        const events = await handle.read();
        assert.deepEqual(events, input.events);
        const session = restore({ header: handle.header, inheritedEventCount: handle.inheritedEventCount, events });
        assert.deepEqual(session.snapshot(), { events: input.events, cursor: input.events.length - 1 });
        assert.deepEqual(session.deriveSurfaceNodes(), restore(input).deriveSurfaceNodes());
        assert.deepEqual(session.deriveMessages(), restore(input).deriveMessages());
        if (input === beforePrune) assertModelToolContent(session, originalText);
        if (input === f.prunedInterrupted) assertModelToolContent(session, prunedText);
        assert.equal(session.replaceGeneration, restore(input).replaceGeneration);
        await handle.close();
      }
    } finally { await reader.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
