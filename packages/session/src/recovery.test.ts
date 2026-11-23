import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interruptedTurnClosers } from "./recovery.ts";
import type { SessionEvent } from "./events.ts";
import { makeCompactionRecoveryFixtures } from "./compaction-recovery-fixtures.ts";

test("自有压缩不完整的成功批次拒绝写入修复记录", async () => {
  const { projectInterruptedSession, recoverInterruptedSession } = await import("./recovery.ts");
  const sample = makeCompactionRecoveryFixtures().settledWithoutDone.succeeded;
  const end = sample.events.at(-1)!;
  for (const events of [
    sample.events.slice(0, -1),
    sample.events.map(event => event.type === "compaction/summary" ? { ...event, data: { ...event.data, shadowedSeqs: [] } } : event),
    (() => {
      const run = sample.events.find(event => event.type === "command/run")!;
      assert.equal(run.type, "command/run");
      return [
        { ...run, seq: 0 },
        { ...end, seq: 1 },
        { type: "command/done", seq: 2, time: 1, data: { commandId: run.data.commandId, kind: "success" } },
        { type: "turn/start", seq: 3, time: 1, data: { turn: 1 } },
      ] satisfies SessionEvent[];
    })(),
    (() => {
      const run = sample.events.find(event => event.type === "command/run")!;
      const start = sample.events.find(event => event.type === "compaction/start")!;
      return [
        { ...run, seq: 0 },
        { ...start, seq: 1 },
        { type: "command/done", seq: 2, time: 1, data: { commandId: run.data.commandId, kind: "error", text: "进程中断" } },
      ] satisfies SessionEvent[];
    })(),
    [...sample.events.slice(0, -2), { ...end, seq: end.seq - 1 }],
  ]) {
    const handle: import("./persistence.ts").SessionHandle = {
      id: sample.header.sessionId, header: sample.header, inheritedEventCount: sample.inheritedEventCount, access: "write",
      async read() { return events; }, async append() { assert.fail("矛盾前缀不得写入"); }, async flush() {}, async close() {},
    };
    await assert.rejects(projectInterruptedSession(handle), /恢复关联冲突/);
    await assert.rejects(recoverInterruptedSession(handle), /恢复关联冲突/);
  }
});

for (const withCheckpoint of [false, true]) {
  test(`没有开始记录的自有自动压缩拒绝恢复（替换记录 ${withCheckpoint}）`, async () => {
    const { projectInterruptedSession, recoverInterruptedSession } = await import("./recovery.ts");
    const fixture = makeCompactionRecoveryFixtures().secondSummaryInterrupted;
    const start = fixture.events.find(event => event.type === "compaction/start")!;
    const summary = fixture.events.at(start.seq + 1)!;
    const checkpoint = fixture.events.at(start.seq + 2)!;
    assert.equal(summary.type, "compaction/summary");
    assert.equal(checkpoint.type, "user/message");
    const events: SessionEvent[] = [...fixture.events.slice(0, start.seq), { ...summary, seq: start.seq }];
    if (withCheckpoint) events.push({ ...checkpoint, seq: start.seq + 1, sourceEventSeqs: [start.seq, ...summary.data.shadowedSeqs] });
    const handle: import("./persistence.ts").SessionHandle = {
      id: fixture.header.sessionId, header: fixture.header, inheritedEventCount: fixture.inheritedEventCount, access: "write",
      async read() { return events; }, async append() { assert.fail("矛盾前缀不得写入"); }, async flush() {}, async close() {},
    };
    await assert.rejects(projectInterruptedSession(handle), /恢复关联冲突/);
    await assert.rejects(recoverInterruptedSession(handle), /恢复关联冲突/);
  });
}

