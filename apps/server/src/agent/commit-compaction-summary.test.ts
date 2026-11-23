import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "@mharness/session/server";
import { LlmRuntime, type ModelConfig } from "../model/runtime.ts";
import type { ModelRequest, StreamChunk } from "../model/adapter.ts";
import { commitCompactionSummary } from "./commit-compaction-summary.ts";
import { SessionWriter } from "../../../../packages/session/src/writer.ts";
import { createDeepSeekAdapter } from "../model/providers/deepseek.ts";
import { LlmError } from "../model/adapter.ts";
import { estimateSurfaceMessageTokens } from "../model/token-meter.ts";
import { acceptCompactionSummary } from "./compaction-summary.ts";

function fixture() {
  const session = new Session({ sessionId: "service", createdAt: 1 });
  for (const [id, text] of [["old", "old context ".repeat(500)], ["tail", "tail marker"]]) {
    session.append({ type: "user/message", surfaceOp: "append", data: { id, role: "user", source: { kind: "user" }, turn: 1, requestId: id, content: [{ type: "text", text }] } });
  }
  let open = true;
  const context = { session, turn: null, signal: new AbortController().signal, storageOpen: () => open, blockStorage: () => { open = false; } };
  return { session, context, isOpen: () => open };
}

function model(chunks: readonly StreamChunk[], onRequest: (request: ModelRequest) => void = () => {}) {
  return new LlmRuntime({ mock: { async *generate(request) { onRequest(request); yield* chunks; } } });
}

const output: readonly StreamChunk[] = [
  { type: "block-start", index: 0, blockType: "text" },
  { type: "text-delta", index: 0, text: "short" },
  { type: "block-end", index: 0, block: { type: "text", text: "short" } },
  { type: "finish", reason: { kind: "stop" } },
];

