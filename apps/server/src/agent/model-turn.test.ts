import assert from "node:assert/strict";
import { z } from "zod";
import { defineLocalTool, ToolRegistry } from "../tools/registry.ts";
import { defineLocalToolOutput } from "../tools/result.ts";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Session } from "@mharness/session/server";
import { createMockAdapter } from "../model/providers/mock.ts";
import { LlmError, type ModelRequest } from "../model/adapter.ts";
import { LlmRuntime } from "../model/runtime.ts";
import { createModelTurnDriver, type ExecutionNotice } from "./model-turn.ts";
import { ReActAgent } from "./react-agent.ts";
import type { StreamChunk } from "../model/adapter.ts";

function testRegistry(handler: () => string | Promise<string>): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(defineLocalTool({ name: "lookup", version: "1", description: "lookup", input: z.strictObject({}), timeoutMs: 100, sideEffect: "read-only", output: defineLocalToolOutput({ schema: z.string(), render: (_args, value) => [{ type: "text", text: value }] }), handler }));
  return registry;
}

test("检查点成功后流式结算并记录可重放请求", async () => {
  const session = new Session({ sessionId: "s", createdAt: 0 });
  session.append({
    type: "user/message",
    surfaceOp: "append",
    data: {
      turn: 1,
      requestId: "r",
      id: "u",
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "你好" }],
    },
  });
  session.bindCheckpoint(async () => {});
  const calls: unknown[] = [];
  const runtime = new LlmRuntime({
    mock: createMockAdapter((request) => {
      calls.push(request);
      return [
        { chunk: { type: "reasoning", delta: "思考" } },
        { chunk: { type: "text", delta: "回答" } },
        { chunk: { type: "finish", reason: { kind: "stop" } } },
      ];
    }),
  });
  const notices: ExecutionNotice[] = [];
  await createModelTurnDriver({
    runtime,
    config: () => ({ provider: "mock", model: "m" }),
    systemPrompt: () => "系统",
  })({
    session,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    publish: (n) => notices.push(n),
    blockStorage: () => assert.fail(),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(
    session.snapshot().events.map((e) => e.type),
    [
      "user/message",
      "step/start",
      "request/header",
      "assistant/message",
      "step/end",
      "turn/end",
    ],
  );
  assert.deepEqual(
    notices.map((n) => n.type),
    ["assistant/start", "assistant/chunk", "assistant/chunk", "assistant/chunk", "assistant/chunk", "assistant/chunk", "assistant/chunk", "assistant/chunk", "assistant/end"],
  );
  const message = session
    .snapshot()
    .events.find((e) => e.type === "assistant/message");
  assert.deepEqual(message?.data.message.content, [
    { type: "reasoning", text: "思考" },
    { type: "text", text: "回答" },
  ]);
});

test("检查点失败阻止模型调用并发布安全错误", async () => {
  const session = new Session({ sessionId: "s", createdAt: 0 });
  session.bindCheckpoint(async () => {
    throw new Error("secret");
  });
  let calls = 0;
  let blocked = false;
  const runtime = new LlmRuntime({
    mock: createMockAdapter(() => {
      calls++;
      return [];
    }),
  });
  const notices: ExecutionNotice[] = [];
  await createModelTurnDriver({
    runtime,
    config: () => ({ provider: "mock", model: "m" }),
    systemPrompt: () => "",
  })({
    session,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    publish: (n) => notices.push(n),
    blockStorage: () => {
      blocked = true;
    },
  });
  assert.equal(calls, 0);
  assert.equal(blocked, true);
  assert.deepEqual(notices, [
    { type: "agent/error", turn: 1, message: "本轮执行失败" },
  ]);
  assert.equal(session.snapshot().events.at(-1)?.type, "turn/end");
});

test("失败、截断和取消分别结算，部分输出不进入模型上下文", async () => {
  for (const [finish, expected, turnKind] of [
    [{ kind: "output_limit" }, "truncated", "max-tokens"],
    [{ kind: "aborted" }, "cancelled", "aborted"],
    [
      {
        kind: "error",
        failure: {
          code: "STREAM_CLOSED",
          message: "Provider stream ended without a finish event",
        },
      },
      "failed",
      "error",
    ],
  ] as const) {
    const session = new Session({ sessionId: "s", createdAt: 0 });
    session.bindCheckpoint(async () => {});
    const adapter = {
      async *generate() {
        yield { type: "block-start" as const, index: 0, blockType: "text" as const };
        yield { type: "text-delta" as const, index: 0, text: "前" };
        yield { type: "text-delta" as const, index: 0, text: "缀" };
        if (finish.kind === "output_limit")
          yield { type: "finish" as const, reason: { kind: "max-tokens" as const } };
        else if (finish.kind === "aborted") throw new LlmError("ABORTED");
      },
    };
    const notices: ExecutionNotice[] = [];
    await createModelTurnDriver({
      runtime: new LlmRuntime({ mock: adapter }),
      config: () => ({ provider: "mock", model: "m" }),
      systemPrompt: () => "",
    })({
      session,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
      publish: (n) => notices.push(n),
      blockStorage: () => assert.fail(),
    });
    const attempt = session
      .snapshot()
      .events.find((e) => e.type === "assistant/attempt");
    assert.equal(attempt?.data.outcome, expected);
    assert.equal(
      attempt?.data.text,
      expected === "failed" ? undefined : "前缀",
    );
    assert.equal(session.deriveMessages().length, 0);
    const last = session.snapshot().events.at(-1);
    assert.equal(last?.type === "turn/end" && last.data.reason.kind, turnKind);
    assert.equal(notices.at(-1)?.type, "assistant/end");
    assert.ok(attempt && "chunks" in Object(attempt.data.stream[1]));
  }
});

test("配置与消息快照在检查点期间保持不变，后续请求复用或更新 header", async () => {
  const session = new Session({ sessionId: "s", createdAt: 0 });
  session.append({
    type: "user/message",
    surfaceOp: "append",
    data: {
      turn: 1,
      requestId: "r",
      id: "u",
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "你好" }],
    },
  });
  const config = {
    provider: "mock",
    model: "m",
    params: { maxOutputTokens: 99 },
  };
  let first = true;
  session.bindCheckpoint(async () => {
    if (first) {
      config.params.maxOutputTokens = 33;
      first = false;
    }
  });
  const requests: ModelRequest[] = [];
  const runtime = new LlmRuntime({
    mock: createMockAdapter((request) => {
      requests.push(request);
      return [{ chunk: { type: "text", delta: "完成" } }, { chunk: { type: "finish", reason: { kind: "stop" } } }];
    }),
  });
  const drive = createModelTurnDriver({
    runtime,
    config: () => config,
    systemPrompt: () => "系统",
  });
  const run = (turn: number) =>
    drive({
      session,
      turn,
      step: 1,
      signal: new AbortController().signal,
      publish: () => {},
      blockStorage: () => assert.fail(),
    });
  await run(1);
  await run(2);
  await run(3);
  assert.equal(requests[0]?.effectiveParams.maxOutputTokens, 99);
  assert.equal(requests[1]?.effectiveParams.maxOutputTokens, 33);
  assert.notEqual(requests[1]?.messages, requests[2]?.messages);
  const headers = session
    .snapshot()
    .events.filter((event) => event.type === "request/header");
  assert.deepEqual(
    headers.map((header) => header.data.reason),
    ["initial", "change"],
  );
  for (let i = 0; i < requests.length; i++) {
    const settled = session
      .snapshot()
      .events.filter((event) => event.type === "assistant/message")[i];
    assert.ok(settled);
    const replay = new Session(
      { sessionId: "s", createdAt: 0 },
      {
        seed: {
          kind: "restore",
          events: session.snapshot(0, settled.seq).events,
          inheritedEventCount: 0,
        },
      },
    );
    assert.deepEqual(
      replay.deriveMessages().map((message) =>
        message.role === "assistant"
          ? {
              role: "assistant",
              text: message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join(""),
            }
          : {
              role: "user",
              text: message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join(""),
            },
      ),
      requests[i]?.messages,
    );
    const header = replay
      .snapshot()
      .events.findLast((event) => event.type === "request/header");
    assert.equal(
      header?.data.header.config.maxTokens,
      requests[i]?.effectiveParams.maxOutputTokens,
    );
    assert.equal(header?.data.header.system, requests[i]?.systemPrompt);
  }
});

