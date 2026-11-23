import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "@mharness/session/server";
import { LlmRuntime } from "../model/runtime.ts";
import { LlmError } from "../model/adapter.ts";
import { SessionWriter } from "../../../../packages/session/src/writer.ts";
import { settleCompactionSummary } from "./settle-compaction-summary.ts";
import { createModelTurnDriver } from "./model-turn.ts";
import { ReActAgent } from "./react-agent.ts";

function fixture(generate: ConstructorParameters<typeof LlmRuntime>[0][string]) {
  const session = new Session({ sessionId: "settlement", createdAt: 1 });
  for (const [id, text] of [["old", "old ".repeat(500)], ["tail", "tail"]]) {
    session.append({ type: "user/message", surfaceOp: "append", data: { id, role: "user", source: { kind: "user" }, turn: 1, requestId: id, content: [{ type: "text", text }] } });
  }
  session.bindCheckpoint(async () => {}, async (_events, finish) => { const result = { status: "committed" } as const; finish(result); return result; });
  const runtime = new LlmRuntime({ mock: generate });
  let open = true;
  const controller = new AbortController();
  return { session, controller, context: { session, turn: null, signal: controller.signal, storageOpen: () => open, blockStorage: () => { open = false; } }, options: { runtime, businessModel: runtime.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 } };
}

test("模型失败写安全终态并保留结构化结论", async () => {
  const failure = { kind: "error", failure: { code: "UNKNOWN", message: "provider secret" } } as const;
  const f = fixture({ async *generate() { yield { type: "finish", reason: failure }; } });
  const result = await settleCompactionSummary(f.context, f.options);
  assert.equal(result.status, "settled");
  assert.equal(result.outcome, "failed");
  assert.equal(result.source.status, "model-not-completed");
  assert.deepEqual(result.original, { present: false });
  const end = f.session.snapshot().events.at(-1);
  assert.equal(end?.type, "compaction/end");
  assert.equal(end.data.status, "failed");
  assert.doesNotMatch(JSON.stringify(end.data.reason), /provider secret/);
});

for (const primary of [new LlmError("UNKNOWN"), undefined]) {
  test(`真实运行时保留 Adapter 抛出的原值 ${primary === undefined ? "undefined" : "LlmError"}`, async () => {
    const f = fixture({ async *generate(): AsyncGenerator<never> { throw primary; } });
    const result = await settleCompactionSummary(f.context, f.options);
    assert.equal(result.status, "settled");
    assert.equal(result.outcome, "failed");
    assert.equal(result.source.status, "model-not-completed");
    assert.equal(result.original.present, true);
    if (result.original.present) assert.ok(Object.is(result.original.value, primary));
  });
}

test("真实运行时的 Adapter 原错与终态写入错误分别保留", async () => {
  const primary = new LlmError("UNKNOWN");
  const storage = new Error("storage failure");
  const f = fixture({ async *generate(): AsyncGenerator<never> { throw primary; } });
  const session = new Session({ sessionId: "adapter-storage-failure", createdAt: 1 });
  for (const event of f.session.snapshot().events) if (event.type === "user/message") session.append({ type: "user/message", surfaceOp: "append", data: event.data });
  let calls = 0;
  session.bindCheckpoint(async () => { if (++calls === 2) throw storage; });
  const result = await settleCompactionSummary({ ...f.context, session }, f.options);
  assert.equal(result.status, "unsettled");
  assert.equal(result.original.present, true);
  if (result.original.present) assert.ok(Object.is(result.original.value, primary));
  assert.ok(Object.is(result.storageFailure?.value, storage));
  assert.doesNotMatch(result.intent?.reason ?? "", /storage failure/);
});