test("固定业务路由并原子提交摘要、检查点和终态", async () => {
  const { session, context } = fixture();
  const batches: string[][] = [];
  session.bindCheckpoint(async () => {}, undefined, events => { batches.push(events.map(event => event.type)); });
  let request: ModelRequest | undefined;
  const runtime = model(output, (value) => { request = value; });
  const businessModel = runtime.prepare({ provider: "mock", model: "m", endpointId: "fixed", params: { reasoningEffort: "high", stop: ["secret"] } });
  let config: ModelConfig | undefined;
  const result = await commitCompactionSummary(context, { runtime: { prepare: (value) => { config = value; return runtime.prepare(value); } }, businessModel, businessTools: [{ name: "secret-tool", inputSchema: {} }], retainTokens: 0, disableReasoningEffort: "none" });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(config, { provider: "mock", model: "m", endpointId: "fixed", params: { maxOutputTokens: 8192, reasoningEffort: "none" } });
  assert.deepEqual(batches, [["compaction/start"], ["compaction/summary", "user/message", "compaction/end"]]);
  assert.ok(request);
  assert.deepEqual(request.tools, []);
  assert.doesNotMatch(JSON.stringify(request.messages), /tail marker|secret-tool/);
  const events = session.snapshot().events;
  assert.equal(events[result.summarySeq]?.type, "compaction/summary");
  const checkpoint = events[result.summarySeq + 1];
  assert.ok(checkpoint?.type === "user/message");
  assert.deepEqual(checkpoint.sourceEventSeqs, [result.summarySeq, 0]);
  assert.equal(session.deriveSurfaceNodes().at(-1)?.seq, 1);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const side of ["start", "success"] as const) {
  test(`后台普通写入失败后 ${side} 不得越过关闭的准入`, async () => {
    const { session, context } = fixture();
    const entered = deferred();
    const release = deferred();
    const fault = new Error("后台写入失败");
    const reports: unknown[] = [];
    const records = [...session.snapshot().events];
    let calls = 0;
    let writes = 0;
    let generated = 0;
    const writer = new SessionWriter(session, {
      append: async (events) => {
        if (++writes === (side === "start" ? 1 : 2)) { entered.resolve(); await release.promise; throw fault; }
        records.push(...events);
      },
      flush: async () => {},
      read: async () => records,
      commitStaged: async (events) => { calls++; records.push(...events); return { status: "committed" }; },
      reconcileStaged: async () => { throw new Error("unexpected reconciliation"); },
    }, (error) => { reports.push(error); context.blockStorage(); });
    const append = () => session.append({ type: "turn/start", data: { turn: 2 } });
    const runtime = new LlmRuntime({ mock: { async *generate() {
      generated++;
      if (side === "success") { append(); await entered.promise; }
      yield* output;
    } } });
    try {
      if (side === "start") { append(); await entered.promise; }
      const work = commitCompactionSummary(context, { runtime, businessModel: runtime.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 });
      if (side === "success") await entered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      release.resolve();
      const result = await work;
      assert.equal(result.status, "commit-checkpoint-failed");
      assert.equal(result.side, side);
      assert.equal(calls, 0);
      assert.equal(generated, side === "start" ? 0 : 1);
      assert.deepEqual(reports, [fault]);
      assert.equal(session.snapshot().events.some(event => event.type === "compaction/summary"), side === "success");
    } finally { release.resolve(); await writer.close(); }
  });
}

test("没有安全前缀时不准备模型或写入 start", async () => {
  const session = new Session({ sessionId: "empty", createdAt: 1 });
  const runtime = model(output);
  const businessModel = runtime.prepare({ provider: "mock", model: "m" });
  const result = await commitCompactionSummary({ session, turn: null, signal: new AbortController().signal, storageOpen: () => true, blockStorage: () => {} }, {
    runtime: { prepare: () => { assert.fail("不应准备模型"); } }, businessModel, businessTools: [], retainTokens: 0,
  });
  assert.deepEqual(result, { status: "no-range" });
  assert.equal(session.snapshot().events.length, 0);
});

for (const side of ["start", "success"] as const) {
  test(`${side} 检查点失败保留原错误、已接受批次及身份`, async () => {
    const { session, context, isOpen } = fixture();
    const fault = new Error(side);
    let calls = 0;
    let generated = 0;
    session.bindCheckpoint(async () => { if (++calls === (side === "start" ? 1 : 2)) throw fault; });
    const runtime = model(output, () => { generated++; });
    const result = await commitCompactionSummary(context, { runtime, businessModel: runtime.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 });
    assert.equal(result.status, "commit-checkpoint-failed");
    assert.equal(result.side, side);
    assert.equal(result.error, fault);
    assert.equal(isOpen(), false);
    assert.equal(generated, side === "start" ? 0 : 1);
    assert.equal(session.snapshot().events.filter(event => event.type === "compaction/end").length, side === "start" ? 0 : 1);
  });
}

test("DeepSeek 实际请求关闭推理并排除业务工具及停止序列", async () => {
  const { session, context } = fixture();
  session.bindCheckpoint(async () => {}, async (_events, finish) => { const result = { status: "committed" } as const; finish(result); return result; });
  const bodies: Record<string, unknown>[] = [];
  const runtime = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "fake", fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response('data: {"choices":[{"delta":{"content":"short"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  } }) });
  const businessModel = runtime.prepare({ provider: "deepseek", model: "deepseek-v4-pro", params: { reasoningEffort: "high", stop: ["private"] } });
  const result = await commitCompactionSummary(context, { runtime, businessModel, businessTools: [{ name: "private", inputSchema: {} }], retainTokens: 0, disableReasoningEffort: "none" });
  assert.equal(result.status, "succeeded");
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0]?.thinking, { type: "disabled" });
  assert.equal(bodies[0]?.max_tokens, 8192);
  assert.equal("tools" in bodies[0]!, false);
  assert.equal("stop" in bodies[0]!, false);
});