test("恢复会话写 resume 并记录 Adapter 最大输出默认值", async () => {
  const original = new Session({ sessionId: "s", createdAt: 0 });
  original.append({
    type: "request/header",
    data: {
      reason: "initial",
      header: { config: { provider: "mock", model: "old" } },
    },
  });
  const session = new Session(original.header, {
    seed: {
      kind: "restore",
      events: original.snapshot().events,
      inheritedEventCount: 0,
    },
  });
  session.bindCheckpoint(async () => {});
  const requests: ModelRequest[] = [];
  const adapter = {
    ...createMockAdapter((request) => {
      requests.push(request);
      return [{ chunk: { type: "text", delta: "完成" } }, { chunk: { type: "finish", reason: { kind: "stop" } } }];
    }),
    defaultParams: { maxOutputTokens: 128 },
  };
  await createModelTurnDriver({
    runtime: new LlmRuntime({ mock: adapter }),
    config: () => ({ provider: "mock", model: "m" }),
    systemPrompt: () => "",
  })({
    session,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    publish: () => {},
    blockStorage: () => assert.fail(),
  });
  const header = session
    .snapshot()
    .events.filter((e) => e.type === "request/header")
    .at(-1);
  assert.equal(header?.data.reason, "resume");
  assert.equal(header?.data.header.config.maxTokens, 128);
  assert.equal(header?.data.header.adapterDefaults?.maxTokens, 128);
  assert.equal(requests[0]?.effectiveParams.maxOutputTokens, 128);
});

test("检查点期间取消不启动实时流或 Provider，仍结算取消", async () => {
  const session = new Session({ sessionId: "s", createdAt: 0 });
  const controller = new AbortController();
  session.bindCheckpoint(async () => {
    controller.abort();
  });
  let calls = 0;
  const notices: ExecutionNotice[] = [];
  await createModelTurnDriver({
    runtime: new LlmRuntime({
      mock: createMockAdapter(() => {
        calls++;
        return [];
      }),
    }),
    config: () => ({ provider: "mock", model: "m" }),
    systemPrompt: () => "",
  })({
    session,
    turn: 1,
    step: 1,
    signal: controller.signal,
    publish: (n) => notices.push(n),
    blockStorage: () => assert.fail(),
  });
  assert.equal(calls, 0);
  assert.deepEqual(notices, []);
  const attempt = session
    .snapshot()
    .events.find((e) => e.type === "assistant/attempt");
  assert.equal(attempt?.data.outcome, "cancelled");
});

test("surface 替换写 series，配置同时变化时写 change 和 startsSeries", async () => {
  const session = new Session({ sessionId: "s", createdAt: 0 });
  session.append({
    type: "user/message",
    surfaceOp: "append",
    data: {
      turn: 1,
      requestId: "r",
      id: "u",
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "原文" }],
    },
  });
  session.bindCheckpoint(async () => {});
  let model = "m";
  const drive = createModelTurnDriver({
    runtime: new LlmRuntime({
      mock: createMockAdapter(() => [
        { chunk: { type: "finish", reason: { kind: "stop" } } },
      ]),
    }),
    config: () => ({ provider: "mock", model }),
    systemPrompt: () => "",
  });
  const run = (turn: number) =>
    drive({
      session,
      turn,
      step: 1,
      signal: new AbortController().signal,
      publish: () => {},
      blockStorage: () => assert.fail(),
    });
  await run(1);
  session.append({
    type: "user/message",
    surfaceOp: { op: "replace", start: 0, end: 0 },
    sourceEventSeqs: [0],
    data: {
      id: "summary1",
      role: "user",
      source: { kind: "compact", compactionId: "c1" },
      content: [{ type: "text", text: "摘要" }],
    },
  });
  await run(2);
  const summary = session
    .snapshot()
    .events.find((e) => e.type === "user/message" && e.data.id === "summary1");
  assert.ok(summary);
  session.append({
    type: "user/message",
    surfaceOp: { op: "replace", start: summary.seq, end: summary.seq },
    sourceEventSeqs: [summary.seq],
    data: {
      id: "summary2",
      role: "user",
      source: { kind: "compact", compactionId: "c2" },
      content: [{ type: "text", text: "新摘要" }],
    },
  });
  model = "m2";
  await run(3);
  const headers = session
    .snapshot()
    .events.filter((e) => e.type === "request/header");
  assert.deepEqual(
    headers.map((e) => [e.data.reason, e.data.startsSeries]),
    [
      ["initial", undefined],
      ["series", undefined],
      ["change", true],
    ],
  );
});