test("开始记录前双故障传播摘要原错并锁存实际存储原因", async () => {
  const f = fixture({ async *generate() { assert.fail("不应启动 Adapter"); } });
  const original = new Error("模型准备失败");
  const storage = new Error("独立存储故障");
  const seen: unknown[] = [];
  let open = true;
  await assert.rejects(settleCompactionSummary({
    ...f.context,
    storageOpen: () => open,
    storageFailure: () => open ? undefined : { value: storage },
    blockStorage: error => { seen.push(error); },
  }, {
    ...f.options,
    runtime: { prepare() { open = false; throw original; } },
  }), error => error === original);
  assert.deepEqual(seen, [storage]);
  assert.equal(f.session.snapshot().events.some(event => event.type === "compaction/start"), false);
});

for (const timing of ["capture", "handoff"] as const) {
  test(`无摘要范围时仍锁存 ${timing} 阶段关闭的存储原因`, async () => {
    const f = fixture({ async *generate() { assert.fail("不应启动 Adapter"); } });
    const storage = new Error("选区检查期间的存储故障");
    const seen: unknown[] = [];
    let open = true;
    const shutGate = () => { open = false; };
    await assert.rejects(settleCompactionSummary({
      ...f.context,
      storageOpen: () => open,
      storageFailure: () => open ? undefined : { value: storage },
      blockStorage: error => { seen.push(error); },
    }, {
      ...f.options,
      retainTokens: Number.MAX_SAFE_INTEGER,
      businessModel: { ...f.options.businessModel, includesAssistantReasoning() {
        if (timing === "capture") shutGate();
        else queueMicrotask(shutGate);
        return true;
      } },
    }), error => error === storage);
    assert.deepEqual(seen, [storage]);
    assert.equal(f.session.snapshot().events.some(event => event.type === "compaction/start"), false);
  });
}

test("真实运行时外部门先关闭时不把 Adapter 原错当作存储故障", async () => {
  const primary = new LlmError("UNKNOWN");
  let open = true;
  const reports: unknown[] = [];
  const f = fixture({ async *generate(): AsyncGenerator<never> { open = false; throw primary; } });
  const result = await settleCompactionSummary({ ...f.context, storageOpen: () => open, blockStorage: (error) => reports.push(error) }, f.options);
  assert.equal(result.status, "unsettled");
  assert.equal(result.original.present, true);
  if (result.original.present) assert.ok(Object.is(result.original.value, primary));
  assert.equal(result.intent?.original.present, true);
  if (result.intent?.original.present) assert.ok(Object.is(result.intent.original.value, primary));
  assert.ok(result.storageFailure?.value instanceof Error);
  assert.equal(result.storageFailure.value.message, "storage_blocked");
  assert.equal(reports[0], result.storageFailure.value);
});

const hostile = new Error("private");
Object.defineProperty(hostile, "name", { get() { throw new Error("name getter"); } });
const revoked = Proxy.revocable({}, {});
revoked.revoke();
const hostileDiagnostics = new LlmError("TRANSPORT", { get httpStatus(): number { throw new Error("diagnostics getter"); } });
for (const [label, primary] of [["name getter", hostile], ["revoked proxy", revoked.proxy], ["diagnostics getter", hostileDiagnostics]] as const) {
  test(`真实运行时保留无法安全归一化的 Adapter 原值 ${label}`, async () => {
    const f = fixture({ async *generate(): AsyncGenerator<never> { throw primary; } });
    const result = await settleCompactionSummary(f.context, f.options);
    assert.equal(result.status, "settled");
    assert.equal(result.outcome, "failed");
    assert.equal(result.source.status, "model-not-completed");
    if (result.source.status === "model-not-completed") assert.deepEqual(result.source.finishReason, new LlmError("UNKNOWN").toFinishReason());
    assert.equal(result.original.present, true);
    if (result.original.present) assert.ok(Object.is(result.original.value, primary));
  });
}

