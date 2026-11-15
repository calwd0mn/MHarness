import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionAppendInput } from "../../../../packages/session/src/events.ts";
import { Session, SessionStore } from "../../../../packages/session/src/session.ts";

const header = { sessionId: "session-1", createdAt: 100 };

test("拒绝不能无损保存的事件，且成功事件的序号与通知连续", () => {
  const session = new Session(header);
  const notified: number[] = [];
  session.on("session/event", (event) => notified.push(event.seq));
  const cyclic: { turn: number; step: number; self?: unknown } = { turn: 1, step: 1 };
  cyclic.self = cyclic;
  const accessor = { turn: 1, get step(): number { throw new Error("不应读取访问器"); } };

  session.append({ type: "turn/start", data: { turn: 1 } });
  assert.throws(
    // @ts-expect-error 绕过静态检查，验证运行时会拒绝循环引用。
    () => session.append({ type: "step/start", data: cyclic }),
    /JSON/,
  );
  const undefinedProperty = { turn: 1, step: 1, extra: undefined };
  assert.throws(
    // @ts-expect-error 绕过静态检查，验证运行时会拒绝丢失属性的输入。
    () => session.append({ type: "step/start", data: undefinedProperty }),
    /JSON/,
  );
  assert.throws(() => session.append({ type: "step/start", data: { turn: 1, step: Infinity } }), /JSON/);
  assert.throws(() => session.append({ type: "step/start", data: accessor }), /JSON/);
  session.append({ type: "step/start", data: { turn: 1, step: 1 } });

  assert.deepEqual(session.snapshot().events.map((event) => event.seq), [0, 1]);
  assert.deepEqual(notified, [0, 1]);
  assert.equal(session.seq, 2);
});

test("字段错配的事件及调用方提供的序号均被拒绝", () => {
  const session = new Session(header);
  const notified: number[] = [];
  session.on("session/event", (event) => notified.push(event.seq));
  const turnEnd = { turn: 1, reason: { kind: "completed" } } as const;
  const record = { type: "turn/start", seq: 1, time: 200, data: { turn: 1 } } as const;

  assert.throws(
    // @ts-expect-error Step 开始事件不能使用 Turn 终态的载荷。
    () => session.append({ type: "step/start", data: turnEnd }),
    /step/,
  );
  assert.throws(
    // @ts-expect-error 已存入变量的 Turn 终态载荷仍不能用于 Turn 开始事件。
    () => session.append({ type: "turn/start", data: turnEnd }),
    /reason/,
  );
  assert.throws(
    // @ts-expect-error 工具调用必须提供 callId。
    () => session.append({ type: "tool/call", data: { turn: 1, step: 1, name: "read", arguments: "{}" } }),
    /callId/,
  );
  assert.throws(
    // @ts-expect-error 调用方不能把带序号的记录作为追加输入。
    () => session.append(record),
    /序号由会话分配/,
  );
  assert.throws(
    // @ts-expect-error 显式提供 seq 即使值为 undefined 也违反序号所有权。
    () => session.append({ type: "turn/start", data: { turn: 1 }, seq: undefined }),
    /JSON/,
  );

  assert.equal(session.append({ type: "turn/start", data: { turn: 1 } }).seq, 0);
  assert.deepEqual(notified, [0]);
});

test("范围快照保留读取截点，已接受的数据与原输入隔离", () => {
  const session = new Session(header);
  assert.deepEqual(session.snapshot(), { cursor: -1, events: [] });
  assert.throws(() => new Session({ ...header, createdAt: Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => session.append({ type: "turn/start", time: -1, data: { turn: 1 } }));
  assert.throws(() => session.append({ type: "turn/start", time: 1.5, data: { turn: 1 } }));
  assert.throws(() => session.append({
    type: "turn/start", time: Number.MAX_SAFE_INTEGER + 1, data: { turn: 1 },
  }));
  const data = { turn: 1 };
  const first = session.append({ type: "turn/start", time: 200, data });
  data.turn = 2;
  session.append({ type: "step/start", data: { turn: 1, step: 1 } });
  session.append({ type: "step/start", data: { turn: 1, step: 2 } });

  const snapshot = session.snapshot(1, 2);
  assert.equal(snapshot.cursor, 2);
  assert.deepEqual(snapshot.events.map((event) => event.seq), [1]);
  assert.equal(session.seq, 3);
  assert.deepEqual(first, { type: "turn/start", seq: 0, time: 200, data: { turn: 1 } });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.data), true);
  assert.throws(() => session.snapshot(2, 1), RangeError);
  assert.throws(() => session.snapshot(0, 4), RangeError);
  session.append({ type: "turn/start", data: { turn: 2 } });
  assert.equal(snapshot.cursor, 2);
  assert.deepEqual(snapshot.events.map((event) => event.seq), [1]);
});