test("恢复已确认成功的压缩命令并引用真实摘要", async () => {
  const { recoverInterruptedSession } = await import("./recovery.ts");
  const fixture = makeCompactionRecoveryFixtures().settledWithoutDone.succeeded;
  let events = [...fixture.events];
  const handle: import("./persistence.ts").SessionHandle = {
    id: fixture.header.sessionId, header: fixture.header, inheritedEventCount: fixture.inheritedEventCount, access: "write",
    async read() { return events; }, async append(batch) { events = [...events, ...batch]; }, async flush() {}, async close() {},
  };
  const repaired = await recoverInterruptedSession(handle);
  assert.deepEqual(repaired.map(event => event.data), [{ commandId: "K-succeeded", kind: "success", sourceEventSeq: 9 }]);
  assert.deepEqual(events.slice(0, fixture.events.length), fixture.events);
  assert.deepEqual(await recoverInterruptedSession(handle), []);
});

test("真实夹具投影依次结算压缩、命令与实际打开范围", async () => {
  const { projectInterruptedSession, recoverInterruptedSession } = await import("./recovery.ts");
  const f = makeCompactionRecoveryFixtures();
  for (const [fixture, expected] of [
    [f.independentInterrupted, ["compaction/end", "command/done"]],
    [f.preStepInterrupted, ["compaction/end", "turn/end"]],
    [f.secondSummaryInterrupted, ["compaction/end", "turn/end"]],
    [f.settledWithoutDone.failed, ["command/done"]],
    [f.settledWithoutDone.cancelled, ["command/done"]],
    [f.roundGapRunOnly, ["command/done"]],
    [f.inheritedOwnership, ["command/done"]],
  ] as const) {
    let events = [...fixture.events];
    const handle: import("./persistence.ts").SessionHandle = {
      id: fixture.header.sessionId, header: fixture.header, inheritedEventCount: fixture.inheritedEventCount, access: "write",
      async read() { return events; }, async append(batch) { events = [...events, ...batch]; }, async flush() {}, async close() {},
    };
    const view = await projectInterruptedSession(handle);
    assert.equal(view.cursor, fixture.events.length - 1);
    assert.deepEqual(events, fixture.events);
    assert.deepEqual(view.session.snapshot().events.slice(fixture.events.length).map(e => e.type), expected);
    const repaired = await recoverInterruptedSession(handle);
    assert.deepEqual(repaired.map(e => e.type), expected);
    assert.deepEqual(events.slice(0, fixture.events.length), fixture.events);
    assert.deepEqual(await recoverInterruptedSession(handle), []);
    if (fixture === f.inheritedOwnership) assert.deepEqual(repaired[0]?.data, { commandId: "O", kind: "error", text: "进程中断" });
    if (fixture === f.settledWithoutDone.failed) assert.deepEqual(repaired[0]?.data, { commandId: "K-failed", kind: "error", text: "压缩失败" });
    if (fixture === f.settledWithoutDone.cancelled) assert.deepEqual(repaired[0]?.data, { commandId: "K-cancelled", kind: "error", text: "压缩已取消" });
  }
});

test("关联摘要缺失或冲突时拒绝两个恢复入口且不写入", async () => {
  const { projectInterruptedSession, recoverInterruptedSession } = await import("./recovery.ts");
  const fixture = makeCompactionRecoveryFixtures().settledWithoutDone.succeeded;
  for (const events of [
    fixture.events.map(e => e.seq === 9 && e.type === "compaction/summary" ? { ...e, data: { ...e.data, sourceCommandId: "wrong" } } : e),
    fixture.events.map(e => e.seq === 11 && e.type === "compaction/end" ? { ...e, data: { ...e.data, turn: 1 } } : e),
  ]) {
    let writes = 0;
    const handle: import("./persistence.ts").SessionHandle = {
      id: fixture.header.sessionId, header: fixture.header, inheritedEventCount: fixture.inheritedEventCount, access: "write",
      async read() { return events; }, async append() { writes++; }, async flush() {}, async close() {},
    };
    await assert.rejects(projectInterruptedSession(handle));
    await assert.rejects(recoverInterruptedSession(handle));
    assert.equal(writes, 0);
  }
});