test("真实运行时保留 Adapter 抛出的 ABORTED 原值", async () => {
  const primary = new LlmError("ABORTED");
  const f = fixture({ async *generate(): AsyncGenerator<never> { throw primary; } });
  const result = await settleCompactionSummary(f.context, f.options);
  assert.equal(result.status, "settled");
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.original.present, true);
  if (result.original.present) assert.ok(Object.is(result.original.value, primary));
});

for (const terminal of [new LlmError("UNKNOWN").toFinishReason(), { kind: "aborted" } as const]) {
  test(`真实运行时清理异常不覆盖已观察的 ${terminal.kind} 终态`, async () => {
    const f = fixture({ async *generate() { try { yield { type: "finish", reason: terminal }; } finally { throw new Error("cleanup"); } } });
    const result = await settleCompactionSummary(f.context, f.options);
    assert.equal(result.status, "settled");
    assert.equal(result.outcome, terminal.kind === "aborted" ? "cancelled" : "failed");
    assert.deepEqual(result.original, { present: false });
    assert.equal(result.source.status, "model-not-completed");
    if (result.source.status === "model-not-completed") assert.equal(result.source.finishReason, terminal);
  });
}

test("Adapter 已交付失败终态时，迟到取消不覆盖失败", async () => {
  const failure = new LlmError("UNKNOWN").toFinishReason();
  let deliver: (value: IteratorResult<{ type: "finish"; reason: typeof failure }>) => void = () => assert.fail();
  let ready: () => void = () => assert.fail();
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const f = fixture({
    generate() {
      return { [Symbol.asyncIterator]() {
        return {
          next() {
            return new Promise<IteratorResult<{ type: "finish"; reason: typeof failure }>>(resolve => {
              deliver = resolve;
              ready();
            });
          },
          async return() { return { done: true, value: undefined } as const; },
        };
      } };
    },
  });
  const pending = settleCompactionSummary(f.context, f.options);
  await entered;
  deliver({ done: false, value: { type: "finish", reason: failure } });
  f.controller.abort("迟到取消");
  const settled = await pending;
  assert.equal(settled.status, "settled");
  assert.equal(settled.outcome, "failed");
  assert.equal(settled.source.status, "model-not-completed");
  assert.equal(settled.source.finishReason, failure);
});

test("清理期间迟到取消不能覆盖已观察模型失败", async () => {
  let entered!: () => void;
  let release!: () => void;
  const entering = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const failure = new LlmError("UNKNOWN").toFinishReason();
  const f = fixture({ async *generate() { try { yield { type: "finish", reason: failure }; } finally { entered(); await waiting; } } });
  const work = settleCompactionSummary(f.context, f.options);
  await entering;
  f.controller.abort("late");
  release();
  const result = await work;
  assert.equal(result.status, "settled");
  assert.equal(result.outcome, "failed");
  assert.equal(result.source.status, "model-not-completed");
  if (result.source.status === "model-not-completed") assert.equal(result.source.finishReason, failure);
});

test("生成抛出 undefined 与无原错的领域拒绝可区分", async () => {
  const f = fixture({ async *generate() { yield { type: "finish", reason: { kind: "stop" } }; } });
  const direct = { ...f.options.businessModel, async *generate(): AsyncGenerator<never> { throw undefined; } };
  const result = await settleCompactionSummary(f.context, { ...f.options, runtime: { prepare: () => direct } });
  assert.equal(result.status, "settled");
  assert.equal(result.outcome, "failed");
  assert.deepEqual(result.original, { present: true, value: undefined });
  assert.equal(result.source.status, "generation-failed");
});

test("外部门关闭时交接相同意图并锁存本次上下文", async () => {
  let close!: () => void;
  const f = fixture({ async *generate() { close(); yield { type: "finish", reason: { kind: "error", failure: { code: "UNKNOWN", message: "secret" } } }; } });
  let open = true;
  const reports: unknown[] = [];
  close = () => { open = false; };
  const result = await settleCompactionSummary({ ...f.context, storageOpen: () => open, blockStorage: (error) => reports.push(error) }, f.options);
  assert.equal(result.status, "unsettled");
  assert.equal(result.intent?.outcome, "failed");
  assert.equal(reports.length, 1);
  assert.equal(f.session.snapshot().events.filter((event) => event.type === "compaction/end").length, 0);
});