for (const delta of [0, 4] as const) {
  test(`DeepSeek 业务工具和推理决定摘要${delta === 0 ? "等大拒绝" : "缩小接受"}`, async () => {
    const runtime = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "fake", fetch: async () =>
      new Response('data: {"choices":[{"delta":{"content":"short"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') }) });
    const businessModel = runtime.prepare({ provider: "deepseek", model: "deepseek-v4-pro", params: { reasoningEffort: "high" } });
    const summaryModel = runtime.prepare({ provider: "deepseek", model: "deepseek-v4-pro", params: { reasoningEffort: "none" } });
    const tools = [{ name: "read", inputSchema: {} }];
    const weight = (message: Parameters<typeof estimateSurfaceMessageTokens>[1]) => estimateSurfaceMessageTokens(businessModel, message, tools);
    const candidate = acceptCompactionSummary({ nodes: [], shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [], shadowedTokens: 1_000_000 }, { finishReason: { kind: "stop" }, blocks: [{ type: "text", text: "short" }] }, { messageId: "candidate", compactionId: "c" }, weight);
    assert.equal(candidate.status, "accepted");
    const target = weight(candidate.message);
    const session = new Session({ sessionId: `reasoning-${delta}`, createdAt: 1 });
    const assistant = session.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "assistant", role: "assistant", source: { provider: "deepseek", model: "deepseek-v4-pro" }, content: [{ type: "reasoning", text: "r".repeat((target - 8) * 4 + delta) }] }, finishReason: { kind: "stop" }, stream: [], includeInModelContext: true } });
    session.append({ type: "user/message", surfaceOp: "append", data: { id: "tail", role: "user", source: { kind: "user" }, turn: 2, requestId: "tail", content: [{ type: "text", text: "tail" }] } });
    assert.equal(weight(assistant.data.message), target + delta / 4);
    assert.ok(estimateSurfaceMessageTokens(businessModel, assistant.data.message, []) < target);
    assert.ok(estimateSurfaceMessageTokens(summaryModel, assistant.data.message, tools) < target);
    session.bindCheckpoint(async () => {}, async (_events, finish) => { const result = { status: "committed" } as const; finish(result); return result; });
    const result = await commitCompactionSummary({ session, turn: null, signal: new AbortController().signal, storageOpen: () => true, blockStorage: () => {} }, { runtime, businessModel, businessTools: tools, retainTokens: 0, disableReasoningEffort: "none" });
    if (delta === 0) { assert.equal(result.status, "rejected"); assert.equal(result.reason, "not-smaller"); }
    else assert.equal(result.status, "succeeded");
  });
}

test("固定路由解析器在外部配置切换后仍使用原连接", async () => {
  const { session, context } = fixture();
  session.bindCheckpoint(async () => {}, async (_events, finish) => { const result = { status: "committed" } as const; finish(result); return result; });
  const requests: ModelRequest[] = [];
  const runtimeA = model(output, (request) => requests.push(request));
  const runtimeB = model(output, () => assert.fail("不应使用切换后的连接"));
  let current = { runtime: runtimeA, config: { provider: "mock", model: "model-a", endpointId: "endpoint-a" } };
  const fixed = current;
  const businessModel = fixed.runtime.prepare(fixed.config);
  current = { runtime: runtimeB, config: { provider: "mock", model: "model-b", endpointId: "endpoint-b" } };
  assert.equal(current.config.model, "model-b");
  const result = await commitCompactionSummary(context, { runtime: fixed.runtime, businessModel, businessTools: [], retainTokens: 0 });
  assert.equal(result.status, "succeeded");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.route, businessModel.route);
  const summary = session.snapshot().events[result.summarySeq];
  assert.ok(summary?.type === "compaction/summary");
  assert.deepEqual(summary.data.route, { provider: "mock", model: "model-a", endpointId: "endpoint-a" });
});