test("同一压缩身份出现其他命令的摘要时禁止按缺失结果降级", async () => {
  const { recoverInterruptedSession } = await import("./recovery.ts");
  const fixture = makeCompactionRecoveryFixtures().independentInterrupted;
  const events: SessionEvent[] = [...fixture.events, { seq: 9, time: 1, type: "compaction/summary", data: {
    compactionId: "I1", sourceCommandId: "other", summary: "冲突", shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], route: { provider: "p", model: "m" },
  } }];
  let writes = 0;
  const handle: import("./persistence.ts").SessionHandle = {
    id: fixture.header.sessionId, header: fixture.header, inheritedEventCount: 0, access: "write",
    async read() { return events; }, async append() { writes++; }, async flush() {}, async close() {},
  };
  await assert.rejects(recoverInterruptedSession(handle), /I1/);
  assert.equal(writes, 0);
});

test("在线输入必须匹配可靠前缀，且已有终态优先于内存意图", async () => {
  const { recoverInterruptedSession } = await import("./recovery.ts");
  const f = makeCompactionRecoveryFixtures();
  const fixture = f.independentInterrupted;
  let events = [...fixture.events];
  let writes = 0;
  const handle: import("./persistence.ts").SessionHandle = {
    id: fixture.header.sessionId, header: fixture.header, inheritedEventCount: 0, access: "write",
    async read() { return events; }, async append(batch) { writes++; events = [...events, ...batch]; }, async flush() {}, async close() {},
  };
  await assert.rejects(recoverInterruptedSession(handle, { expectedLivePrefix: events.slice(0, -1) }), /live/);
  assert.equal(writes, 0);
  const intent = { compactionId: "I1", turn: null, sourceCommandId: "I", status: "cancelled", reason: { kind: "cancelled" } } as const;
  const repaired = await recoverInterruptedSession(handle, { expectedLivePrefix: events, terminalIntents: [intent] });
  assert.deepEqual(repaired[0]?.data, { ...intent });
  assert.deepEqual(repaired[1]?.data, { commandId: "I", kind: "error", text: "压缩已取消" });
  assert.deepEqual(await recoverInterruptedSession(handle, { expectedLivePrefix: events, terminalIntents: [{ ...intent, status: "failed" }] }), []);
});

test("继承命令之后出现子会话压缩时不替父命令补 done", async () => {
  const { recoverInterruptedSession } = await import("./recovery.ts");
  const f = makeCompactionRecoveryFixtures().inheritedOwnership;
  let events: SessionEvent[] = [...f.events, { seq: f.events.length, time: 1, type: "compaction/start", data: { compactionId: "child", sourceCommandId: "G1", turn: null } }];
  const handle: import("./persistence.ts").SessionHandle = {
    id: f.header.sessionId, header: f.header, inheritedEventCount: f.inheritedEventCount, access: "write",
    async read() { return events; }, async append(batch) { events = [...events, ...batch]; }, async flush() {}, async close() {},
  };
  const repaired = await recoverInterruptedSession(handle);
  assert.deepEqual(repaired.map(e => e.type), ["compaction/end", "command/done"]);
  assert.deepEqual(repaired[1]?.data, { commandId: "O", kind: "error", text: "进程中断" });
  assert.deepEqual(await recoverInterruptedSession(handle), []);
});

test("竞争压缩尝试与重复终态拒绝整个恢复批次", async () => {
  const { projectInterruptedSession, recoverInterruptedSession } = await import("./recovery.ts");
  const f = makeCompactionRecoveryFixtures().settledWithoutDone.failed;
  const start = f.events.find(e => e.type === "compaction/start");
  const end = f.events.find(e => e.type === "compaction/end");
  assert.ok(start && end && start.type === "compaction/start");
  for (const extra of [{ ...start, data: { ...start.data, compactionId: "competitor" } }, end]) {
    const events = [...f.events, { ...extra, seq: f.events.length }];
    let writes = 0;
    const handle: import("./persistence.ts").SessionHandle = {
      id: f.header.sessionId, header: f.header, inheritedEventCount: 0, access: "write",
      async read() { return events; }, async append() { writes++; }, async flush() {}, async close() {},
    };
    await assert.rejects(projectInterruptedSession(handle));
    await assert.rejects(recoverInterruptedSession(handle));
    assert.equal(writes, 0);
  }
});