test("终态端口回滚时分别保留原始异常和存储异常", async () => {
  const primary = { private: "primary" };
  const storage = { private: "storage" };
  const session = new Session({ sessionId: "rollback", createdAt: 1 });
  for (const [id, text] of [["old", "old ".repeat(500)], ["tail", "tail"]]) session.append({ type: "user/message", surfaceOp: "append", data: { id, role: "user", source: { kind: "user" }, turn: 1, requestId: id, content: [{ type: "text", text }] } });
  let calls = 0;
  session.bindCheckpoint(async () => { if (++calls === 2) throw storage; });
  const runtime = new LlmRuntime({ mock: { async *generate() {} } });
  const businessModel = runtime.prepare({ provider: "mock", model: "m" });
  const direct = { ...businessModel, async *generate(): AsyncGenerator<never> { throw primary; } };
  let open = true;
  const result = await settleCompactionSummary({ session, turn: null, signal: new AbortController().signal, storageOpen: () => open, blockStorage: () => { open = false; } }, { runtime: { prepare: () => direct }, businessModel, businessTools: [], retainTokens: 0 });
  assert.equal(result.status, "unsettled");
  assert.deepEqual(result.original, { present: true, value: primary });
  assert.equal(result.storageFailure?.value, storage);
  assert.equal(result.intent, undefined);
  assert.equal(calls, 2);
});

test("直接模型的失败终态先于清理异常及迟到取消", async () => {
  const failure = { kind: "error", failure: { code: "UNKNOWN", message: "original" } } as const;
  const f = fixture({ async *generate() {} });
  const direct = { ...f.options.businessModel, async *generate() { try { yield { type: "finish" as const, reason: failure }; } finally { f.controller.abort("late"); throw new Error("cleanup"); } } };
  const result = await settleCompactionSummary(f.context, { ...f.options, runtime: { prepare: () => direct } });
  assert.equal(result.status, "settled");
  assert.equal(result.outcome, "failed");
  assert.equal(result.source.status, "model-not-completed");
  if (result.source.status === "model-not-completed") assert.equal(result.source.finishReason, failure);
});

test("真实写入器确认失败终态且不持久化原始异常", async () => {
  const session = new Session({ sessionId: "writer", createdAt: 1 });
  for (const [id, text] of [["old", "old ".repeat(500)], ["tail", "tail"]]) session.append({ type: "user/message", surfaceOp: "append", data: { id, role: "user", source: { kind: "user" }, turn: 1, requestId: id, content: [{ type: "text", text }] } });
  const records = [...session.snapshot().events];
  const writer = new SessionWriter(session, { append: async (events) => { records.push(...events); }, flush: async () => {}, read: async () => records, commitStaged: async (events) => { records.push(...events); return { status: "committed" }; }, reconcileStaged: async () => { throw new Error("unexpected"); } }, () => assert.fail());
  try {
    const runtime = new LlmRuntime({ mock: { async *generate() { yield { type: "finish", reason: { kind: "error", failure: { code: "UNKNOWN", message: "private provider error" } } }; } } });
    const result = await settleCompactionSummary({ session, turn: null, signal: new AbortController().signal, storageOpen: () => true, blockStorage: () => assert.fail() }, { runtime, businessModel: runtime.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 });
    assert.equal(result.status, "settled");
    assert.equal(result.outcome, "failed");
    assert.deepEqual(records.map((event) => event.type), ["user/message", "user/message", "compaction/start", "compaction/end"]);
    assert.doesNotMatch(JSON.stringify(records), /private provider error/);
  } finally { await writer.close(); }
});