test("工具调用分片保留原参数、顺序和 usage，实时 end 引用结算", async () => {
  const session = new Session({ sessionId: "s", createdAt: 0 });
  session.bindCheckpoint(async () => {});
  const notices: ExecutionNotice[] = [];
  const runtime = new LlmRuntime({
    mock: createMockAdapter(() => [
      { chunk: { type: "text", delta: "查询" } },
      {
        chunk: {
          type: "tool_call",
          index: 0,
          callId: "c",
          name: "lookup",
          argumentsDelta: '{"q":',
        },
      },
      { chunk: { type: "tool_call", index: 0, argumentsDelta: '"x"}' } },
      { chunk: { type: "usage", inputTokens: 5, outputTokens: 3 } },
      { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
    ]),
  });
  await createModelTurnDriver({
    runtime,
    config: () => ({ provider: "mock", model: "m" }),
    systemPrompt: () => "",
  })({
    session,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    publish: (n) => notices.push(n),
    blockStorage: () => assert.fail(),
  });
  const message = session
    .snapshot()
    .events.find((e) => e.type === "assistant/message");
  assert.deepEqual(message?.data.message.content, [
    { type: "text", text: "查询" },
    { type: "tool-call", id: "c", name: "lookup", arguments: '{"q":"x"}' },
  ]);
  assert.deepEqual(message?.data.usage, { inputTokens: 5, outputTokens: 3 });
  const end = notices.at(-1);
  assert.ok(end?.type === "assistant/end" && end.outcome.kind === "committed");
  assert.equal(end.outcome.seq, message?.seq);
  assert.equal(end.index, 9);
});

test("Adapter 默认 topP 无法记录时不调用 Provider", async () => {
  const session = new Session({ sessionId: "s", createdAt: 0 });
  session.bindCheckpoint(async () => {});
  let calls = 0;
  const adapter = {
    ...createMockAdapter(() => {
      calls++;
      return [];
    }),
    defaultParams: { topP: 0.5 },
  };
  await createModelTurnDriver({
    runtime: new LlmRuntime({ mock: adapter }),
    config: () => ({ provider: "mock", model: "m" }),
    systemPrompt: () => "",
  })({
    session,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    publish: () => {},
    blockStorage: () => assert.fail(),
  });
  assert.equal(calls, 0);
  assert.equal(
    session.snapshot().events.some((e) => e.type === "request/header"),
    false,
  );
});

test("未派发工具的结算进入下一轮模型请求，调用与结果配对", async () => {
  const session = new Session({ sessionId: "s", createdAt: 0 });
  session.bindCheckpoint(async () => {});
  const requests: ModelRequest[] = [];
  const runtime = new LlmRuntime({
    mock: createMockAdapter((request) => {
      requests.push(request);
      return requests.length === 1
        ? [
            {
              chunk: {
                type: "tool_call",
                index: 0,
                callId: "c",
                name: "lookup",
                argumentsDelta: "{}",
              },
            },
            { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
          ]
        : [{ chunk: { type: "text", delta: "完成" } }, { chunk: { type: "finish", reason: { kind: "stop" } } }];
    }),
  });
  const drive = createModelTurnDriver({
    runtime,
    config: () => ({ provider: "mock", model: "m" }),
    systemPrompt: () => "",
  });
  const run = (turn: number) =>
    drive({
      session,
      turn,
      step: 1,
      signal: new AbortController().signal,
      publish: () => {},
      blockStorage: () => assert.fail(),
    });
  await run(1);
  await run(2);
  const result = session
    .snapshot()
    .events.find((event) => event.type === "tool/result");
  assert.equal(result?.data.error?.code, "TOOL_NOT_STARTED");
  assert.deepEqual(
    requests[1]?.messages.map((message) => message.role),
    ["assistant", "tool"],
  );
  const tool = requests[1]?.messages[1];
  assert.deepEqual(tool, {
    role: "tool",
    callId: "c",
    text: JSON.stringify([{ type: "text", text: "工具尚未派发" }]),
  });
  const settled = session
    .snapshot()
    .events.filter((event) => event.type === "assistant/message")[1];
  assert.ok(settled);
  const replay = new Session(session.header, {
    seed: {
      kind: "restore",
      events: session.snapshot(0, settled.seq).events,
      inheritedEventCount: 0,
    },
  });
  replay.bindCheckpoint(async () => {});
  await drive({
    session: replay,
    turn: 2,
    step: 1,
    signal: new AbortController().signal,
    publish: () => {},
    blockStorage: () => assert.fail(),
  });
  assert.deepEqual(requests[2]?.messages, requests[1]?.messages);
});

test("检查点失败保留安全代码，无法分类时使用 UNKNOWN", async () => {
  const db = new DatabaseSync(":memory:");
  let sqliteError: unknown;
  try {
    db.exec("SELECT * FROM secret_missing_table");
  } catch (error) {
    sqliteError = error;
  } finally {
    db.close();
  }
  assert.ok(sqliteError instanceof Error);
  for (const [error, expected] of [
    [sqliteError, "ERR_SQLITE_ERROR"],
    [
      Object.assign(new Error("secret"), { code: "SQLITE_BUSY" }),
      "SQLITE_BUSY",
    ],
    [new Error("secret"), "UNKNOWN"],
    [Object.assign(new Error("secret"), { code: "secret text" }), "UNKNOWN"],
  ] as const) {
    const session = new Session({ sessionId: "s", createdAt: 0 });
    session.bindCheckpoint(async () => {
      throw error;
    });
    await createModelTurnDriver({
      runtime: new LlmRuntime({ mock: createMockAdapter(() => []) }),
      config: () => ({ provider: "mock", model: "m" }),
      systemPrompt: () => "",
    })({
      session,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
      publish: () => {},
      blockStorage: () => {},
    });
    const last = session.snapshot().events.at(-1);
    assert.equal(JSON.stringify(last).includes("secret_missing_table"), false);
    assert.equal(
      last?.type === "turn/end" &&
        last.data.reason.kind === "error" &&
        last.data.reason.error.message,
      "本轮执行失败",
    );
    assert.equal(
      last?.type === "turn/end" &&
        last.data.reason.kind === "error" &&
        last.data.reason.error.code,
      expected,
    );
  }
});

test("模型步数达到上限时保留工具配对并停止调度", async () => {
  const session = new Session({ sessionId: "budget", createdAt: 0 });
  let checkpoints = 0;
  session.bindCheckpoint(async () => {
    checkpoints++;
  });
  let calls = 0;
  let batches = 0;
  const drive = createModelTurnDriver({
    runtime: new LlmRuntime({
      mock: createMockAdapter(() => {
        calls++;
        return [
          {
            chunk: {
              type: "tool_call",
              index: 0,
              callId: `c${calls}`,
              name: "lookup",
              argumentsDelta: "{}",
            },
          },
          { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
        ];
      }),
    }),
    config: () => ({ provider: "mock", model: "m" }),
    systemPrompt: () => "",
    maxSteps: 2,
    toolRegistry: testRegistry(() => { batches++; return "ok"; }),
  });
  await drive({
    session,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    publish: () => {},
    blockStorage: () => assert.fail(),
  });
  assert.equal(calls, 2);
  assert.equal(batches, 1);
  assert.ok(checkpoints >= 3);
  const events = session.snapshot().events;
  assert.equal(events.filter((e) => e.type === "step/start").length, 2);
  assert.equal(events.filter((e) => e.type === "step/end").length, 2);
  assert.equal(events.filter((e) => e.type === "turn/end").length, 1);
  assert.equal(events.filter((e) => e.type === "tool/result").length, 2);
  const end = events.at(-1);
  assert.equal(
    end?.type === "turn/end" &&
      end.data.reason.kind === "error" &&
      end.data.reason.error.code,
    "MAX_STEPS",
  );
});

test("模型步数配置必须是正安全整数", () => {
  for (const maxSteps of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () =>
        createModelTurnDriver({
          runtime: new LlmRuntime({}),
          config: () => ({ provider: "mock", model: "m" }),
          systemPrompt: () => "",
          maxSteps,
        }),
      RangeError,
    );
  }
});

test("无效工具分片结算为失败并保留诊断流", async () => {
  const session = new Session({ sessionId: "malformed", createdAt: 0 });
  session.bindCheckpoint(async () => {});
  const notices: ExecutionNotice[] = [];
  await createModelTurnDriver({
    runtime: new LlmRuntime({
      mock: createMockAdapter(() => [
        { chunk: { type: "tool_call", index: 0, argumentsDelta: "{" } },
        {
          chunk: {
            type: "tool_call",
            index: 0,
            callId: "later",
            name: "tool",
            argumentsDelta: "}",
          },
        },
        { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
      ]),
    }),
    config: () => ({ provider: "mock", model: "m" }),
    systemPrompt: () => "",
  })({
    session,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    publish: (n) => notices.push(n),
    blockStorage: () => assert.fail(),
  });
  const attempt = session
    .snapshot()
    .events.find((e) => e.type === "assistant/attempt");
  assert.equal(attempt?.data.outcome, "failed");
  assert.equal((attempt?.data.reason as { code?: string }).code, "PROTOCOL");
  assert.equal(session.deriveMessages().length, 0);
  assert.equal(notices.at(-1)?.type, "assistant/end");
});

test("批次前检查点失败仍配对未派发调用", async () => {
  const session = new Session({ sessionId: "flush-failure", createdAt: 0 });
  let checkpoints = 0;
  session.bindCheckpoint(async () => {
    if (++checkpoints === 2) throw new Error("secret");
  });
  let batches = 0;
  await createModelTurnDriver({
    runtime: new LlmRuntime({
      mock: createMockAdapter(() => [
        {
          chunk: {
            type: "tool_call",
            index: 0,
            callId: "c",
            name: "lookup",
            argumentsDelta: "{}",
          },
        },
        { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
      ]),
    }),
    config: () => ({ provider: "mock", model: "m" }),
    systemPrompt: () => "",
    toolRegistry: testRegistry(() => { batches++; return "ok"; }),
  })({
    session,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    publish: () => {},
    blockStorage: () => {},
  });
  assert.equal(batches, 0);
  const result = session
    .snapshot()
    .events.find((e) => e.type === "tool/result");
  assert.equal(result?.data.error?.code, "TOOL_NOT_STARTED");
  assert.equal(session.snapshot().events.at(-1)?.type, "turn/end");
});

test("工具正文异常时不声称工具尚未开始", async () => {
  const session = new Session({ sessionId: "batch-failure", createdAt: 0 });
  session.bindCheckpoint(async () => {});
  await createModelTurnDriver({
    runtime: new LlmRuntime({
      mock: createMockAdapter(() => [
        {
          chunk: {
            type: "tool_call",
            index: 0,
            callId: "c",
            name: "lookup",
            argumentsDelta: "{}",
          },
        },
        { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
      ]),
    }),
    config: () => ({ provider: "mock", model: "m" }),
    systemPrompt: () => "",
    toolRegistry: testRegistry(() => { throw new Error("lost"); }),
  })({
    session,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    publish: () => {},
    blockStorage: () => assert.fail(),
  });
  const result = session
    .snapshot()
    .events.find((e) => e.type === "tool/result");
  assert.equal(result?.data.error, undefined);
});

test("工具结果检查点失败后不打开下一步", async () => {
  const session = new Session({ sessionId: "result-checkpoint", createdAt: 0 });
  let checkpoints = 0;
  session.bindCheckpoint(async () => { if (++checkpoints === 4) throw Object.assign(new Error("secret"), { code: "SQLITE_BUSY" }); });
  let calls = 0;
  await createModelTurnDriver({
    runtime: new LlmRuntime({ mock: createMockAdapter(() => {
      calls++;
      return [
        { chunk: { type: "tool_call", index: 0, callId: "c", name: "lookup", argumentsDelta: "{}" } },
        { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
      ];
    }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "",
    toolRegistry: testRegistry(() => "完成"),
  })({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => {} });
  const events = session.snapshot().events;
  assert.equal(calls, 1);
  assert.deepEqual(events.filter((e) => e.type === "step/start").map((e) => e.data.step), [1]);
  assert.equal(events.filter((e) => e.type === "tool/result").length, 1);
  const end = events.at(-1);
  assert.equal(end?.type === "turn/end" && end.data.reason.kind === "error" && end.data.reason.error.code, "SQLITE_BUSY");
});

test("批次前取消不派发并保留工具配对", async () => {
  const session = new Session({ sessionId: "cancel-batch", createdAt: 0 });
  const controller = new AbortController();
  session.bindCheckpoint(async () => {});
  let batches = 0;
  await createModelTurnDriver({
    runtime: new LlmRuntime({ mock: createMockAdapter(() => [
      { chunk: { type: "tool_call", index: 0, callId: "c", name: "lookup", argumentsDelta: "{}" } },
      { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
    ]) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "",
    toolRegistry: testRegistry(() => { batches++; return "ok"; }),
  })({ session, turn: 1, step: 1, signal: controller.signal, publish: (notice) => { if (notice.type === "assistant/end") controller.abort(); }, blockStorage: () => assert.fail() });
  assert.equal(batches, 0);
  const events = session.snapshot().events;
  const result = events.find((e) => e.type === "tool/result");
  assert.equal(result?.data.error?.code, "ABORTED_BEFORE_DISPATCH");
  assert.deepEqual(result?.data.message.content[0].content, [{ type: "text", text: "用户取消，工具未执行。" }]);
  assert.equal(events.some((e) => e.type === "tool/call" || e.type === "approval/asked"), false);
  const end = events.at(-1);
  assert.equal(end?.type === "turn/end" && end.data.reason.kind, "aborted");
});

test("工具续答成功时 Turn 以 completed 结束", async () => {
  const session = new Session({ sessionId: "continued", createdAt: 0 });
  session.bindCheckpoint(async () => {});
  let calls = 0;
  await createModelTurnDriver({
    runtime: new LlmRuntime({ mock: createMockAdapter(() => ++calls === 1 ? [
      { chunk: { type: "tool_call", index: 0, callId: "c", name: "lookup", argumentsDelta: "{}" } },
      { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
    ] : [{ chunk: { type: "text", delta: "完成" } }, { chunk: { type: "finish", reason: { kind: "stop" } } }]) }),
    config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "",
    toolRegistry: testRegistry(() => "ok"),
  })({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => assert.fail() });
  const end = session.snapshot().events.at(-1);
  assert.equal(end?.type === "turn/end" && end.data.reason.kind, "completed");
});

test("后续工具异常时保留已确认结果", async () => {
  const session = new Session({ sessionId: "partial-batch", createdAt: 0 });
  session.bindCheckpoint(async () => {});
  let executions = 0;
  await createModelTurnDriver({
    runtime: new LlmRuntime({ mock: createMockAdapter(() => [
      { chunk: { type: "tool_call", index: 0, callId: "a", name: "lookup", argumentsDelta: "{}" } },
      { chunk: { type: "tool_call", index: 1, callId: "b", name: "lookup", argumentsDelta: "{}" } },
      { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
    ]) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "",
    toolRegistry: testRegistry(() => { if (++executions === 2) throw new Error("lost"); return "已确认"; }),
  })({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => assert.fail() });
  const results = session.snapshot().events.filter((e) => e.type === "tool/result");
  assert.equal(results.length, 2);
  assert.equal(results[0]?.data.error, undefined);
  assert.deepEqual(results[0]?.data.message.content[0].content, [{ type: "text", text: "已确认" }]);
  assert.equal(results[1]?.data.error, undefined);
  assert.equal(results[1]?.data.message.content[0].isError, true);
});

async function observeInvalidStream(session: Session, chunks: readonly StreamChunk[]) {
  const { followFrameSchema } = await import("@mharness/session/contracts");
  const handle = { id: session.header.sessionId, header: session.header, access: "write" as const, inheritedEventCount: 0,
    read: async () => [], append: async () => {}, flush: async () => {}, close: async () => {} };
  const driver = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => chunks.map((chunk) => ({ chunk }))) }),
    config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "" });
  const agent = new ReActAgent(session, driver, handle);
  const valid: boolean[] = [];
  const delivered: unknown[] = [];
  agent.onObservation((notice) => {
    if (notice.type !== "assistant-stream") return;
    delivered.push(notice.frame);
    valid.push(followFrameSchema.safeParse(notice).success);
    valid.push(followFrameSchema.safeParse({ type: "snapshot", ...agent.snapshot() }).success);
  });
  agent.prompt({ requestId: "r", content: [{ type: "text", text: "输入" }] });
  await agent.waitForIdle();
  await agent.stop();
  return { valid, delivered };
}

test("非法工具分片只进入诊断流，所有实时帧和活动快照符合协议", async () => {
  const start = { type: "block-start", index: 0, blockType: "tool-call" } as const;
  const first = { type: "tool-call-delta", index: 0, id: "c", name: "tool", argumentsDelta: "{" } as const;
  const invalid: { prefix: readonly StreamChunk[]; bad: StreamChunk }[] = [
    { prefix: [], bad: { type: "block-start", index: -1, blockType: "tool-call" } },
    { prefix: [], bad: { type: "block-start", index: Number.MAX_SAFE_INTEGER + 1, blockType: "tool-call" } },
    { prefix: [start], bad: { type: "tool-call-delta", index: 0, id: "", name: "tool", argumentsDelta: "{}" } },
    { prefix: [start], bad: { type: "tool-call-delta", index: 0, id: "c", name: "", argumentsDelta: "{}" } },
    { prefix: [start, first], bad: { type: "tool-call-delta", index: 0, id: "other", name: "tool", argumentsDelta: "x" } },
    { prefix: [start, first], bad: { type: "tool-call-delta", index: 0, id: "c", name: "other", argumentsDelta: "x" } },
  ];
  for (const [i, { prefix, bad }] of invalid.entries()) {
    const session = new Session({ sessionId: `malformed-${i}`, createdAt: 0 });
    session.bindCheckpoint(async () => {});
    const { valid, delivered } = await observeInvalidStream(session, [...prefix, bad]);
    assert.ok(valid.every(Boolean));
    assert.equal(delivered.filter((frame) => typeof frame === "object" && frame !== null && "type" in frame && frame.type === "chunk").length, i >= 4 ? 1 : 0);
    const attempt = session.snapshot().events.find((e) => e.type === "assistant/attempt");
    assert.equal(attempt?.data.outcome, "failed");
    assert.equal((attempt?.data.reason as { code?: string }).code, "PROTOCOL");
    assert.ok(JSON.stringify(attempt?.data.stream).includes(JSON.stringify(bad)));
  }
});
test("取得流时同步取消会释放流且不发布实时帧", async () => {
  const session = new Session({ sessionId: "sync-abort", createdAt: 0 });
  session.bindCheckpoint(async () => {});
  const controller = new AbortController();
  let released = 0;
  let consumed = 0;
  class AbortRuntime extends LlmRuntime {
    override prepare(...args: Parameters<LlmRuntime["prepare"]>) {
      const prepared = super.prepare(...args);
      return { ...prepared, generate: () => {
        controller.abort();
        return { [Symbol.asyncIterator]() { return { next: async () => { consumed++; return { done: true as const, value: undefined }; }, return: async () => { released++; return { done: true as const, value: undefined }; } }; } };
      } };
    }
  }
  const notices: ExecutionNotice[] = [];
  await createModelTurnDriver({ runtime: new AbortRuntime({ mock: createMockAdapter(() => []) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "" })({ session, turn: 1, step: 1, signal: controller.signal, publish: (notice) => notices.push(notice), blockStorage: () => assert.fail() });
  assert.equal(released, 1);
  assert.equal(consumed, 0);
  assert.deepEqual(notices, []);
  const attempt = session.snapshot().events.find((e) => e.type === "assistant/attempt");
  assert.equal(attempt?.data.outcome, "cancelled");
  const end = session.snapshot().events.at(-1);
  assert.equal(end?.type === "turn/end" && end.data.reason.kind, "aborted");
});

test("同步生成异常不发布流帧", async () => {
  const session = new Session({ sessionId: "sync-throw", createdAt: 0 });
  session.bindCheckpoint(async () => {});
  class ThrowRuntime extends LlmRuntime {
    override prepare(...args: Parameters<LlmRuntime["prepare"]>) {
      const prepared = super.prepare(...args);
      return { ...prepared, generate: () => { throw new Error("secret"); } };
    }
  }
  const notices: ExecutionNotice[] = [];
  await createModelTurnDriver({ runtime: new ThrowRuntime({ mock: createMockAdapter(() => []) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "" })({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: (notice) => notices.push(notice), blockStorage: () => assert.fail() });
  assert.deepEqual(notices, [{ type: "agent/error", turn: 1, message: "本轮执行失败" }]);
});

test("不可持久化的工具索引以协议失败安全结算", async () => {
  for (const [i, index] of [NaN, Infinity, -Infinity, -0].entries()) {
    const session = new Session({ sessionId: `non-json-index-${i}`, createdAt: 0 });
    session.bindCheckpoint(async () => {});
    const first: StreamChunk = { type: "text-delta", index: 0, text: "前缀" };
    const bad: StreamChunk = { type: "block-start", index, blockType: "tool-call" };
    const { valid, delivered } = await observeInvalidStream(session, [
      { type: "block-start", index: 0, blockType: "text" }, first, bad,
    ]);
    assert.ok(valid.every(Boolean));
    assert.equal(delivered.filter((frame) => typeof frame === "object" && frame !== null && "type" in frame && frame.type === "chunk").length, 1);
    const attempt = session.snapshot().events.find((event) => event.type === "assistant/attempt");
    assert.equal(attempt?.data.outcome, "failed");
    assert.equal((attempt?.data.reason as { code?: string }).code, "PROTOCOL");
    assert.ok(JSON.stringify(attempt?.data.stream).includes(JSON.stringify(first)));
    assert.equal(delivered.filter((frame) => typeof frame === "object" && frame !== null && "type" in frame && frame.type === "end").length, 1);
  }
});
test("同步取消时迭代器清理抛错仍唯一结算取消", async () => {
  const session = new Session({ sessionId: "abort-return-error", createdAt: 0 });
  session.bindCheckpoint(async () => {});
  const controller = new AbortController();
  let attempts = 0;
  let cleanupAttempts = 0;
  let nextCalls = 0;
  class AbortRuntime extends LlmRuntime {
    override prepare(...args: Parameters<LlmRuntime["prepare"]>) {
      const prepared = super.prepare(...args);
      return { ...prepared, generate: () => {
        attempts++;
        controller.abort();
        return { [Symbol.asyncIterator]() { return {
          next: async () => { nextCalls++; return { done: true as const, value: undefined }; },
          return: async () => { cleanupAttempts++; throw new Error("cleanup failed"); },
        }; } };
      } };
    }
  }
  const notices: ExecutionNotice[] = [];
  await createModelTurnDriver({
    runtime: new AbortRuntime({ mock: createMockAdapter(() => []) }),
    config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "",
  })({ session, turn: 1, step: 1, signal: controller.signal, publish: (notice) => notices.push(notice), blockStorage: () => assert.fail() });
  assert.equal(attempts, 1);
  assert.equal(cleanupAttempts, 1);
  assert.equal(nextCalls, 0);
  assert.deepEqual(notices, []);
  const events = session.snapshot().events;
  const settled = events.filter((event) => event.type === "assistant/attempt");
  assert.equal(settled.length, 1);
  assert.equal(settled[0]?.data.outcome, "cancelled");
  assert.equal(settled[0]?.data.reason, "aborted");
  const turnEnds = events.filter((event) => event.type === "turn/end");
  assert.equal(turnEnds.length, 1);
  assert.equal(turnEnds[0]?.data.reason.kind, "aborted");
  assert.equal(events.filter((event) => event.type === "step/end").length, 1);
  assert.equal(events.filter((event) => event.type === "step/start").length, 1);
});

test("pre-step 完成前不打开 Step，取消后仅结束 Turn", async () => {
  const session = new Session({ sessionId: "gate", createdAt: 0 });
  session.bindCheckpoint(async () => {});
  const controller = new AbortController();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const run = createModelTurnDriver({
    runtime: new LlmRuntime({ mock: createMockAdapter(() => { calls++; return []; }) }),
    config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "",
    preStep: async () => { entered(); await gate; },
  })({ session, turn: 1, step: 1, signal: controller.signal, publish: () => {}, blockStorage: () => {} });
  await started;
  assert.deepEqual(session.snapshot().events, []);
  controller.abort(); release(); await run;
  assert.equal(calls, 0);
  assert.deepEqual(session.snapshot().events.map((event) => event.type), ["turn/end"]);
  const end = session.snapshot().events.at(-1);
  assert.equal(end?.type === "turn/end" && end.data.reason.kind, "aborted");
});

test("pre-step 普通拒绝仍结算 Turn，压缩阻断保留首次报告的空值", async () => {
  for (const blocked of [false, true]) {
    const session = new Session({ sessionId: "s", createdAt: 0 });
    session.bindCheckpoint(async () => {});
    session.append({ type: "turn/start", data: { turn: 1 } });
    const controller = new AbortController();
    const reports: unknown[] = [];
    let modelCalls = 0;
    const task = createModelTurnDriver({
      runtime: new LlmRuntime({ mock: createMockAdapter(() => { modelCalls++; return []; }) }),
      config: () => ({ provider: "mock", model: "m" }),
      systemPrompt: () => "",
      preStep: async ({ blockStorage }) => {
        if (blocked) {
          blockStorage(undefined);
          blockStorage(new Error("later storage error"));
          controller.abort();
        }
        throw new Error("hook rejected");
      },
    })({
      session, turn: 1, step: 1, signal: controller.signal,
      publish: () => {}, blockStorage: (error) => reports.push(error),
    });
    if (blocked) {
      await task.then(() => assert.fail("驱动应拒绝"), (error) => assert.equal(error, undefined));
      assert.deepEqual(reports, [undefined]);
      assert.deepEqual(session.snapshot().events.map(({ type }) => type), ["turn/start"]);
    } else {
      await task;
      assert.deepEqual(reports, []);
      assert.deepEqual(session.snapshot().events.map(({ type }) => type), ["turn/start", "turn/end"]);
      const end = session.snapshot().events.at(-1);
      assert.equal(end?.type === "turn/end" && end.data.reason.kind, "error");
    }
    assert.equal(modelCalls, 0);
  }
});

test("同一步超限结算后重建消息并沿用配置", async () => {
  const session = new Session({ sessionId: "retry", createdAt: 0 });
  session.append({ type: "user/message", surfaceOp: "append", data: { turn: 1, requestId: "r", id: "u", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "原文" }] } });
  session.bindCheckpoint(async () => {});
  let model = "old";
  let hooks = 0;
  const requests: ModelRequest[] = [];
  const notices: ExecutionNotice[] = [];
  const runtime = new LlmRuntime({ mock: createMockAdapter((request) => {
    requests.push(request);
    if (requests.length === 1) throw new LlmError("CONTEXT_WINDOW_EXCEEDED");
    return [{ chunk: { type: "text", delta: "完成" } }, { chunk: { type: "finish", reason: { kind: "stop" } } }];
  }) });
  await createModelTurnDriver({ runtime, config: () => ({ provider: "mock", model }), systemPrompt: () => "system", maxSteps: 1,
    preStep: async () => { hooks++; },
    recoverOverflow: async () => {
      const failed = session.snapshot().events.find((e) => e.type === "assistant/attempt");
      const end = notices.at(-1);
      assert.ok(failed && end?.type === "assistant/end" && end.outcome.kind === "committed" && end.outcome.seq === failed.seq);
      session.append({ type: "user/message", surfaceOp: { op: "replace", start: 0, end: 0 }, sourceEventSeqs: [0], data: { id: "summary", role: "user", source: { kind: "compact", compactionId: "c" }, content: [{ type: "text", text: "摘要" }] } });
      model = "new";
      return true;
    },
  })({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: (n) => notices.push(n), blockStorage: () => assert.fail() });
  assert.equal(hooks, 1);
  assert.deepEqual(requests.map((r) => r.route.model), ["old", "old"]);
  assert.deepEqual(requests.map((r) => r.messages[0]?.text), ["原文", "摘要"]);
  const events = session.snapshot().events;
  assert.deepEqual(events.filter((e) => e.type === "request/header").map((e) => e.data.reason), ["initial", "series"]);
  assert.equal(events.filter((e) => e.type === "step/start").length, 1);
  assert.equal(events.filter((e) => e.type === "assistant/attempt").length, 1);
  assert.equal(events.filter((e) => e.type === "assistant/message").length, 1);
  const starts = notices.filter((n) => n.type === "assistant/start");
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0]?.attemptId, starts[1]?.attemptId);
});

test("不可记录的嵌套工具在 hook 与开步前拒绝", async () => {
  for (const value of [new Map(), NaN]) {
    const session = new Session({ sessionId: "invalid", createdAt: 0 });
    let hooks = 0; let calls = 0;
    await createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { calls++; return []; }) }),
      config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", tools: () => [{ name: "x", inputSchema: { value } }],
      preStep: async () => { hooks++; },
    })({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => {} });
    assert.equal(hooks, 0); assert.equal(calls, 0);
    assert.deepEqual(session.snapshot().events.map((e) => e.type), ["turn/end"]);
  }
});

test("真实 Agent 的存储门在等待点及检查点后阻止模型", async () => {
  for (const boundary of ["pre-step", "flush"] as const) {
    const session = new Session({ sessionId: boundary, createdAt: 0 });
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    session.bindCheckpoint(async () => { if (boundary === "flush") { entered(); await gate; } });
    let calls = 0;
    const driver = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { calls++; return []; }) }),
      config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "",
      preStep: async () => { if (boundary === "pre-step") { entered(); await gate; } },
    });
    const handle = { id: boundary, header: session.header, access: "write" as const, inheritedEventCount: 0,
      read: async () => [], append: async () => {}, flush: async () => {}, close: async () => {} };
    const agent = new ReActAgent(session, driver, handle);
    agent.prompt({ requestId: "r", content: [{ type: "text", text: "输入" }] });
    await waiting; agent.blockStorage(new Error("blocked")); release(); await agent.waitForIdle();
    assert.equal(calls, 0); assert.equal(agent.storageOpen, false);
    const events = session.snapshot().events;
    assert.equal(events.some((e) => e.type === "step/start"), boundary === "flush");
    assert.equal(events.some((e) => e.type === "request/header"), boundary === "flush");
    await agent.stop();
  }
});

test("恢复等待后及重试检查点后关闭存储门均不发起第二次请求", async () => {
  for (const boundary of ["recover", "flush"] as const) {
    const session = new Session({ sessionId: boundary, createdAt: 0 });
    let release!: () => void; let entered!: () => void; let checkpoints = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    session.bindCheckpoint(async () => { if (++checkpoints === 2 && boundary === "flush") { entered(); await gate; } });
    let calls = 0;
    const driver = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { calls++; throw new LlmError("CONTEXT_WINDOW_EXCEEDED"); }) }),
      config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", maxSteps: 1,
      recoverOverflow: async () => {
        const original = session.snapshot().events.find((e) => e.type === "user/message"); assert.ok(original);
        session.append({ type: "user/message", surfaceOp: { op: "replace", start: original.seq, end: original.seq }, sourceEventSeqs: [original.seq], data: { id: "summary", role: "user", source: { kind: "compact", compactionId: "c" }, content: [{ type: "text", text: "摘要" }] } });
        if (boundary === "recover") { entered(); await gate; }
        return true;
      },
    });
    const handle = { id: boundary, header: session.header, access: "write" as const, inheritedEventCount: 0,
      read: async () => [], append: async () => {}, flush: async () => {}, close: async () => {} };
    const agent = new ReActAgent(session, driver, handle);
    agent.prompt({ requestId: "r", content: [{ type: "text", text: "原文" }] });
    await waiting; agent.blockStorage(new Error("blocked")); release(); await agent.waitForIdle();
    assert.equal(calls, 1); assert.equal(agent.storageOpen, false);
    const events = session.snapshot().events;
    assert.equal(events.filter((e) => e.type === "assistant/attempt").length, 1);
    assert.deepEqual(events.filter((e) => e.type === "request/header").map((e) => e.data.reason), boundary === "flush" ? ["initial", "series"] : ["initial"]);
    assert.equal(checkpoints, boundary === "flush" ? 2 : 1);
    await agent.stop();
  }
});