test("不同命令的压缩记录可以交错且各自结算一次", async () => {
  const { recoverInterruptedSession } = await import("./recovery.ts");
  const f = makeCompactionRecoveryFixtures().independentInterrupted;
  let events: SessionEvent[] = [...f.events,
    { seq: 9, time: 1, type: "command/run", data: { commandId: "J", name: "compact", source: { kind: "user" } } },
    { seq: 10, time: 1, type: "compaction/start", data: { compactionId: "J1", turn: null, sourceCommandId: "J" } },
    { seq: 11, time: 1, type: "compaction/end", data: { compactionId: "I1", turn: null, sourceCommandId: "I", status: "failed", reason: { kind: "failed" } } },
  ];
  const handle: import("./persistence.ts").SessionHandle = {
    id: f.header.sessionId, header: f.header, inheritedEventCount: 0, access: "write",
    async read() { return events; }, async append(batch) { events = [...events, ...batch]; }, async flush() {}, async close() {},
  };
  const repaired = await recoverInterruptedSession(handle);
  assert.deepEqual(repaired.map(e => e.data), [
    { compactionId: "J1", turn: null, sourceCommandId: "J", status: "interrupted", reason: { kind: "process_interrupted" } },
    { commandId: "I", kind: "error", text: "压缩失败" },
    { commandId: "J", kind: "error", text: "进程中断" },
  ]);
  assert.deepEqual(await recoverInterruptedSession(handle), []);
});

test("未使用的冲突证据与逆序链不能被恢复忽略", async () => {
  const { projectInterruptedSession, recoverInterruptedSession } = await import("./recovery.ts");
  const f = makeCompactionRecoveryFixtures().settledWithoutDone.succeeded;
  const run = f.events[7]!, start = f.events[8]!, summary = f.events[9]!, end = f.events[11]!;
  const renumber = (events: readonly SessionEvent[]) => events.map((event, seq) => ({ ...event, seq }));
  const cases: readonly (readonly SessionEvent[])[] = [
    renumber([...f.events.slice(0, 7), start, run, ...f.events.slice(9)]),
    renumber([...f.events.slice(0, 8), end, start, ...f.events.slice(9, 11)]),
    renumber([...f.events.slice(0, 8), summary, start, ...f.events.slice(10)]),
    renumber([...f.events.slice(0, 9), end, summary, f.events[10]!]),
    renumber([...f.events.slice(0, 8), end]),
    renumber([...f.events, summary]),
    renumber([...f.events, run]),
    renumber([...f.events, { seq: 12, time: 1, type: "compaction/end", data: { compactionId: "orphan", turn: null, sourceCommandId: "K-succeeded", status: "failed", reason: { kind: "failed" } } }]),
    renumber([...f.events, { seq: 12, time: 1, type: "compaction/summary", data: { compactionId: "orphan", sourceCommandId: "K-succeeded", summary: "冲突", shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], route: { provider: "p", model: "m" } } }]),
  ];
  for (const [index, events] of cases.entries()) {
    let writes = 0;
    const handle: import("./persistence.ts").SessionHandle = {
      id: f.header.sessionId, header: f.header, inheritedEventCount: 0, access: "write",
      async read() { return events; }, async append() { writes++; }, async flush() {}, async close() {},
    };
    await assert.rejects(projectInterruptedSession(handle), `projection ${index}`);
    await assert.rejects(recoverInterruptedSession(handle), `recovery ${index}`);
    assert.equal(writes, 0);
  }
});

test("已完成命令的竞争 start 不能生成新的孤立终态", async () => {
  const { projectInterruptedSession, recoverInterruptedSession } = await import("./recovery.ts");
  const f = makeCompactionRecoveryFixtures().settledWithoutDone.failed;
  const events: SessionEvent[] = [...f.events,
    { seq: f.events.length, time: 1, type: "command/done", data: { commandId: "K-failed", kind: "error", text: "失败" } },
    { seq: f.events.length + 1, time: 1, type: "compaction/start", data: { compactionId: "competing", sourceCommandId: "K-failed", turn: null } },
  ];
  let writes = 0;
  const handle: import("./persistence.ts").SessionHandle = {
    id: f.header.sessionId, header: f.header, inheritedEventCount: 0, access: "write",
    async read() { return events; }, async append() { writes++; }, async flush() {}, async close() {},
  };
  await assert.rejects(projectInterruptedSession(handle));
  await assert.rejects(recoverInterruptedSession(handle));
  assert.equal(writes, 0);
});

