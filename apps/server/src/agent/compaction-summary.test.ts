import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Session } from "@mharness/session/server";
import { LlmError, type LlmFinishReason, type ModelInput, type ModelTool } from "../model/adapter.ts";
import { createDeepSeekAdapter } from "../model/providers/deepseek.ts";
import { LlmRuntime, type PreparedModel } from "../model/runtime.ts";
import { estimateSurfaceMessageTokens } from "../model/token-meter.ts";
import { revalidateCompactionSelection, selectCompactionPrefix } from "./compaction-selection.ts";
import { acceptCompactionSummary, buildCompactionSummaryRequest, type CompactionSummaryOutput } from "./compaction-summary.ts";

const fixed = { route: { provider: "summary-provider", model: "summary-model", endpointId: "fixed" } };
const identity = { messageId: "new-checkpoint", compactionId: "new-attempt" };
const prepared: PreparedModel = {
  route: { provider: "business", model: "chat" }, effectiveParams: { maxOutputTokens: 2000 },
  async *generate() { assert.fail("摘要准备与校验不调用 Adapter"); },
};
const businessTools: readonly ModelTool[] = [{ name: "business-tool", inputSchema: {} }];
const weight = (message: Parameters<typeof estimateSurfaceMessageTokens>[1]) =>
  estimateSurfaceMessageTokens(prepared, message, businessTools);
const finished = { kind: "stop" } as const;

function appendUser(session: Session, id: string, text: string) {
  return session.append({
    type: "user/message", surfaceOp: "append",
    data: { id, role: "user", source: { kind: "user" }, turn: 1, requestId: id, content: [{ type: "text", text }] },
  });
}

function fixture() {
  const session = new Session({ sessionId: "summary", createdAt: 1 });
  const original = appendUser(session, "old", "SHADOWED_ORIGINAL");
  const checkpoint = "<compacted-summary>PRIOR_CONTEXT</compacted-summary>";
  session.append({
    type: "user/message", surfaceOp: { op: "replace", start: original.seq, end: original.seq },
    sourceEventSeqs: [original.seq],
    data: { id: "prior", role: "user", source: { kind: "compact", compactionId: "prior" }, content: [{ type: "text", text: checkpoint }] },
  });
  const current = "CURRENT_REQUEST".repeat(5000);
  appendUser(session, "current", current);
  const assistant = session.append({
    type: "assistant/message", surfaceOp: "append",
    data: {
      turn: 1, step: 1, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true,
      message: { id: "assistant", role: "assistant", source: { provider: "business", model: "chat" },
        content: [{ type: "text", text: "Need context" }, { type: "tool-call", id: "read", name: "lookup", arguments: "{}" }] },
    },
  });
  const tool = session.append({
    type: "tool/result", surfaceOp: "append", sourceEventSeqs: [assistant.seq],
    data: {
      turn: 1, step: 1, message: { id: "result", role: "user", source: { kind: "tool", callId: "read" },
        content: [{ type: "tool-result", toolCallId: "read", isError: false, content: ["UNPRUNED_RESULT"] }] },
    },
  });
  session.append({
    type: "tool/result", surfaceOp: { op: "replace", start: tool.seq, end: tool.seq }, sourceEventSeqs: [tool.seq],
    data: { ...tool.data, message: { ...tool.data.message,
      content: [{ ...tool.data.message.content[0], content: ["PRUNED_RESULT"] }] } },
  });
  appendUser(session, "tail", "RETAINED_TAIL");
  const selection = selectCompactionPrefix(session, 0, weight);
  assert.ok(selection);
  return { session, selection, checkpoint, current };
}