test("恢复等待取消或拒绝 AbortError 保留首次结算并以 aborted 结束", async () => {
  for (const mode of ["signal", "reject"] as const) {
    const session = new Session({ sessionId: mode, createdAt: 0 }); session.bindCheckpoint(async () => {});
    const controller = new AbortController(); let calls = 0; const notices: ExecutionNotice[] = [];
    await createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { calls++; throw new LlmError("CONTEXT_WINDOW_EXCEEDED"); }) }),
      config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "",
      recoverOverflow: async () => { if (mode === "signal") { controller.abort(); return true; } throw Object.assign(new Error("cancel"), { name: "AbortError" }); },
    })({ session, turn: 1, step: 1, signal: controller.signal, publish: (notice) => notices.push(notice), blockStorage: () => {} });
    const events = session.snapshot().events; const attempt = events.find((e) => e.type === "assistant/attempt");
    assert.equal(calls, 1); assert.ok(attempt);
    const end = notices.find((n) => n.type === "assistant/end"); assert.ok(end?.type === "assistant/end" && end.outcome.kind === "committed" && end.outcome.seq === attempt.seq);
    const last = events.at(-1); assert.equal(last?.type === "turn/end" && last.data.reason.kind, "aborted");
  }
});

test("pre-step 固定配置但请求使用等待期间替换后的消息", async () => {
  const session = new Session({ sessionId: "snapshot", createdAt: 0 });
  session.append({ type: "user/message", surfaceOp: "append", data: { turn: 1, requestId: "r", id: "u", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "原文" }] } });
  session.bindCheckpoint(async () => {});
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }); const waiting = new Promise<void>((resolve) => { entered = resolve; });
  let model = "old"; let system = "旧系统"; const schema = { properties: { x: { type: "string" } } }; const requests: ModelRequest[] = [];
  const running = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter((request) => { requests.push(request); return [{ chunk: { type: "text", delta: "ok" } }, { chunk: { type: "finish", reason: { kind: "stop" } } }]; }) }),
    config: () => ({ provider: "mock", model, params: { maxOutputTokens: 10 } }), systemPrompt: () => system, tools: () => [{ name: "t", inputSchema: schema }],
    preStep: async ({ header }) => { assert.equal(header.config.model, "old"); assert.equal(Object.isFrozen(header.tools?.[0]), true); entered(); await gate; },
  })({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => {} });
  await waiting;
  session.append({ type: "user/message", surfaceOp: { op: "replace", start: 0, end: 0 }, sourceEventSeqs: [0], data: { id: "summary", role: "user", source: { kind: "compact", compactionId: "c" }, content: [{ type: "text", text: "摘要" }] } });
  model = "new"; system = "新系统"; schema.properties.x.type = "number"; release(); await running;
  assert.equal(requests[0]?.route.model, "old"); assert.equal(requests[0]?.systemPrompt, "旧系统");
  assert.deepEqual(requests[0]?.tools[0]?.inputSchema, { properties: { x: { type: "string" } } });
  assert.deepEqual(requests[0]?.messages, [{ role: "user", text: "摘要" }]);
});