test("无 surface 依赖的逆序和孤立关联由压缩校验拒绝", async () => {
  const { projectInterruptedSession, recoverInterruptedSession } = await import("./recovery.ts");
  const run: SessionEvent = { seq: 0, time: 1, type: "command/run", data: { commandId: "C", name: "compact", source: { kind: "user" } } };
  const start: SessionEvent = { seq: 0, time: 1, type: "compaction/start", data: { compactionId: "A", sourceCommandId: "C", turn: null } };
  const end: SessionEvent = { seq: 0, time: 1, type: "compaction/end", data: { compactionId: "A", sourceCommandId: "C", turn: null, status: "failed", reason: { kind: "failed" } } };
  const summary: SessionEvent = { seq: 0, time: 1, type: "compaction/summary", data: { compactionId: "A", sourceCommandId: "C", summary: "摘要", shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], route: { provider: "p", model: "m" } } };
  for (const input of [[start, run], [run, end, start], [run, summary, start], [run, start, end, summary], [run, end], [run, summary], [run, start, { ...end, data: { ...end.data, sourceCommandId: "other" } }]]) {
    const events = input.map((event, seq) => ({ ...event, seq }));
    let writes = 0;
    const handle: import("./persistence.ts").SessionHandle = {
      id: "C", header: { sessionId: "C", createdAt: 1 }, inheritedEventCount: 0, access: "write",
      async read() { return events; }, async append() { writes++; }, async flush() {}, async close() {},
    };
    await assert.rejects(projectInterruptedSession(handle), /恢复关联冲突/);
    await assert.rejects(recoverInterruptedSession(handle), /恢复关联冲突/);
    assert.equal(writes, 0);
  }
});

test("无关联的旧孤立终态不妨碍干净命令恢复", async () => {
  const { recoverInterruptedSession } = await import("./recovery.ts");
  const f = makeCompactionRecoveryFixtures().roundGapRunOnly;
  let events: SessionEvent[] = [...f.events, { seq: f.events.length, time: 1, type: "compaction/end", data: { compactionId: "legacy", turn: null, status: "failed", reason: { kind: "failed" } } }];
  const handle: import("./persistence.ts").SessionHandle = {
    id: f.header.sessionId, header: f.header, inheritedEventCount: 0, access: "write",
    async read() { return events; }, async append(batch) { events = [...events, ...batch]; }, async flush() {}, async close() {},
  };
  assert.deepEqual((await recoverInterruptedSession(handle)).map(e => e.data), [{ commandId: "G1", kind: "error", text: "进程中断" }]);
});

test("继承的逆序关联不会因子会话追加 start 而被忽略", async () => {
  const { Session } = await import("./session.ts");
  const { projectInterruptedSession, recoverInterruptedSession } = await import("./recovery.ts");
  const f = makeCompactionRecoveryFixtures().roundGapRunOnly;
  const inherited: SessionEvent[] = [...f.events.slice(0, -1),
    { seq: f.events.length - 1, time: 1, type: "compaction/start", data: { compactionId: "parent", sourceCommandId: "G1", turn: null } },
    { ...f.events.at(-1)!, seq: f.events.length },
  ];
  const session = new Session({ sessionId: "child-invalid", createdAt: 1, isSeeded: true, parentSession: "G" }, { seed: { kind: "fork", events: inherited } });
  session.append({ type: "compaction/start", data: { compactionId: "child", sourceCommandId: "G1", turn: null } });
  const events = session.snapshot().events;
  let writes = 0;
  const handle: import("./persistence.ts").SessionHandle = {
    id: session.header.sessionId, header: session.header, inheritedEventCount: session.inheritedEventCount, access: "write",
    async read() { return events; }, async append() { writes++; }, async flush() {}, async close() {},
  };
  await assert.rejects(projectInterruptedSession(handle));
  await assert.rejects(recoverInterruptedSession(handle));
  assert.equal(writes, 0);
});