test("第二次摘要选中已提交 checkpoint 并要求更新先前摘要", async () => {
  const { session, context } = fixture();
  session.bindCheckpoint(async () => {}, async (_events, finish) => { const result = { status: "committed" } as const; finish(result); return result; });
  const requests: ModelRequest[] = [];
  const runtime = model(output, (request) => requests.push(request));
  const options = { runtime, businessModel: runtime.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 };
  const first = await commitCompactionSummary(context, options);
  assert.equal(first.status, "succeeded");
  const prior = session.deriveSurfaceNodes()[0];
  assert.ok(prior?.type === "user/message" && prior.data.source.kind === "compact");
  session.append({ type: "user/message", surfaceOp: "append", data: { id: "new-tail", role: "user", source: { kind: "user" }, turn: 2, requestId: "new-tail", content: [{ type: "text", text: "NEW_TAIL" }] } });
  const second = await commitCompactionSummary(context, options);
  assert.equal(second.status, "succeeded");
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1]?.messages), /<compacted-summary>.*short/);
  assert.doesNotMatch(JSON.stringify(requests[1]?.messages), /NEW_TAIL|old context/);
  assert.match(requests[1]?.systemPrompt ?? "", /PRIOR checkpoint/);
  const summary = session.snapshot().events[second.summarySeq];
  assert.ok(summary?.type === "compaction/summary");
  assert.ok(summary.data.shadowedSeqs.includes(prior.seq));
});

test("不同 Step 重用 callId 时选区和尾部各自保持工具配对", async () => {
  const session = new Session({ sessionId: "reused-call", createdAt: 1 });
  session.append({ type: "turn/start", data: { turn: 1 } });
  const groups = [];
  for (const step of [1, 2]) {
    session.append({ type: "step/start", data: { turn: 1, step } });
    const declaration = session.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step, message: { id: `assistant-${step}`, role: "assistant", source: { provider: "mock", model: "m" }, content: [{ type: "text", text: step === 1 ? "OLD_GROUP".repeat(500) : "TAIL_GROUP" }, { type: "tool-call", id: "same-call", name: "read", arguments: `{\"step\":${step}}` }] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true } });
    const call = session.append({ type: "tool/call", data: { turn: 1, step, callId: "same-call", name: "read", arguments: `{\"step\":${step}}` } });
    const result = session.append({ type: "tool/result", surfaceOp: "append", sourceEventSeqs: [call.seq], data: { turn: 1, step, message: { id: `result-${step}`, role: "user", source: { kind: "tool", callId: "same-call" }, content: [{ type: "tool-result", toolCallId: "same-call", isError: false, content: [`RESULT_${step}`] }] } } });
    session.append({ type: "step/end", data: { turn: 1, step } });
    groups.push({ declaration, result });
  }
  session.append({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  session.bindCheckpoint(async () => {}, async (_events, finish) => { const result = { status: "committed" } as const; finish(result); return result; });
  let request: ModelRequest | undefined;
  const runtime = model(output, (value) => { request = value; });
  const result = await commitCompactionSummary({ session, turn: null, signal: new AbortController().signal, storageOpen: () => true, blockStorage: () => {} }, { runtime, businessModel: runtime.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 });
  assert.equal(result.status, "succeeded");
  assert.match(JSON.stringify(request?.messages), /OLD_GROUP/);
  assert.match(JSON.stringify(request?.messages), /RESULT_1/);
  assert.doesNotMatch(JSON.stringify(request?.messages), /TAIL_GROUP|RESULT_2/);
  const summary = session.snapshot().events[result.summarySeq];
  assert.ok(summary?.type === "compaction/summary");
  assert.deepEqual(summary.data.shadowedSeqs, [groups[0]!.declaration.seq, groups[0]!.result.seq]);
  assert.deepEqual(session.deriveSurfaceNodes().slice(-2).map((node) => node.seq), [groups[1]!.declaration.seq, groups[1]!.result.seq]);
});