test("后续 pre-step 期间取消不会打开下一步", async () => {
  for (const mode of ["return", "reject"] as const) {
    const session = new Session({ sessionId: mode, createdAt: 0 }); let checkpoints = 0; let checkpointEvents: string[] = [];
    session.bindCheckpoint(async () => { checkpoints++; checkpointEvents = session.snapshot().events.map((e) => e.type); });
    const controller = new AbortController(); let calls = 0; let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { calls++; return [{ chunk: { type: "tool_call", index: 0, callId: "c", name: "lookup", argumentsDelta: "{}" } }, { chunk: { type: "finish", reason: { kind: "tool_calls" } } }]; }) }),
      config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: testRegistry(() => "结果"),
      preStep: async ({ step }) => { if (step === 2) { assert.ok(checkpointEvents.includes("tool/result") && checkpointEvents.includes("step/end")); entered(); await gate; if (mode === "reject") throw Object.assign(new Error("cancel"), { name: "AbortError" }); } },
    })({ session, turn: 1, step: 1, signal: controller.signal, publish: () => {}, blockStorage: () => assert.fail() });
    await waiting; controller.abort(); release(); await running;
    assert.equal(calls, 1); assert.ok(checkpoints > 0);
    const events = session.snapshot().events; assert.deepEqual(events.filter((e) => e.type === "step/start").map((e) => e.data.step), [1]);
    assert.deepEqual(events.filter((e) => e.type === "step/end").map((e) => e.data.step), [1]);
    const last = events.at(-1); assert.equal(last?.type === "turn/end" && last.data.reason.kind, "aborted");
  }
});