test("会话日志保留请求、原始工具调用、审批和工具结果记录", () => {
  const session = new Session(header);
  const opaquePresentationData = { ["__proto__"]: { label: "保持为自有属性" } };
  const events = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "user/message", surfaceOp: "append", data: {
      id: "msg-user", role: "user", source: { kind: "user" }, turn: 1, requestId: "req-1",
      content: [{ type: "text", text: "读取设备" }],
    } },
    { type: "request/header", data: {
      header: { config: { provider: "mock", model: "demo" } }, reason: "initial",
    } },
    { type: "assistant/message", surfaceOp: "append", data: {
      turn: 1, step: 1, message: {
        id: "msg-assistant", role: "assistant", source: { provider: "mock", model: "demo" },
        content: [{ type: "tool-call", id: "call-1", name: "read", arguments: '{ "id": 1 }' }],
      },
      finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true,
    } },
    { type: "tool/call", data: { turn: 1, step: 1, callId: "call-1", name: "read", arguments: '{ "id": 1 }' } },
    { type: "tool/operation", data: {
      turn: 1, step: 1, callId: "call-1", operationId: "op-1", toolName: "read",
      toolVersion: "1", validatedArgs: { id: 1 },
    } },
    { type: "approval/asked", data: { id: "approval-1", operationId: "op-1", toolName: "read", reason: "policy" } },
    { type: "approval/decided", data: { id: "approval-1", outcome: "rejected" } },
    { type: "tool/result", surfaceOp: "append", sourceEventSeqs: [5], data: {
      turn: 1, step: 1, operationId: "op-1",
      message: {
        id: "msg-result", role: "user", source: { kind: "tool", callId: "call-1" },
        content: [{ type: "tool-result", toolCallId: "call-1", isError: true,
          content: [{ type: "text", text: "审批被拒绝" }] }],
      },
      error: { name: "ToolError", code: "REJECTED" },
      meta: opaquePresentationData,
    } },
  ] as const satisfies readonly SessionAppendInput[];
  for (const event of events) session.append({ ...event, time: 200 });

  assert.deepEqual(session.snapshot().events, events.map((event, seq) => ({ ...event, seq, time: 200 })));
  const assistant = session.snapshot().events[4];
  assert.equal(assistant?.type, "assistant/message");
  if (assistant.type === "assistant/message") {
    assert.equal(Object.isFrozen(assistant.data.message.content[0]), true);
    assert.equal(Object.isFrozen(events[4]?.data.message), false);
  }
  assert.throws(() => session.append({
    type: "tool/call", data: { turn: 1, step: 1, callId: "call-1", name: "read", arguments: '{"id":1}' },
  }), /声明/);
  assert.equal(session.seq, 10);
});

test("Assistant 消息追加和重放只接受约定的模型路由字段", () => {
  const store = new SessionStore();
  const session = store.prepare(header);
  const source = { provider: "mock", model: "demo", endpointId: "local-mock" };
  const candidate = {
    type: "assistant/message",
    surfaceOp: "append",
    time: 200,
    data: {
      turn: 1, step: 1,
      message: { id: "msg-assistant", role: "assistant", source, content: [] },
      finishReason: { kind: "stop" }, stream: [], includeInModelContext: true,
    },
  } as const satisfies SessionAppendInput;
  const withCredential = {
    ...candidate,
    data: {
      ...candidate.data,
      message: { ...candidate.data.message, source: { ...source, apiKey: "test-only-sentinel" } },
    },
  };

  assert.throws(() => session.append(withCredential), /apiKey/);
  const record = session.append(candidate);
  assert.deepEqual(record, { ...candidate, seq: 0 });
  const restored = store.prepare(header, { kind: "restore", events: [record], inheritedEventCount: 0 });
  assert.deepEqual(restored.snapshot().events, [record]);
  assert.throws(() => store.prepare(header, {
    kind: "restore", events: [{ ...withCredential, seq: 0 }], inheritedEventCount: 0,
  }), /apiKey/);
});

test("压缩摘要追加和重放只接受约定的模型路由字段", () => {
  const store = new SessionStore();
  const session = store.prepare(header);
  const route = { provider: "mock", model: "demo", endpointId: "local-mock" };
  const candidate = {
    type: "compaction/summary",
    time: 200,
    data: {
      compactionId: "compaction-1", summary: "摘要", shadowedRange: { start: 0, end: 0 },
      shadowedSeqs: [0], route,
    },
  } as const satisfies SessionAppendInput;
  const withCredential = {
    ...candidate,
    data: { ...candidate.data, route: { ...route, apiKey: "test-only-sentinel" } },
  };

  assert.throws(() => session.append(withCredential), /apiKey/);
  const record = session.append(candidate);
  assert.deepEqual(record, { ...candidate, seq: 0 });
  const restored = store.prepare(header, { kind: "restore", events: [record], inheritedEventCount: 0 });
  assert.deepEqual(restored.snapshot().events, [record]);
  assert.throws(() => store.prepare(header, {
    kind: "restore", events: [{ ...withCredential, seq: 0 }], inheritedEventCount: 0,
  }), /apiKey/);
});