test("已确认 start 后保留生成异常与结构化模型错误", async () => {
  for (const kind of ["throw", "finish"] as const) {
    const { session, context } = fixture();
    session.bindCheckpoint(async () => {}, async (_events, finish) => { const result = { status: "committed" } as const; finish(result); return result; });
    const runtime = model(output);
    const businessModel = runtime.prepare({ provider: "mock", model: "m" });
    const fault = new Error("original generation error");
    const failure = new LlmError("CONTEXT_WINDOW_EXCEEDED").toFinishReason();
    const result = await commitCompactionSummary(context, { runtime: { prepare: () => ({ ...businessModel, async *generate() { if (kind === "throw") throw fault; yield { type: "finish", reason: failure }; } }) }, businessModel, businessTools: [], retainTokens: 0 });
    if (kind === "throw") { assert.equal(result.status, "generation-failed"); assert.equal(result.error, fault); }
    else { assert.equal(result.status, "model-not-completed"); assert.equal(result.finishReason, failure); }
    assert.ok(result.attempt.compactionId);
  }
});

test("接受计量异常保留原身份及错误，不提交成功批次", async () => {
  const { session, context, isOpen } = fixture();
  let commits = 0;
  session.bindCheckpoint(async () => { commits++; });
  const runtime = model(output);
  const prepared = runtime.prepare({ provider: "mock", model: "m" });
  const fault = new Error("meter");
  let weights = 0;
  const businessModel = { ...prepared, includesAssistantReasoning: () => { if (++weights === 3) throw fault; return true; } };
  const result = await commitCompactionSummary(context, { runtime, businessModel, businessTools: [], retainTokens: 0 });
  assert.equal(result.status, "acceptance-failed");
  assert.equal(result.error, fault);
  assert.ok(result.attempt.compactionId);
  assert.equal(commits, 1);
  assert.equal(isOpen(), true);
});

test("选区中间节点被替换即使两端不变也不能提交", async () => {
  const session = new Session({ sessionId: "middle", createdAt: 1 });
  for (const id of ["first", "middle", "last", "tail"]) session.append({ type: "user/message", surfaceOp: "append", data: { id, role: "user", source: { kind: "user" }, turn: 1, requestId: id, content: [{ type: "text", text: id.repeat(1000) }] } });
  session.bindCheckpoint(async () => {}, async (_events, finish) => { const result = { status: "committed" } as const; finish(result); return result; });
  const entered = deferred();
  const release = deferred();
  const runtime = new LlmRuntime({ mock: { async *generate() { entered.resolve(); await release.promise; yield* output; } } });
  const context = { session, turn: null, signal: new AbortController().signal, storageOpen: () => true, blockStorage: () => {} };
  const task = commitCompactionSummary(context, { runtime, businessModel: runtime.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 });
  await entered.promise;
  session.append({ type: "user/message", surfaceOp: { op: "replace", start: 1, end: 1 }, sourceEventSeqs: [1], data: { id: "changed", role: "user", source: { kind: "compact", compactionId: "other" }, content: [{ type: "text", text: "changed" }] } });
  release.resolve();
  assert.equal((await task).status, "selection-changed");
  assert.equal(session.deriveSurfaceNodes()[0]?.seq, 0);
  assert.equal(session.deriveSurfaceNodes()[2]?.seq, 2);
});

test("生成期间工具来源变化不改变业务计量，完整包装过大时拒绝", async () => {
  const { session, context } = fixture();
  session.bindCheckpoint(async () => {}, async (_events, finish) => { const result = { status: "committed" } as const; finish(result); return result; });
  const entered = deferred();
  const release = deferred();
  const runtime = new LlmRuntime({ mock: { async *generate() { entered.resolve(); await release.promise; yield { type: "block-start", index: 0, blockType: "text" }; yield { type: "block-end", index: 0, block: { type: "text", text: "x".repeat(6000) } }; yield { type: "finish", reason: { kind: "stop" } }; } } });
  const observed: string[][] = [];
  const prepared = runtime.prepare({ provider: "mock", model: "m" });
  const businessModel = { ...prepared, includesAssistantReasoning: (tools: readonly { name: string }[]) => { observed.push(tools.map((tool) => tool.name)); return true; } };
  const businessTools = [{ name: "original", inputSchema: {} }];
  const task = commitCompactionSummary(context, { runtime, businessModel, businessTools, retainTokens: 0 });
  await entered.promise;
  businessTools[0]!.name = "changed";
  release.resolve();
  const result = await task;
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "not-smaller");
  assert.ok(observed.length >= 3);
  assert.ok(observed.every((names) => names.join() === "original"));
});