test("start 已确认后本地取消保留原值且不启动模型", async () => {
  const f = fixture({ async *generate() { assert.fail("不能调用模型"); } });
  const session = new Session({ sessionId: "cancel", createdAt: 1 });
  for (const event of f.session.snapshot().events) {
    if (event.type === "user/message") session.append({ type: "user/message", surfaceOp: "append", data: event.data });
  }
  const reason = { detail: "private cancellation" };
  let calls = 0;
  session.bindCheckpoint(async () => { if (++calls === 1) f.controller.abort(reason); });
  const result = await settleCompactionSummary({ ...f.context, session }, f.options);
  assert.equal(result.status, "settled");
  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(result.original, { present: true, value: reason });
  assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify(session.snapshot().events), /private cancellation/);
});

test("start 检查点失败时保留原值且不调用模型或写终态", async () => {
  let generated = 0;
  const f = fixture({ async *generate() { generated++; yield { type: "finish", reason: { kind: "stop" } }; } });
  const session = new Session({ sessionId: "start-checkpoint", createdAt: 1 });
  for (const event of f.session.snapshot().events) {
    if (event.type === "user/message") session.append({ type: "user/message", surfaceOp: "append", data: event.data });
  }
  const failure = new Error("start checkpoint");
  session.bindCheckpoint(async () => { throw failure; });
  const result = await settleCompactionSummary({ ...f.context, session }, f.options);
  assert.equal(result.status, "unsettled");
  assert.deepEqual(result.original, { present: true, value: failure });
  assert.equal(result.storageFailure?.value, failure);
  assert.equal(result.intent, undefined);
  assert.equal(generated, 0);
  assert.deepEqual(session.snapshot().events.slice(2).map(e => e.type), ["compaction/start"]);
});

test("明确模型取消在清理期间迟到取消前固定来源", async () => {
  let entered!: () => void;
  let release!: () => void;
  const entering = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture({ async *generate() { try { yield { type: "finish", reason: { kind: "aborted" } }; } finally { entered(); await waiting; } } });
  const work = settleCompactionSummary(f.context, f.options);
  await entering;
  f.controller.abort({ late: true });
  release();
  const result = await work;
  assert.equal(result.status, "settled");
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.source.status, "model-not-completed");
  if (result.source.status === "model-not-completed") assert.deepEqual(result.source.cancellation, { present: false, value: undefined });
});

test("成功批次已接收后取消，确认提交的成功优先", async () => {
  const f = fixture({ async *generate() {
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "short" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "short" } };
    yield { type: "finish", reason: { kind: "stop" } };
  } });
  const session = new Session({ sessionId: "success", createdAt: 1 });
  for (const event of f.session.snapshot().events) if (event.type === "user/message") session.append({ type: "user/message", surfaceOp: "append", data: event.data });
  let calls = 0;
  session.bindCheckpoint(async () => { if (++calls === 2) f.controller.abort("late"); });
  const result = await settleCompactionSummary({ ...f.context, session }, f.options);
  assert.equal(result.status, "settled");
  assert.equal(result.outcome, "succeeded");
  assert.equal(calls, 2);
  const ends = session.snapshot().events.filter((event) => event.type === "compaction/end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0]?.data.status, "succeeded");
});