test("发布时可以读取完整的已准备会话，重复发布不能覆盖已有实例", () => {
  const store = new SessionStore();
  const published: string[] = [];
  const session = store.prepare(header);
  const duplicate = store.prepare(header);
  session.append({ type: "turn/start", data: { turn: 1 } });
  store.on("session/created", (entry) => {
    assert.equal(store.get(entry.header.sessionId), entry);
    assert.equal(entry.snapshot().cursor, 0);
    published.push(entry.header.sessionId);
  });

  assert.equal(store.get(header.sessionId), undefined);
  store.publish(session);
  assert.equal(store.get(header.sessionId), session);
  assert.throws(() => store.publish(duplicate), /已发布/);
  assert.equal(store.get(header.sessionId), session);
  assert.deepEqual(published, [header.sessionId]);
});

test("派发使用注册快照，监听器异常与重入不会影响后续监听器", async () => {
  const errors: unknown[] = [];
  const notifications: string[] = [];
  const session = new Session(header, { reportError: (error) => errors.push(error) });
  const failure = new Error("监听失败");
  let stopSecond = () => {};
  session.on("session/event", (event) => {
    notifications.push(`first:${event.seq}`);
    if (event.seq !== 0) return;
    stopSecond();
    session.on("session/event", (next) => notifications.push(`late:${next.seq}`));
    session.append({ type: "turn/start", data: { turn: 99 } });
  });
  stopSecond = session.on("session/event", (event) => notifications.push(`second:${event.seq}`));
  session.on("session/event", () => { throw failure; });
  session.on("session/event", async (event) => {
    if (event.seq === 0) throw new Error("异步监听失败");
  });
  session.on("session/event", (event) => notifications.push(`last:${event.seq}`));

  session.append({ type: "turn/start", data: { turn: 1 } });
  session.append({ type: "step/start", data: { turn: 1, step: 1 } });
  assert.deepEqual(notifications, ["first:0", "second:0", "last:0", "first:1", "last:1", "late:1"]);
  assert.equal(session.seq, 2);
  assert.match(String(errors[0]), /不允许重入/);
  assert.equal(errors[1], failure);
  assert.equal(errors[2], failure);
  await Promise.resolve();
  assert.match(String(errors[3]), /异步监听失败/);
});

test("嵌套分支按自身继承数划界，初始化前缀只随快照交付", () => {
  const store = new SessionStore();
  const parent = store.prepare(header);
  for (let index = 0; index < 10; index++) {
    parent.append({ type: "turn/start", time: 200 + index, data: { turn: index + 1 } });
  }
  const child = store.prepare(
    { sessionId: "child", createdAt: 1000, isSeeded: true, parentSession: header.sessionId },
    { kind: "fork", events: parent.snapshot().events },
  );
  const childSnapshot = child.snapshot();
  assert.equal(child.inheritedEventCount, 10);
  assert.deepEqual(childSnapshot.events.slice(0, 10), parent.snapshot().events);
  assert.deepEqual(childSnapshot.events[10], {
    type: "session/end-seed", seq: 10, time: 1000, data: { inherited: true },
  });

  const grandchild = store.prepare(
    { sessionId: "grandchild", createdAt: 1100, isSeeded: true, parentSession: "child" },
    { kind: "fork", events: childSnapshot.events },
  );
  let cursorOnPublish = -1;
  const notifications: number[] = [];
  grandchild.on("session/event", (event) => notifications.push(event.seq));
  store.on("session/created", (session) => { cursorOnPublish = session.snapshot().cursor; });
  store.publish(grandchild);
  grandchild.append({ type: "turn/start", data: { turn: 11 } });

  assert.equal(grandchild.inheritedEventCount, 11);
  assert.equal(cursorOnPublish, 11);
  assert.deepEqual(grandchild.snapshot().events.slice(0, 11), childSnapshot.events);
  assert.equal(grandchild.snapshot().events[11]?.type, "session/end-seed");
  assert.deepEqual(notifications, [12]);
});

test("恢复校验事件类型、原序号和分支标记，成功时保留已保存的前缀", () => {
  const store = new SessionStore();
  const start = { type: "turn/start", seq: 0, time: 200, data: { turn: 1 } };
  const marker = { type: "session/end-seed", seq: 1, time: 201, data: { inherited: true } };
  const childHeader = { sessionId: "child", createdAt: 300, isSeeded: true, parentSession: "session-1" } as const;
  assert.throws(() => store.prepare(header, {
    kind: "restore", inheritedEventCount: 0, events: [{ ...start, type: "unknown/event" }],
  }), /type/);
  assert.throws(() => store.prepare(header, {
    kind: "restore", inheritedEventCount: 0, events: [{ ...start, seq: 1 }],
  }), /序号不连续/);
  assert.throws(() => store.prepare(childHeader, {
    kind: "restore", inheritedEventCount: 0, events: [start, marker],
  }), /继承标记/);

  const restored = store.prepare(childHeader, {
    kind: "restore", inheritedEventCount: 1, events: [start, marker],
  });
  assert.equal(restored.inheritedEventCount, 1);
  assert.deepEqual(restored.snapshot(), { cursor: 1, events: [start, marker] });
  assert.equal(restored.append({ type: "step/start", data: { turn: 1, step: 1 } }).seq, 2);
});