for (const delta of [0, 4] as const) {
  test(`完整包装${delta === 0 ? "等大时拒绝" : "严格更小时接受"}`, async () => {
    const runtime = model(output);
    const businessModel = runtime.prepare({ provider: "mock", model: "m" });
    const tools = [{ name: "business", inputSchema: {} }];
    const weight = (message: Parameters<typeof estimateSurfaceMessageTokens>[1]) => estimateSurfaceMessageTokens(businessModel, message, tools);
    const accepted = acceptCompactionSummary({ nodes: [], shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [], shadowedTokens: 1_000_000 }, { finishReason: { kind: "stop" }, blocks: [{ type: "text", text: "short" }] }, { messageId: "candidate", compactionId: "c" }, weight);
    assert.equal(accepted.status, "accepted");
    const target = weight(accepted.message);
    const oldLength = (target - 8) * 4 + delta;
    const session = new Session({ sessionId: `boundary-${delta}`, createdAt: 1 });
    const old = session.append({ type: "user/message", surfaceOp: "append", data: { id: "old", role: "user", source: { kind: "user" }, turn: 1, requestId: "old", content: [{ type: "text", text: "x".repeat(oldLength) }] } });
    session.append({ type: "user/message", surfaceOp: "append", data: { id: "tail", role: "user", source: { kind: "user" }, turn: 1, requestId: "tail", content: [{ type: "text", text: "tail" }] } });
    assert.equal(weight(old.data), target + delta / 4);
    session.bindCheckpoint(async () => {}, async (_events, finish) => { const result = { status: "committed" } as const; finish(result); return result; });
    const context = { session, turn: null, signal: new AbortController().signal, storageOpen: () => true, blockStorage: () => {} };
    const result = await commitCompactionSummary(context, { runtime, businessModel, businessTools: tools, retainTokens: 0 });
    if (delta === 0) { assert.equal(result.status, "rejected"); assert.equal(result.reason, "not-smaller"); }
    else assert.equal(result.status, "succeeded");
  });
}

for (const [label, chunks, status, reason] of [
  ["空白", [{ type: "block-start", index: 0, blockType: "text" }, { type: "block-end", index: 0, block: { type: "text", text: "  " } }, { type: "finish", reason: { kind: "stop" } }], "rejected", "empty-text"],
  ["截断", [{ type: "finish", reason: { kind: "max-tokens" } }], "rejected", "truncated"],
  ["取消终态", [{ type: "finish", reason: { kind: "aborted" } }], "model-not-completed", "aborted"],
] as const) {
  test(`${label}仅交接生成结论并保留 start`, async () => {
    const { session, context, isOpen } = fixture();
    session.bindCheckpoint(async () => {}, async (_events, finish) => { const result = { status: "committed" } as const; finish(result); return result; });
    const runtime = model(chunks);
    const result = await commitCompactionSummary(context, { runtime, businessModel: runtime.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 });
    assert.equal(result.status, status);
    if (result.status === "rejected") assert.equal(result.reason, reason);
    else if (result.status === "model-not-completed") assert.equal(result.finishReason.kind, reason);
    else assert.fail("错误结论类型不符");
    assert.equal(isOpen(), true);
    assert.equal(session.snapshot().events.filter((event) => event.type === "compaction/start").length, 1);
    assert.equal(session.snapshot().events.filter((event) => event.type === "compaction/end").length, 0);
  });
}