test("摘要使用逐字的八节指令及检查点合并要求", () => {
  const { selection } = fixture();
  const { input } = buildCompactionSummaryRequest(selection, fixed);
  assert.deepEqual([...input.systemPrompt.matchAll(/^## (.+)$/gm)].map((section) => section[1]), [
    "Primary Request and Intent", "Key Technical Concepts", "Files and Code", "Errors and Fixes",
    "Pending Jobs", "Current Work", "Next Step", "Critical Context",
  ]);
  assert.match(input.systemPrompt, /Use terse bullets.*Write "\(none\)" for an empty section/);
  assert.match(input.systemPrompt, /Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments/);
  assert.match(input.systemPrompt, /Capture user feedback and explicit instructions faithfully, especially corrections/);
  assert.match(input.systemPrompt, /Do NOT mention this summarization request/);
  assert.match(input.systemPrompt, /Output only the checkpoint text: do not call any tool/);
  assert.match(input.systemPrompt, /PRIOR checkpoint.*preserve still-true facts, drop stale ones, and merge newer information/);
  assert.equal(createHash("sha256").update(input.systemPrompt).digest("hex"),
    "3b7aa71f525b9a82afc2f1747c4434ceb7b3bc1fadf8b64c37c4e97db70d074b");
});

test("摘要请求只投影捕获的完整前缀，使用专用上下文和固定配置", () => {
  const { session, selection, checkpoint, current } = fixture();
  appendUser(session, "new", "APPENDED_AFTER_CAPTURE");
  const business = {
    systemPrompt: "BUSINESS_SYSTEM", tools: [{ name: "BUSINESS_TOOL", inputSchema: {} }],
    params: { maxOutputTokens: 14, stop: ["BUSINESS_STOP"] },
  };
  const route = { ...fixed.route, ...business.params };
  const snapshot = session.snapshot();
  const candidate = { route, reasoningEffort: "high", disableReasoningEffort: "none", ...business };
  const { config, input } = buildCompactionSummaryRequest(selection, candidate);
  assert.deepEqual(config, { ...fixed.route, params: { maxOutputTokens: 8192, reasoningEffort: "none" } });
  assert.deepEqual(input.messages, [
    { role: "user", text: checkpoint },
    { role: "user", text: current },
    { role: "assistant", text: "Need context", toolCalls: [{ callId: "read", name: "lookup", arguments: "{}" }] },
    { role: "tool", callId: "read", text: '["PRUNED_RESULT"]' },
  ]);
  assert.deepEqual(input.tools, []);
  assert.ok(!input.systemPrompt.includes(business.systemPrompt));
  assert.deepEqual(session.snapshot(), snapshot);
  assert.deepEqual(business.params, { maxOutputTokens: 14, stop: ["BUSINESS_STOP"] });
  assert.equal(buildCompactionSummaryRequest(selection, { ...fixed, reasoningEffort: "high" }).config.params?.reasoningEffort, "high");
  assert.deepEqual(buildCompactionSummaryRequest(selection, fixed).config.params, { maxOutputTokens: 8192 });
});

test("助手结尾的旧前缀在 DeepSeek 摘要请求中以独立 user 指令开启生成", async () => {
  const session = new Session({ sessionId: "assistant-tail", createdAt: 1 });
  const oldUser = appendUser(session, "old-user", "OLD_USER");
  const oldAssistant = session.append({
    type: "assistant/message", surfaceOp: "append",
    data: {
      turn: 1, step: 1, finishReason: { kind: "stop" }, stream: [], includeInModelContext: true,
      message: { id: "old-assistant", role: "assistant", source: { provider: "business", model: "chat" },
        content: [{ type: "text", text: "OLD_ASSISTANT" }] },
    },
  });
  appendUser(session, "current-user", "CURRENT_USER");
  const selection = selectCompactionPrefix(session, 0, weight);
  assert.ok(selection);
  assert.deepEqual(selection.shadowedSeqs, [oldUser.seq, oldAssistant.seq]);
  const snapshot = session.snapshot();
  const { config, input } = buildCompactionSummaryRequest(selection, {
    route: { provider: "deepseek", model: "deepseek-v4-pro" },
  });
  assert.deepEqual(input.messages, [
    { role: "user", text: "OLD_USER" },
    { role: "assistant", text: "OLD_ASSISTANT" },
    { role: "user", text: "Produce the checkpoint for the conversation above using the required structure." },
  ]);
  assert.deepEqual(session.snapshot(), snapshot);

  let wire = "";
  const runtime = new LlmRuntime({
    deepseek: createDeepSeekAdapter({ apiKey: "fake-key", fetch: async (_url, init) => {
      wire = String(init?.body);
      return new Response('data: {"choices":[{"delta":{"content":"摘要"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    } }),
  });
  for await (const _chunk of runtime.prepare(config).generate(input, new AbortController().signal)) {
    // 消费离线 SSE，确保断言的是 Adapter 实际发送的 wire body。
  }
  assert.ok(wire.indexOf('"content":"OLD_ASSISTANT"') < wire.indexOf('"content":"Produce the checkpoint for the conversation above using the required structure."'));
  assert.match(wire, /"role":"user","content":"Produce the checkpoint for the conversation above using the required structure\."/);
  assert.doesNotMatch(wire, /CURRENT_USER/);
});

test("用户结尾的旧前缀保持原投影，不追加摘要指令", () => {
  const session = new Session({ sessionId: "user-tail", createdAt: 1 });
  const oldUser = appendUser(session, "old-user", "OLD_USER");
  appendUser(session, "current-user", "CURRENT_USER");
  const selection = selectCompactionPrefix(session, 0, weight);
  assert.ok(selection);
  assert.deepEqual(selection.shadowedSeqs, [oldUser.seq]);
  assert.deepEqual(buildCompactionSummaryRequest(selection, fixed).input.messages, [{ role: "user", text: "OLD_USER" }]);
});

test("摘要未指定停止序列时不继承适配器旧默认值，也不写入 DeepSeek 请求", async () => {
  const { selection } = fixture();
  const { config, input } = buildCompactionSummaryRequest(selection, {
    route: { provider: "deepseek", model: "deepseek-v4-pro" },
  });
  let body: unknown;
  const adapter = {
    ...createDeepSeekAdapter({ apiKey: "fake-key", fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response('data: {"choices":[{"delta":{"content":"摘要"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    } }),
    defaultParams: { stop: ["##"], maxOutputTokens: 128 },
  };
  const runtime = new LlmRuntime({ deepseek: adapter });
  const stream = runtime.prepare(config).generate(input, new AbortController().signal);
  let finish: LlmFinishReason | undefined;
  for await (const chunk of stream) {
    if (chunk.type === "finish") finish = chunk.reason;
  }
  assert.deepEqual(finish, { kind: "stop" });
  assert.ok(body && typeof body === "object");
  assert.equal(Object.hasOwn(body, "stop"), false);
  assert.equal(Object.hasOwn(runtime.prepare(config, { recordable: true }).effectiveParams, "stop"), false);
});

test("接受摘要保留未包装正文和有序原值，生成独立的合成 user", () => {
  const { selection } = fixture();
  const blocks = [
    { type: "reasoning", text: "hidden" }, { type: "text", text: "first " },
    { type: "tool-call", id: "unused", name: "lookup", arguments: "{}" },
    { type: "text", text: "\nsecond" },
  ] as const;
  const output: CompactionSummaryOutput = { finishReason: finished, blocks };
  const result = acceptCompactionSummary(selection, output, identity, weight);
  assert.deepEqual(result, {
    status: "accepted", summary: "first \nsecond",
    message: {
      id: "new-checkpoint", role: "user", source: { kind: "compact", compactionId: "new-attempt" },
      content: [
        { type: "text", text: "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>" },
        { type: "text", text: "first " }, { type: "text", text: "\nsecond" }, { type: "text", text: "</compacted-summary>" },
      ],
    },
  });
});

test("空白、无正文、截断和图片分别拒绝，均不产出检查点", () => {
  const { selection } = fixture();
  const text = { type: "text", text: "valid text" } as const;
  const rejected = (output: CompactionSummaryOutput, reason: string) => {
    assert.deepEqual(acceptCompactionSummary(selection, output, identity, () => assert.fail("应先检查输出")), { status: "rejected", reason });
  };
  rejected({ finishReason: finished, blocks: [] }, "empty-text");
  rejected({ finishReason: finished, blocks: [{ type: "text", text: "" }, { type: "text", text: "\t \n" },
    { type: "reasoning", text: "not the body" }] }, "empty-text");
  rejected({ finishReason: finished, blocks: [{ type: "reasoning", text: "not the body" }] }, "empty-text");
  rejected({ finishReason: { kind: "max-tokens" }, blocks: [text] }, "truncated");
  rejected({ finishReason: finished, blocks: [text, { type: "image" }] }, "unsupported-image");
});

test("只在包装后的业务计量严格小于旧前缀时接受，短非 Markdown 正文有效", () => {
  for (const previous of [102, 103, 104]) {
    const session = new Session({ sessionId: "size", createdAt: 1 });
    appendUser(session, "old", "x".repeat(4 * (previous - 8)));
    appendUser(session, "tail", "keep");
    const selection = selectCompactionPrefix(session, 0, weight);
    assert.ok(selection);
    assert.equal(selection.shadowedTokens, previous);
    const result = acceptCompactionSummary(selection, { finishReason: finished, blocks: [{ type: "text", text: "x" }] }, identity,
      (message) => {
        const tokens = weight(message);
        assert.equal(tokens, 103);
        return tokens;
      });
    if (previous < 104) assert.deepEqual(result, { status: "rejected", reason: "not-smaller" });
    else {
      assert.equal(result.status, "accepted");
      assert.equal(result.summary, "x");
    }
  }
});

test("一次摘要失败直接退出，无范围零请求，复验保留选区外追加", () => {
  function exercise(session: Session, output: CompactionSummaryOutput) {
    const attempts: ModelInput[] = [];
    const initial = session.snapshot();
    const selection = selectCompactionPrefix(session, 0, weight);
    if (!selection) return { attempts, candidate: undefined };
    const generate = (input: ModelInput) => {
      attempts.push(input);
      const appended = appendUser(session, "new-tail", "DURING_GENERATION");
      return { output, appended };
    };
    const request = buildCompactionSummaryRequest(selection, fixed);
    const generated = generate(request.input);
    const accepted = acceptCompactionSummary(selection, generated.output, identity, weight);
    const candidate = accepted.status === "accepted" && revalidateCompactionSelection(session, selection) ? accepted : undefined;
    assert.deepEqual(session.snapshot().events, [...initial.events, generated.appended]);
    assert.equal(session.deriveSurfaceNodes().at(-1), generated.appended);
    assert.ok(!request.input.messages.some((message) => message.text === "DURING_GENERATION"));
    return { attempts, candidate };
  }

  const good = { type: "text", text: "short" } as const;
  const tooLong = { type: "text", text: "x".repeat(100_000) } as const;
  for (const output of [
    { finishReason: new LlmError("CONTEXT_WINDOW_EXCEEDED").toFinishReason(), blocks: [] },
    { finishReason: new LlmError("TRANSPORT").toFinishReason(), blocks: [good] },
    { finishReason: new LlmError("ABORTED").toFinishReason(), blocks: [good] },
    { finishReason: { kind: "max-tokens" }, blocks: [good] },
    { finishReason: finished, blocks: [tooLong] },
  ] satisfies CompactionSummaryOutput[]) {
    const { attempts, candidate } = exercise(fixture().session, output);
    assert.equal(attempts.length, 1);
    assert.equal(candidate, undefined);
  }

  const success = { finishReason: finished, blocks: [good] };
  const { attempts, candidate } = exercise(fixture().session, success);
  assert.equal(attempts.length, 1);
  assert.equal(candidate?.summary, "short");
  const empty = new Session({ sessionId: "empty", createdAt: 1 });
  assert.equal(exercise(empty, success).attempts.length, 0);
  appendUser(empty, "single", "keep");
  assert.equal(exercise(empty, success).attempts.length, 0);
});