test("每个工具续答 Step 各有一次超限恢复机会", async () => {
  const session = new Session({ sessionId: "two", createdAt: 0 }); session.bindCheckpoint(async () => {});
  let calls = 0; const hooks: number[] = []; const recoveries: number[] = [];
  await createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => {
    calls++; if (calls === 1 || calls === 3) throw new LlmError("CONTEXT_WINDOW_EXCEEDED");
    return calls === 2 ? [{ chunk: { type: "tool_call", index: 0, callId: "c", name: "lookup", argumentsDelta: "{}" } }, { chunk: { type: "finish", reason: { kind: "tool_calls" } } }] : [{ chunk: { type: "text", delta: "完成" } }, { chunk: { type: "finish", reason: { kind: "stop" } } }];
  }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: testRegistry(() => "结果"), maxSteps: 2,
    preStep: async ({ step }) => { hooks.push(step); }, recoverOverflow: async ({ step }) => { recoveries.push(step); return true; },
  })({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => assert.fail() });
  assert.equal(calls, 4); assert.deepEqual(hooks, [1, 2]); assert.deepEqual(recoveries, [1, 2]);
  const events = session.snapshot().events; assert.deepEqual(events.filter((e) => e.type === "assistant/attempt").map((e) => e.data.step), [1, 2]);
  assert.deepEqual(events.filter((e) => e.type === "step/start").map((e) => e.data.step), [1, 2]);
});