test("真实 Turn 中外部门关闭后普通 flush 不解除 hook 锁存", { timeout: 8000 }, async (t) => {
  const session = new Session({ sessionId: "external-gate", createdAt: 1 });
  session.append({ type: "user/message", surfaceOp: "append", data: { id: "old", role: "user", source: { kind: "user" }, turn: 77, requestId: "old", content: [{ type: "text", text: "old ".repeat(500) }] } });
  const records = [...session.snapshot().events];
  const handle = { id: session.header.sessionId, header: session.header, access: "write" as const, inheritedEventCount: 0, read: async () => records, append: async (events: typeof records) => { records.push(...events); }, flush: async () => {}, close: async () => {}, commitStaged: async (events: readonly (typeof records)[number][]) => { records.push(...events); return { status: "committed" as const }; }, reconcileStaged: async () => { throw new Error("unexpected"); } };
  const writer = new SessionWriter(session, handle);
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let businessCalls = 0;
  const business = new LlmRuntime({ mock: { async *generate() { businessCalls++; yield { type: "finish", reason: { kind: "stop" } }; } } });
  const summary = new LlmRuntime({ mock: { async *generate() { entered(); await gate; yield { type: "block-start", index: 0, blockType: "text" }; yield { type: "text-delta", index: 0, text: "short" }; yield { type: "block-end", index: 0, block: { type: "text", text: "short" } }; yield { type: "finish", reason: { kind: "stop" } }; } } });
  let hookError: unknown;
  let driverError: unknown;
  const driver = createModelTurnDriver({ runtime: business, config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", preStep: async (context) => {
    const result = await settleCompactionSummary(context, { runtime: summary, businessModel: summary.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 });
    assert.equal(result.status, "unsettled");
    assert.equal(result.source.status, "success-commit-failed");
    hookError = result.storageFailure?.value;
    await context.session.flush();
    context.blockStorage(new Error("later hook failure"));
  } });
  const agent = new ReActAgent(session, async (context) => { try { await driver(context); } catch (error) { driverError = error; throw error; } }, handle);
  t.after(async () => { release(); await agent.waitForIdle(); await writer.close(); await agent.stop(); });
  const append = t.mock.method(session, "append");
  const first = new Error("first external fault");
  agent.prompt({ requestId: "r", content: [{ type: "text", text: "tail" }] });
  await waiting;
  assert.equal(session.snapshot().events.filter((event) => event.type === "compaction/start").length, 1);
  agent.blockStorage(first);
  release();
  await agent.waitForIdle();
  assert.ok(hookError instanceof Error);
  assert.equal(driverError, hookError);
  assert.equal(businessCalls, 0);
  assert.deepEqual(append.mock.calls.map(({ arguments: [input] }) => input.type).filter((type) => type === "step/start" || type === "step/end" || type === "turn/end"), []);
  assert.equal(session.snapshot().events.some((event) => event.type === "compaction/summary" || event.type === "compaction/end"), false);
  assert.throws(() => agent.prompt({ requestId: "next", content: [{ type: "text", text: "next" }] }), (error) => error instanceof Error && error.cause === first);
  assert.deepEqual(records, session.snapshot().events);
});

test("手动固定压缩 ID 不可重复使用已有终态的身份", async () => {
  let calls = 0;
  const f = fixture({ async *generate() { calls++; yield { type: "finish", reason: { kind: "error", failure: { code: "UNKNOWN", message: "failed" } } }; } });
  const context = { ...f.context, identity: { compactionId: "fixed", sourceCommandId: "command" } };
  const first = await settleCompactionSummary(context, f.options);
  assert.equal(first.status, "settled");
  await assert.rejects(settleCompactionSummary(context, f.options));
  assert.equal(calls, 1);
  assert.equal(f.session.snapshot().events.filter((event) => event.type === "compaction/end").length, 1);
});

test("普通生成异常后的迟到取消不改变失败意图", async () => {
  const primary = { failure: "primary" };
  const f = fixture({ async *generate() {} });
  const direct = { ...f.options.businessModel, async *generate(): AsyncGenerator<never> { try { throw primary; } finally { f.controller.abort("late"); } } };
  const result = await settleCompactionSummary(f.context, { ...f.options, runtime: { prepare: () => direct } });
  assert.equal(result.status, "settled");
  assert.equal(result.outcome, "failed");
  assert.deepEqual(result.original, { present: true, value: primary });
  const end = f.session.snapshot().events.at(-1);
  assert.equal(end?.type, "compaction/end");
  assert.equal(end.data.status, "failed");
});
