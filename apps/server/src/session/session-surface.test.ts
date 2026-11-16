import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "../../../../packages/session/src/session.ts";

const header = { sessionId: "surface", createdAt: 1 };
const user = (id: string) => ({ type: "user/message", surfaceOp: "append", data: { id, role: "user", source: { kind: "user" }, turn: 1, requestId: id, content: [{ type: "text", text: id }] } } as const);
const replace = (start: number, end: number, sourceEventSeqs: number[]) => ({ type: "user/message", surfaceOp: { op: "replace", start, end }, sourceEventSeqs, data: { id: "summary", role: "user", source: { kind: "compact", compactionId: "c" }, content: [{ type: "text", text: "summary" }] } } as const);

test("surface 替换验证来源、保持原日志并可重放", () => {
 const s = new Session(header);
 s.append(user("a")); s.append(user("b")); s.append(user("c"));
 const first = s.deriveMessages();
 assert.throws(() => s.append(replace(0, 1, [0])));
 assert.throws(() => s.append(replace(0, 1, [0, 1, 1])));
 assert.equal(s.seq, 3);
 s.append(replace(0, 1, [0, 1]));
 assert.equal(s.replaceGeneration, 1);
 const messages = s.deriveMessages();
 assert.deepEqual(messages.map((m) => m.id), ["summary", "c"]);
 assert.equal(messages[1], first[2]);
 messages.pop();
 assert.equal(s.deriveMessages().length, 2);
 const replay = new Session(header, { seed: { kind: "restore", events: s.snapshot().events, inheritedEventCount: 0 } });
 assert.deepEqual(replay.deriveMessages(), s.deriveMessages());
 assert.equal(replay.replaceGeneration, 1);
 assert.equal(s.snapshot().events.length, 4);
});

test("工具配对不可拆散，结果替换仅允许改变 content", () => {
 const s = new Session(header);
 s.append({ type: "assistant/message", surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "a", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "tool-call", id: "call", name: "read", arguments: "{}" }] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true } });
 const result = { type: "tool/result", surfaceOp: "append", sourceEventSeqs: [0], data: { turn: 1, step: 1, message: { id: "r", role: "user", source: { kind: "tool", callId: "call" }, content: [{ type: "tool-result", toolCallId: "call", isError: false, content: ["old"] }] } } } as const;
 s.append(result);
 assert.throws(() => s.append(replace(0, 0, [0])));
 assert.throws(() => s.append({ ...result, surfaceOp: { op: "replace", start: 1, end: 1 }, sourceEventSeqs: [1], data: { ...result.data, message: { ...result.data.message, id: "changed" } } }));
 s.append({ ...result, surfaceOp: { op: "replace", start: 1, end: 1 }, sourceEventSeqs: [1], data: { ...result.data, message: { ...result.data.message, content: [{ ...result.data.message.content[0], content: ["new"] }] } } });
 assert.equal(s.seq, 3);
 assert.equal(s.replaceGeneration, 1);
 assert.throws(() => s.append(replace(0, 0, [0])));
 s.append(replace(0, 2, [0, 2]));
 assert.deepEqual(s.deriveMessages().map((m) => m.id), ["summary"]);
});

test("连续替换按 surface 顺序而不是事件序号定位", () => {
 const s = new Session(header);
 s.append(user("a")); s.append(user("b")); s.append(user("c"));
 s.append(replace(0, 0, [0]));
 s.append(replace(3, 1, [3, 1]));
 assert.deepEqual(s.deriveMessages().map((m) => m.id), ["summary", "c"]);
 assert.equal(s.replaceGeneration, 2);
});

test("拒绝关联无效的工具事件，保留日志、派生消息和通知", () => {
  const session = new Session(header);
  const notifications: number[] = [];
  session.on("session/event", ({ seq }) => { notifications.push(seq); });
  const operation = {
    type: "tool/operation", data: {
      turn: 1, step: 1, callId: "call", operationId: "op",
      toolName: "read", toolVersion: "1", validatedArgs: {},
    },
  } as const;
  assert.throws(() => session.append(operation));
  assert.equal(session.seq, 0);
  assert.deepEqual(notifications, []);

  session.append({
    type: "assistant/message", surfaceOp: "append", data: {
      turn: 1, step: 1, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true,
      message: { id: "a", role: "assistant", source: { provider: "p", model: "m" }, content: [
        { type: "tool-call", id: "call", name: "read", arguments: "{}" },
      ] },
    },
  });
  const call = session.append({
    type: "tool/call", data: { turn: 1, step: 1, callId: "call", name: "read", arguments: "{}" },
  });
  assert.throws(() => session.append({ ...operation, data: { ...operation.data, toolName: "other" } }));
  session.append(operation);

  const result = {
    type: "tool/result", surfaceOp: "append", sourceEventSeqs: [call.seq], data: {
      turn: 1, step: 1,
      message: { id: "r", role: "user", source: { kind: "tool", callId: "call" }, content: [
        { type: "tool-result", toolCallId: "call", isError: false, content: [] },
      ] },
    },
  } as const;
  const before = session.snapshot();
  assert.throws(() => session.append(result));
  assert.throws(() => session.append({ ...result, data: { ...result.data, operationId: "wrong" } }));
  const valid = { ...result, data: { ...result.data, operationId: "op" } };
  assert.throws(() => session.append({ ...valid, sourceEventSeqs: [0] }));
  assert.throws(() => session.append({ ...valid, sourceEventSeqs: [call.seq, call.seq] }));
  assert.deepEqual(session.snapshot(), before);
  assert.deepEqual(session.deriveMessages().map(({ id }) => id), ["a"]);
  assert.deepEqual(notifications, [0, 1, 2]);
  assert.equal(session.append(valid).seq, 3);
  assert.deepEqual(notifications, [0, 1, 2, 3]);
});
