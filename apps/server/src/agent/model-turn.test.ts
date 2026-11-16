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
      "request/header",
      "assistant/message",
      "step/end",
      "turn/end",
    ],
  );
  assert.deepEqual(
    notices.map((n) => n.type),
    ["assistant/start", "assistant/chunk", "assistant/chunk", "assistant/end"],
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
        yield { type: "text" as const, delta: "前" };
        yield { type: "text" as const, delta: "缀" };
        if (finish.kind === "output_limit")
          yield { type: "finish" as const, reason: finish };
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
    assert.ok(attempt && "chunks" in Object(attempt.data.stream[0]));
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
      return [{ chunk: { type: "finish", reason: { kind: "stop" } } }];
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
      return [{ chunk: { type: "finish", reason: { kind: "stop" } } }];
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
  assert.equal(end.index, 3);
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
        : [{ chunk: { type: "finish", reason: { kind: "stop" } } }];
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
  assert.equal(events.filter((e) => e.type === "step/start").length, 1);
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
  assert.equal(events.some((e) => e.type === "step/start"), false);
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
  assert.equal(events.find((e) => e.type === "tool/result")?.data.error?.code, "TOOL_NOT_STARTED");
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
    ] : [{ chunk: { type: "finish", reason: { kind: "stop" } } }]) }),
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

test("非法工具分片只进入诊断流，所有实时帧和活动快照符合协议", async () => {
  const invalidChunks = [
    { type: "tool_call" as const, index: -1, callId: "c", name: "tool", argumentsDelta: "{}" },
    { type: "tool_call" as const, index: Number.MAX_SAFE_INTEGER + 1, callId: "c", name: "tool", argumentsDelta: "{}" },
    { type: "tool_call" as const, index: 0, callId: "", name: "tool", argumentsDelta: "{}" },
    { type: "tool_call" as const, index: 0, callId: "c", name: "", argumentsDelta: "{}" },
    { type: "tool_call" as const, index: 0, callId: "other", name: "tool", argumentsDelta: "x" },
    { type: "tool_call" as const, index: 0, callId: "c", name: "other", argumentsDelta: "x" },
  ];
  for (const [i, bad] of invalidChunks.entries()) {
    const session = new Session({ sessionId: `malformed-${i}`, createdAt: 0 });
    session.bindCheckpoint(async () => {});
    const first = { type: "tool_call" as const, index: 0, callId: "c", name: "tool", argumentsDelta: "{" };
    const chunks = i >= 4 ? [first, bad] : [bad];
    const notices: ExecutionNotice[] = [];
    const { followFrameSchema } = await import("@mharness/session/contracts");
    const active: Extract<ExecutionNotice, { type: "assistant/chunk" }>["chunk"][] = [];
    const validity: boolean[] = [];
    let revision = 0;
    let attemptId = "";
    await createModelTurnDriver({
      runtime: new LlmRuntime({ mock: createMockAdapter(() => chunks.map((chunk) => ({ chunk }))) }),
      config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "",
    })({ session, turn: 1, step: 1, signal: new AbortController().signal, blockStorage: () => assert.fail(), publish: (notice) => {
      notices.push(notice);
      if (notice.type === "agent/error") { validity.push(followFrameSchema.safeParse(notice).success); return; }
      const { type, ...rest } = notice;
      if (type === "assistant/start") attemptId = notice.attemptId;
      if (notice.type === "assistant/chunk") active.push(notice.chunk);
      const frame = { type: type.slice("assistant/".length), ...rest, revision: ++revision };
      validity.push(followFrameSchema.safeParse({ type: "assistant-stream", frame }).success);
      if (notice.type !== "assistant/end") validity.push(followFrameSchema.safeParse({ type: "snapshot", sessionId: `malformed-${i}`, inheritedEventCount: 0, cursor: -1, records: [], assistantStream: { revision, activeAttempt: { attemptId, turn: 1, step: 1, chunks: active, nextIndex: active.length } } }).success);
    } });
    assert.ok(validity.every(Boolean));
    assert.equal(notices.at(-1)?.type, "assistant/end");
    assert.equal(notices.filter((notice) => notice.type === "assistant/chunk").length, i >= 4 ? 1 : 0);
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
  const { followFrameSchema } = await import("@mharness/session/contracts");
  for (const [i, index] of [NaN, Infinity, -Infinity, -0].entries()) {
    const session = new Session({ sessionId: `non-json-index-${i}`, createdAt: 0 });
    session.bindCheckpoint(async () => {});
    const first = { type: "text" as const, delta: "前缀" };
    const bad = { type: "tool_call" as const, index, callId: "c", name: "tool", argumentsDelta: "{}" };
    const notices: ExecutionNotice[] = [];
    const valid: boolean[] = [];
    const active: Extract<ExecutionNotice, { type: "assistant/chunk" }>["chunk"][] = [];
    let revision = 0;
    let attemptId = "";
    await createModelTurnDriver({
      runtime: new LlmRuntime({ mock: createMockAdapter(() => [{ chunk: first }, { chunk: bad }]) }),
      config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "",
    })({ session, turn: 1, step: 1, signal: new AbortController().signal, blockStorage: () => assert.fail(), publish: (notice) => {
      notices.push(notice);
      if (notice.type === "agent/error") { valid.push(followFrameSchema.safeParse(notice).success); return; }
      const { type, ...rest } = notice;
      if (notice.type === "assistant/start") attemptId = notice.attemptId;
      if (notice.type === "assistant/chunk") active.push(notice.chunk);
      valid.push(followFrameSchema.safeParse({ type: "assistant-stream", frame: { type: type.slice("assistant/".length), ...rest, revision: ++revision } }).success);
      if (notice.type !== "assistant/end") valid.push(followFrameSchema.safeParse({ type: "snapshot", sessionId: `non-json-index-${i}`, inheritedEventCount: 0, cursor: -1, records: [], assistantStream: { revision, activeAttempt: { attemptId, turn: 1, step: 1, chunks: active, nextIndex: active.length } } }).success);
    } });
    assert.ok(valid.every(Boolean));
    assert.deepEqual(active, [first]);
    const attempts = session.snapshot().events.filter((event) => event.type === "assistant/attempt");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.data.outcome, "failed");
    assert.equal((attempts[0]?.data.reason as { code?: string }).code, "PROTOCOL");
    assert.ok(JSON.stringify(attempts[0]?.data.stream).includes(JSON.stringify(first)));
    const ends = notices.filter((notice) => notice.type === "assistant/end");
    assert.equal(ends.length, 1);
    assert.ok(ends[0]?.type === "assistant/end" && ends[0].outcome.kind === "committed");
    assert.equal(ends[0].outcome.eventType, "assistant/attempt");
    assert.equal(ends[0].outcome.seq, attempts[0]?.seq);
    const turnEnds = session.snapshot().events.filter((event) => event.type === "turn/end");
    assert.equal(turnEnds.length, 1);
    const reason = turnEnds[0]?.data.reason;
    assert.equal(reason?.kind, "error");
    assert.equal(reason?.kind === "error" && reason.error.code, "PROTOCOL");
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
  assert.equal(events.filter((event) => event.type === "step/start").length, 0);
});