const start: SessionEvent[] = [
  { seq: 0, time: 1, type: "turn/start", data: { turn: 1 } },
  { seq: 1, time: 2, type: "step/start", data: { turn: 1, step: 1 } },
];

test("只关闭前缀中实际打开的范围", () => {
  assert.deepEqual(interruptedTurnClosers(start, 3).map(e => e.type), ["step/end", "turn/end"]);
  assert.deepEqual(interruptedTurnClosers(start.slice(0, 1), 3).map(e => e.type), ["turn/end"]);
});

test("实库按声明顺序修复已批准和未调度调用，只读推导保留真实前缀", async (t) => {
  const { Session } = await import("./session.ts");
  const { projectInterruptedSession, recoverInterruptedSession } = await import("./recovery.ts");
  const { SqliteSessionPersistence } = await import("./storage/sqlite-persistence.ts");
  const s = new Session({ sessionId: "s", createdAt: 1 });
  s.append({ type: "turn/start", data: { turn: 1 } });
  s.append({ type: "step/start", data: { turn: 1, step: 1 } });
  s.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1,
    message: { id: "m", role: "assistant", source: { provider: "p", model: "m" }, content: [
      { type: "tool-call", id: "a", name: "one", arguments: "{}" },
      { type: "tool-call", id: "b", name: "two", arguments: "{}" },
    ] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true } });
  s.append({ type: "tool/call", data: { turn: 1, step: 1, callId: "a", name: "one", arguments: "{}" } });
  s.append({ type: "tool/operation", data: { turn: 1, step: 1, callId: "a", operationId: "op", toolName: "one", toolVersion: "1", validatedArgs: {} } });
  s.append({ type: "approval/asked", data: { id: "approval", operationId: "op", toolName: "one", reason: "policy" } });
  const dir = await mkdtemp(join(tmpdir(), "mharness-recovery-"));
  const path = join(dir, "events.sqlite");
  const storage = new SqliteSessionPersistence(path);
  const observer = new SqliteSessionPersistence(path, { readOnly: true });
  t.after(async () => {
    await observer.close();
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  });
  const handle = await storage.create(s.header);
  await handle.append(s.snapshot().events);
  const reader = await observer.open("s", "read");
  assert.ok(reader);
  const view = await projectInterruptedSession(reader);
  assert.equal(view.cursor, 5);
  assert.equal(view.session.seq, 10);
  assert.deepEqual(await reader.read(), s.snapshot().events);
  await handle.append([s.append({ type: "approval/decided", data: { id: "approval", outcome: "allowed-once" } })]);
  const closers = await recoverInterruptedSession(handle);
  assert.deepEqual(closers.map(e => e.type), ["tool/result", "tool/result", "step/end", "turn/end"]);
  const [a, b] = closers;
  assert.equal(a?.type, "tool/result"); assert.equal(b?.type, "tool/result");
  if (a?.type !== "tool/result" || b?.type !== "tool/result") throw new Error("missing results");
  assert.deepEqual(a.sourceEventSeqs, [3]); assert.equal(a.data.error?.code, "TOOL_OUTCOME_UNKNOWN");
  assert.equal(a.data.operationId, "op"); assert.deepEqual(b.sourceEventSeqs, [2]);
  assert.equal(b.data.error?.code, "TOOL_NOT_STARTED");
  assert.deepEqual(await reader.read(), [...s.snapshot().events, ...closers]);
  assert.equal((await recoverInterruptedSession(handle)).length, 0);
  assert.equal((await observer.stat("s"))?.eventCount, 11);
});

test("孤立工具结果不能触发任何修复写入", async () => {
  const { recoverInterruptedSession } = await import("./recovery.ts");
  const events: SessionEvent[] = [...start, { seq: 2, time: 3, type: "tool/result", surfaceOp: "append", sourceEventSeqs: [1], data: {
    turn: 1, step: 1, message: { id: "x", role: "user", source: { kind: "tool", callId: "missing" }, content: [{ type: "tool-result", toolCallId: "missing", isError: true, content: [] }] },
  } }];
  let writes = 0;
  const handle: import("./persistence.ts").SessionHandle = {
    id: "s", header: { sessionId: "s", createdAt: 1 }, access: "write", inheritedEventCount: 0,
    async read() { return events; }, async append() { writes++; }, async flush() {}, async close() {},
  };
  await assert.rejects(recoverInterruptedSession(handle)); assert.equal(writes, 0);
});