test("检查点等待取消后失败仍以存储故障结算", async () => {
  for (const [error, code] of [[Object.assign(new Error("secret"), { code: "SQLITE_BUSY" }), "SQLITE_BUSY"], [new Error("secret"), "UNKNOWN"]] as const) {
    const session = new Session({ sessionId: code, createdAt: 0 }); const controller = new AbortController();
    let entered!: () => void; let reject!: (error: Error) => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    session.bindCheckpoint(() => { entered(); return new Promise<void>((_resolve, fail) => { reject = fail; }); });
    let calls = 0; let blocked = false; const notices: ExecutionNotice[] = [];
    const running = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { calls++; return []; }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "" })({ session, turn: 1, step: 1, signal: controller.signal, publish: (notice) => notices.push(notice), blockStorage: () => { blocked = true; } });
    await waiting; controller.abort(); reject(error); await running;
    assert.equal(calls, 0); assert.equal(blocked, true);
    assert.deepEqual(notices, [{ type: "agent/error", turn: 1, message: "本轮执行失败" }]);
    const last = session.snapshot().events.at(-1);
    assert.equal(last?.type === "turn/end" && last.data.reason.kind === "error" && last.data.reason.error.code, code);
  }
});

test("驱动入口信号已取消不调用 pre-step 或准备配置", async () => {
  const session = new Session({ sessionId: "cancelled", createdAt: 0 }); const controller = new AbortController(); controller.abort();
  let hooks = 0; let configs = 0;
  await createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => []) }), config: () => { configs++; return { provider: "mock", model: "m" }; }, systemPrompt: () => "", preStep: async () => { hooks++; } })({ session, turn: 1, step: 1, signal: controller.signal, publish: () => {}, blockStorage: () => {} });
  assert.equal(hooks, 0); assert.equal(configs, 0);
  assert.deepEqual(session.snapshot().events.map((event) => event.type), ["turn/end"]);
  const last = session.snapshot().events.at(-1); assert.equal(last?.type === "turn/end" && last.data.reason.kind, "aborted");
});