for (const change of ["replace", "append"] as const) {
  test(`生成期间${change}后复验固定前缀`, async () => {
    const { session, context } = fixture();
    const entered = deferred();
    const release = deferred();
    session.bindCheckpoint(async () => {}, async (_events, finish) => { const result = { status: "committed" } as const; finish(result); return result; });
    const runtime = new LlmRuntime({ mock: { async *generate() { entered.resolve(); await release.promise; yield* output; } } });
    const task = commitCompactionSummary(context, { runtime, businessModel: runtime.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 });
    await entered.promise;
    if (change === "replace") {
      session.append({ type: "user/message", surfaceOp: { op: "replace", start: 0, end: 0 }, sourceEventSeqs: [0], data: { id: "replacement", role: "user", source: { kind: "compact", compactionId: "other" }, content: [{ type: "text", text: "changed" }] } });
    } else {
      session.append({ type: "user/message", surfaceOp: "append", data: { id: "new-tail", role: "user", source: { kind: "user" }, turn: 2, requestId: "new-tail", content: [{ type: "text", text: "new tail" }] } });
    }
    const priorTail = session.deriveSurfaceNodes().at(-1);
    release.resolve();
    const result = await task;
    assert.equal(result.status, change === "replace" ? "selection-changed" : "succeeded");
    assert.equal(session.deriveSurfaceNodes().at(-1), priorTail);
  });
}

for (const side of ["start", "success"] as const) {
  test(`${side} 普通检查点期间取消不触发存储故障`, async () => {
    const { session } = fixture();
    const controller = new AbortController();
    const reason = new Error("cancel");
    const entered = deferred();
    const release = deferred();
    const records: ReturnType<typeof session.snapshot>["events"][number][] = [];
    const reports: unknown[] = [];
    let calls = 0;
    let flushes = 0;
    let open = true;
    const writer = new SessionWriter(session, {
      append: async (events) => { records.push(...events); },
      flush: async () => { if (++flushes === (side === "start" ? 1 : 2)) { entered.resolve(); await release.promise; } },
      read: async () => records,
      commitStaged: async (events) => { calls++; records.push(...events); return { status: "committed" }; },
      reconcileStaged: async () => { throw new Error("unexpected"); },
    }, (error) => { reports.push(error); open = false; });
    const runtime = model(output);
    const task = commitCompactionSummary({ session, turn: null, signal: controller.signal, storageOpen: () => open, blockStorage: (error) => { reports.push(error); open = false; } }, { runtime, businessModel: runtime.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 });
    await entered.promise;
    controller.abort(reason);
    release.resolve();
    const result = await task;
    if (side === "start") {
      assert.equal(result.status, "generation-failed");
      assert.equal(result.error, reason);
    } else assert.equal(result.status, "succeeded");
    assert.equal(calls, 0);
    assert.deepEqual(reports, []);
    assert.equal(open, true);
    await writer.close();
  });
}

for (const side of ["start", "success"] as const) {
  test(`${side} 普通检查点抛错作为存储异常交接`, async () => {
    const { session } = fixture();
    const fault = new Error("checkpoint failed");
    const records: ReturnType<typeof session.snapshot>["events"][number][] = [];
    let open = true;
    let calls = 0;
    let flushes = 0;
    const writer = new SessionWriter(session, {
      append: async (events) => { records.push(...events); },
      flush: async () => { if (++flushes === (side === "start" ? 1 : 2)) throw fault; },
      read: async () => records,
      commitStaged: async (events) => { calls++; records.push(...events); return { status: "committed" }; },
      reconcileStaged: async () => { throw new Error("unexpected"); },
    }, () => {});
    const runtime = model(output);
    const result = await commitCompactionSummary({ session, turn: null, signal: new AbortController().signal, storageOpen: () => open, blockStorage: () => { open = false; } }, { runtime, businessModel: runtime.prepare({ provider: "mock", model: "m" }), businessTools: [], retainTokens: 0 });
    assert.equal(result.status, "commit-checkpoint-failed");
    assert.equal(result.side, side);
    assert.equal(result.error, fault);
    assert.ok(result.attempt.compactionId);
    assert.equal(open, false);
    assert.equal(calls, 0);
    await writer.close().catch(() => {});
  });
}