test("已有操作的持久结果缺少 operationId 时拒绝恢复且保留原前缀", async (t) => {
  const { recoverInterruptedSession } = await import("./recovery.ts");
  const { SqliteSessionPersistence } = await import("./storage/sqlite-persistence.ts");
  const dir = await mkdtemp(join(tmpdir(), "mharness-invalid-operation-"));
  const storage = new SqliteSessionPersistence(join(dir, "events.sqlite"));
  t.after(async () => {
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  });
  const events: SessionEvent[] = [
    ...start,
    { seq: 2, time: 3, type: "assistant/message", surfaceOp: "append", data: {
      turn: 1, step: 1, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true,
      message: { id: "assistant", role: "assistant", source: { provider: "p", model: "m" }, content: [
        { type: "tool-call", id: "a", name: "one", arguments: "{}" },
      ] },
    } },
    { seq: 3, time: 4, type: "tool/call", data: { turn: 1, step: 1, callId: "a", name: "one", arguments: "{}" } },
    { seq: 4, time: 5, type: "tool/operation", data: {
      turn: 1, step: 1, callId: "a", operationId: "op", toolName: "one", toolVersion: "1", validatedArgs: {},
    } },
    { seq: 5, time: 6, type: "tool/result", surfaceOp: "append", sourceEventSeqs: [3], data: {
      turn: 1, step: 1, message: {
        id: "result", role: "user", source: { kind: "tool", callId: "a" }, content: [
          { type: "tool-result", toolCallId: "a", isError: false, content: [] },
        ],
      },
    } },
  ];
  const handle = await storage.create({ sessionId: "s", createdAt: 0 });
  await handle.append(events);
  await assert.rejects(recoverInterruptedSession(handle));
  assert.deepEqual(await handle.read(), events);
});

test("工具结果替换按被替换记录关联，恢复不会重复补结果", () => {
  const result = {
    turn: 1, step: 1,
    message: { id: "result", role: "user", source: { kind: "tool", callId: "a" }, content: [
      { type: "tool-result", toolCallId: "a", isError: false, content: [{ type: "text", text: "内容" }] },
    ] },
  } as const;
  const events: SessionEvent[] = [
    ...start,
    { seq: 2, time: 3, type: "assistant/message", surfaceOp: "append", data: {
      turn: 1, step: 1,
      message: { id: "assistant", role: "assistant", source: { provider: "p", model: "m" }, content: [
        { type: "tool-call", id: "a", name: "one", arguments: "{}" },
      ] },
      finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true,
    } },
    { seq: 3, time: 4, type: "tool/call", data: { turn: 1, step: 1, callId: "a", name: "one", arguments: "{}" } },
    { seq: 4, time: 5, type: "tool/result", surfaceOp: "append", sourceEventSeqs: [3], data: result },
    { seq: 5, time: 6, type: "tool/result", surfaceOp: { op: "replace", start: 4, end: 4 }, sourceEventSeqs: [4], data: result },
  ];
  assert.deepEqual(interruptedTurnClosers(events, 7).map((event) => event.type), ["step/end", "turn/end"]);
});

test("追加失败向调用方传播且不发布修复", async () => {
  const { recoverInterruptedSession } = await import("./recovery.ts");
  const failure = new Error("disk failure");
  let attempts = 0;
  const handle: import("./persistence.ts").SessionHandle = {
    id: "s", header: { sessionId: "s", createdAt: 1 }, access: "write", inheritedEventCount: 0,
    async read() { return start; }, async append() { attempts++; throw failure; }, async flush() {}, async close() {},
  };
  await assert.rejects(recoverInterruptedSession(handle), error => error === failure);
  assert.equal(attempts, 1); assert.equal((await handle.read()).length, 2);
});