test("pre-step 无法污染恢复回调的步上下文", async () => {
  const session = new Session({ sessionId: "hook", createdAt: 0 }); session.bindCheckpoint(async () => {});
  const other = new Session({ sessionId: "other", createdAt: 0 }); let observed: { session: Session; turn: number; step: number; model: string | undefined } | undefined;
  await createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { throw new LlmError("CONTEXT_WINDOW_EXCEEDED"); }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "",
    preStep: async (context) => { Reflect.set(context, "session", other); Reflect.set(context, "turn", 42); Reflect.set(context, "step", 99); Reflect.set(context, "header", {}); },
    recoverOverflow: async (context) => { observed = { session: context.session, turn: context.turn, step: context.step, model: context.header.config?.model }; return false; },
  })({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => {} });
  assert.deepEqual(observed, { session, turn: 1, step: 1, model: "m" });
});

test("恢复回调不能修改原始业务失败终态", async () => {
  const session = new Session({ sessionId: "failure", createdAt: 0 }); session.bindCheckpoint(async () => {});
  await createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { throw new LlmError("CONTEXT_WINDOW_EXCEEDED"); }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "",
    recoverOverflow: async ({ failure }) => { Reflect.set(failure, "code", "AUTH"); Reflect.set(failure, "message", "篡改"); return false; },
  })({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => {} });
  const last = session.snapshot().events.at(-1);
  assert.equal(last?.type === "turn/end" && last.data.reason.kind === "error" && last.data.reason.error.code, "CONTEXT_WINDOW_EXCEEDED");
  assert.equal(last?.type === "turn/end" && last.data.reason.kind === "error" && last.data.reason.error.message, "Provider input context window exceeded");
});

test("恢复回调异常时保留已结算超限错误", async () => {
  const session = new Session({ sessionId: "recover-error", createdAt: 0 }); session.bindCheckpoint(async () => {});
  let calls = 0; const notices: ExecutionNotice[] = [];
  await createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { calls++; throw new LlmError("CONTEXT_WINDOW_EXCEEDED"); }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", recoverOverflow: async () => { throw new Error("private"); } })({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: (notice) => notices.push(notice), blockStorage: () => assert.fail() });
  const events = session.snapshot().events; const attempt = events.find((event) => event.type === "assistant/attempt"); const end = events.at(-1);
  assert.equal(calls, 1); assert.ok(attempt); assert.equal(end?.type === "turn/end" && end.data.reason.kind === "error" && end.data.reason.error.code, "CONTEXT_WINDOW_EXCEEDED");
  assert.equal(notices.some((notice) => notice.type === "agent/error"), false);
  assert.doesNotMatch(JSON.stringify([events, notices]), /private/);
});

test("审批渠道独立 AbortError 不冒充用户取消", async () => {
  const { ApprovalService } = await import("../approval/service.ts");
  const session = new Session({ sessionId: "approval-abort", createdAt: 0 }); session.bindCheckpoint(async () => {});
  const registry = new ToolRegistry(); let executed = 0;
  registry.register(defineLocalTool({ name: "lookup", version: "1", description: "lookup", input: z.strictObject({}), timeoutMs: 100, sideEffect: "read-only", approvalPolicy: "ask", output: defineLocalToolOutput({ schema: z.string(), render: (_args, value) => [{ type: "text", text: value }] }), handler: () => { executed++; return "ok"; } }));
  const notices: ExecutionNotice[] = [];
  await createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => [{ chunk: { type: "tool_call", index: 0, callId: "c", name: "lookup", argumentsDelta: "{}" } }, { chunk: { type: "finish", reason: { kind: "tool_calls" } } }]) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: registry, approvalService: new ApprovalService(async () => { throw Object.assign(new Error("private"), { name: "AbortError" }); }) })({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: (notice) => notices.push(notice), blockStorage: () => assert.fail() });
  const end = session.snapshot().events.at(-1);
  assert.equal(end?.type === "turn/end" && end.data.reason.kind, "error"); assert.equal(executed, 0);
  assert.ok(notices.some((notice) => notice.type === "agent/error"));
});

test("读取配置期间同步取消不会调用 pre-step", async () => {
  const session = new Session({ sessionId: "config-abort", createdAt: 0 }); const controller = new AbortController(); let hooks = 0;
  await createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => []) }), config: () => { controller.abort(); return { provider: "mock", model: "m" }; }, systemPrompt: () => "", preStep: async () => { hooks++; } })({ session, turn: 1, step: 1, signal: controller.signal, publish: () => {}, blockStorage: () => {} });
  assert.equal(hooks, 0); assert.deepEqual(session.snapshot().events.map((event) => event.type), ["turn/end"]);
  const end = session.snapshot().events.at(-1); assert.equal(end?.type === "turn/end" && end.data.reason.kind, "aborted");
});

test("hook 明确 AbortError 即使信号未触发也视为取消", async () => {
  const session = new Session({ sessionId: "hook-abort", createdAt: 0 }); let calls = 0;
  await createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { calls++; return []; }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", preStep: async () => { throw Object.assign(new Error("cancel"), { name: "AbortError" }); } })({ session, turn: 1, step: 1, signal: new AbortController().signal, publish: () => {}, blockStorage: () => {} });
  assert.equal(calls, 0); assert.deepEqual(session.snapshot().events.map((event) => event.type), ["turn/end"]);
  const end = session.snapshot().events.at(-1); assert.equal(end?.type === "turn/end" && end.data.reason.kind, "aborted");
});

test("恢复异常时存储门已关闭仍安全失败并阻止重试", async () => {
  const session = new Session({ sessionId: "recovery-blocked", createdAt: 0 }); session.bindCheckpoint(async () => {});
  let open = true; let calls = 0; const notices: ExecutionNotice[] = [];
  await createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => { calls++; throw new LlmError("CONTEXT_WINDOW_EXCEEDED"); }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", recoverOverflow: async () => { open = false; throw new Error("private"); } })({ session, turn: 1, step: 1, signal: new AbortController().signal, storageOpen: () => open, publish: (notice) => notices.push(notice), blockStorage: () => {} });
  assert.equal(calls, 1); assert.equal(open, false); assert.ok(notices.some((notice) => notice.type === "agent/error"));
  const end = session.snapshot().events.at(-1); assert.equal(end?.type === "turn/end" && end.data.reason.kind === "error" && end.data.reason.error.code, "UNKNOWN");
});
