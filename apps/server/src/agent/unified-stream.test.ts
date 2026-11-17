import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { Session } from "@mharness/session/server";
import { createMockAdapter } from "../model/providers/mock.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { createModelTurnDriver, type ExecutionNotice } from "./model-turn.ts";

test("统一流首次关闭块决定结算内容并保留原始分片", async () => {
  const session = new Session({ sessionId: "stream", createdAt: 0 });
  session.bindCheckpoint(async () => {});
  const chunks = [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "草稿" },
    { type: "block-end", index: 0, block: { type: "text", text: "最终" } },
    { type: "text-delta", index: 0, text: "忽略" },
    { type: "block-end", index: 0, block: { type: "text", text: "忽略" } },
    { type: "finish", reason: { kind: "stop" } },
  ] as const;
  const notices: ExecutionNotice[] = [];
  await createModelTurnDriver({
    runtime: new LlmRuntime({ mock: createMockAdapter(() => chunks.map((chunk) => ({ chunk }))) }),
    config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "",
  })({ session, turn: 1, step: 1, signal: new AbortController().signal,
    publish: (notice) => notices.push(notice), blockStorage: () => assert.fail() });
  const message = session.snapshot().events.find((event) => event.type === "assistant/message");
  assert.ok(message);
  assert.deepEqual(message.data.message.content, [{ type: "text", text: "最终" }]);
  const entry = z.object({ time: z.number(), chunk: z.unknown() });
  const compact = z.array(z.union([entry, z.object({ chunks: z.array(entry) })])).parse(message.data.stream);
  assert.deepEqual(compact.flatMap((item) => "chunks" in item ? item.chunks.map((part) => part.chunk) : [item.chunk]), chunks);
  assert.equal(notices.filter((notice) => notice.type === "assistant/chunk").length, 4);
  assert.equal(notices.at(-1)?.type, "assistant/end");
});

test("空 stop 结算失败并保留用量", async () => {
  const session = new Session({ sessionId: "empty", createdAt: 0 });
  session.bindCheckpoint(async () => {});
  await createModelTurnDriver({
    runtime: new LlmRuntime({ mock: createMockAdapter(() => [
      { chunk: { type: "usage", usage: { inputTokens: 2, outputTokens: 0 } } },
      { chunk: { type: "finish", reason: { kind: "stop" } } },
    ]) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "",
  })({ session, turn: 1, step: 1, signal: new AbortController().signal,
    publish: () => {}, blockStorage: () => assert.fail() });
  const events = session.snapshot().events;
  assert.equal(events.some((event) => event.type === "assistant/message"), false);
  const attempt = events.find((event) => event.type === "assistant/attempt");
  assert.ok(attempt);
  assert.equal(attempt.data.outcome, "failed");
  assert.deepEqual(attempt.data.reason, { code: "EMPTY_RESPONSE", message: "Provider returned an empty response" });
  assert.equal(attempt.data.stream.length, 2);
});

test("工具关闭块与已声明标识冲突时失败且不派发", async () => {
  const session = new Session({ sessionId: "conflict", createdAt: 0 });
  session.bindCheckpoint(async () => {});
  const chunks = [
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "tool-call-delta", index: 0, id: "a", name: "lookup", argumentsDelta: "{}" },
    { type: "block-end", index: 0, block: { type: "tool-call", id: "b", name: "lookup", arguments: "{}" } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ] as const;
  await createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => chunks.map((chunk) => ({ chunk }))) }),
    config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "" })({
    session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => assert.fail(),
  });
  const events = session.snapshot().events;
  const attempt = events.find((event) => event.type === "assistant/attempt");
  assert.equal(attempt?.data.outcome, "failed");
  assert.deepEqual(attempt?.data.reason, { code: "PROTOCOL", message: "Provider stream violated the expected protocol" });
  assert.equal(events.some((event) => event.type === "assistant/message" || event.type === "tool/call"), false);
  assert.ok(JSON.stringify(attempt?.data.stream).includes('"id":"b"'));
});

test("空闭合内容按最终块判断，stop 携带工具优先为协议失败", async () => {
  for (const scenario of [
    { type: "text" as const, tool: false, expected: "EMPTY_RESPONSE" },
    { type: "reasoning" as const, tool: false, expected: "EMPTY_RESPONSE" },
    { type: "text" as const, tool: true, expected: "PROTOCOL" },
  ]) {
    const session = new Session({ sessionId: `empty-${scenario.type}-${scenario.tool}`, createdAt: 0 });
    session.bindCheckpoint(async () => {});
    const chunks = [
      { type: "block-start" as const, index: 0, blockType: scenario.type },
      { type: scenario.type === "text" ? "text-delta" as const : "reasoning-delta" as const, index: 0, text: "先前内容" },
      { type: "block-end" as const, index: 0, block: { type: scenario.type, text: "" } },
      ...(scenario.tool ? [
        { type: "block-start" as const, index: 1, blockType: "tool-call" as const },
        { type: "tool-call-delta" as const, index: 1, id: "c", name: "read", argumentsDelta: "{}" },
        { type: "block-end" as const, index: 1, block: { type: "tool-call" as const, id: "c", name: "read", arguments: "{}" } },
      ] : []),
      { type: "finish" as const, reason: { kind: "stop" as const } },
    ];
    const notices: ExecutionNotice[] = [];
    await createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => chunks.map((chunk) => ({ chunk }))) }),
      config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "" })({
      session, turn: 1, step: 1, signal: new AbortController().signal, publish: (notice) => notices.push(notice), blockStorage: () => assert.fail(),
    });
    const events = session.snapshot().events;
    const attempt = events.find((event) => event.type === "assistant/attempt");
    assert.equal(attempt?.data.outcome, "failed");
    assert.equal(typeof attempt?.data.reason === "object" && attempt.data.reason !== null && "code" in attempt.data.reason ? attempt.data.reason.code : undefined, scenario.expected);
    assert.equal(events.some((event) => event.type === "assistant/message" || event.type === "tool/call"), false);
    const end = notices.at(-1);
    assert.ok(end?.type === "assistant/end" && end.outcome.kind === "committed");
  }
});

test("无损与不可无损的非法用量均以 committed 失败结算并保留安全前缀", async () => {
  for (const inputTokens of [-0, -1]) {
    const session = new Session({ sessionId: `usage-${Object.is(inputTokens, -0) ? "negative-zero" : "negative"}`, createdAt: 0 });
    session.bindCheckpoint(async () => {});
    const notices: ExecutionNotice[] = [];
    const prior = { type: "block-start" as const, index: 0, blockType: "text" as const };
    const bad = { type: "usage" as const, usage: { inputTokens, outputTokens: 1 } };
    await createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => [{ chunk: prior }, { chunk: bad }]) }),
      config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "" })({
      session, turn: 1, step: 1, signal: new AbortController().signal, publish: (notice) => notices.push(notice), blockStorage: () => assert.fail(),
    });
    const attempt = session.snapshot().events.find((event) => event.type === "assistant/attempt");
    assert.equal(attempt?.data.outcome, "failed");
    assert.deepEqual(attempt?.data.reason, { code: "PROTOCOL", message: "Provider stream violated the expected protocol" });
    assert.ok(JSON.stringify(attempt?.data.stream).includes(JSON.stringify(prior)));
    assert.equal(JSON.stringify(attempt?.data.stream).includes('"inputTokens":-1'), inputTokens === -1);
    const end = notices.at(-1);
    assert.ok(end?.type === "assistant/end" && end.outcome.kind === "committed" && end.outcome.seq === attempt?.seq);
  }
});
