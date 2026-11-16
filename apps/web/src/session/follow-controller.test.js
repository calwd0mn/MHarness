import { test } from "node:test";
import assert from "node:assert/strict";
import { FollowController } from "./follow-controller.ts";

test("快照安装期间增量排队，旧代次不能覆盖新会话", async () => {
  const connections = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const states = [];
  const controller = new FollowController({
    connect: (id, callbacks) => { connections.push({ id, callbacks }); return { close() {} }; },
    onState: (state) => states.push(state),
    buildSnapshot: async () => { await gate; },
    retryDelays: [0],
  });
  controller.select("a");
  connections[0].callbacks.frame({ type: "snapshot", sessionId: "a", inheritedEventCount: 0, cursor: -1, records: [], assistantStream: { revision: 0 } });
  connections[0].callbacks.frame({ type: "event", event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } } });
  controller.select("b");
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(states.at(-1).sessionId, "b");
  assert.equal(states.at(-1).records.length, 0);
  controller.dispose();
});

test("非法首帧按预算重连，服务端终止错误不自动重连", async () => {
  const connections = [];
  const states = [];
  const controller = new FollowController({ connect: (id, callbacks) => { connections.push({ id, callbacks }); return { close() {} }; }, onState: (state) => states.push(state), retryDelays: [0] });
  controller.select("a");
  connections[0].callbacks.frame({ type: "agent/error", turn: 1, message: "x" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(connections.length, 2);
  connections[1].callbacks.frame({ type: "error", error: { code: "follow_sync_failed", message: "失败", details: {} } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(states.at(-1).status, "failed");
  assert.equal(connections.length, 2);
  controller.dispose();
});

test("快照构建完成后顺序应用排队增量", async () => {
  let callbacks;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const states = [];
  const controller = new FollowController({ connect: (_id, cb) => { callbacks = cb; return { close() {} }; }, onState: (state) => states.push(state), buildSnapshot: () => gate });
  controller.select("a");
  callbacks.frame({ type: "snapshot", sessionId: "a", inheritedEventCount: 0, cursor: -1, records: [], assistantStream: { revision: 0 } });
  callbacks.frame({ type: "event", event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } } });
  await Promise.resolve();
  assert.equal(states.at(-1).cursor, -1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(states.at(-1).cursor, 0);
  controller.dispose();
});

for (const endFirst of [true, false]) test(`实时草稿和结算${endFirst ? "结束帧" : "事件"}先到均复用节点`, async () => {
  let callbacks;
  const states = [];
  const controller = new FollowController({ connect: (_id, cb) => { callbacks = cb; return { close() {} }; }, onState: (state) => states.push(state) });
  controller.select("a");
  callbacks.frame({ type: "snapshot", sessionId: "a", inheritedEventCount: 0, cursor: 1, records: [
    { type: "event", event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } } },
    { type: "event", event: { type: "step/start", seq: 1, time: 2, data: { turn: 1, step: 1 } } },
  ], assistantStream: { revision: 1, activeAttempt: { attemptId: "draft", turn: 1, step: 1, chunks: [], nextIndex: 0 } } });
  const end = { type: "assistant-stream", frame: { type: "end", attemptId: "draft", revision: 2, turn: 1, step: 1, index: 0, outcome: { kind: "committed", eventType: "assistant/attempt", seq: 2 } } };
  const event = { type: "event", event: { type: "assistant/attempt", seq: 2, time: 3, data: { turn: 1, step: 1, outcome: "failed", reason: "fail", stream: [], includeInModelContext: false } } };
  for (const frame of endFirst ? [end, event] : [event, end]) callbacks.frame(frame);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(states.at(-1).settledNodeIds[2], "draft");
  assert.equal(states.at(-1).draft, undefined);
  assert.equal(states.at(-1).records.length, 3);
  controller.dispose();
});

test("所属 Turn 结束时缺少实时结算会保留画面并停止重试", async () => {
  let callbacks;
  const states = [];
  const controller = new FollowController({ connect: (_id, cb) => { callbacks = cb; return { close() {} }; }, onState: (state) => states.push(state), retryDelays: [] });
  controller.select("a");
  callbacks.frame({ type: "snapshot", sessionId: "a", inheritedEventCount: 0, cursor: 1, records: [
    { type: "event", event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } } },
    { type: "event", event: { type: "step/start", seq: 1, time: 2, data: { turn: 1, step: 1 } } },
  ], assistantStream: { revision: 1, activeAttempt: { attemptId: "draft", turn: 1, step: 1, chunks: [], nextIndex: 0 } } });
  callbacks.frame({ type: "event", event: { type: "turn/end", seq: 2, time: 3, data: { turn: 1, reason: { kind: "completed" } } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(states.at(-1).status, "failed");
  assert.equal(states.at(-1).cursor, 1);
  assert.equal(states.at(-1).draft.attemptId, "draft");
  controller.dispose();
});

test("缺号触发恢复且旧连接关闭回调不影响新连接", async () => {
  const connections = []; const states = [];
  const controller = new FollowController({ connect: (_id, cb) => { connections.push(cb); return { close() { cb.close(); } }; }, onState: (state) => states.push(state), retryDelays: [0] });
  controller.select("a");
  connections[0].frame({ type: "snapshot", sessionId: "a", inheritedEventCount: 0, cursor: -1, records: [], assistantStream: { revision: 0 } });
  connections[0].frame({ type: "event", event: { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(connections.length, 2);
  connections[0].error();
  connections[1].frame({ type: "snapshot", sessionId: "a", inheritedEventCount: 0, cursor: -1, records: [], assistantStream: { revision: 0 } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(states.at(-1).status, "ready");
  controller.dispose();
});

test("快照构建失败不提交部分状态", async () => {
  let callbacks; const states = [];
  const controller = new FollowController({ connect: (_id, cb) => { callbacks = cb; return { close() {} }; }, onState: (s) => states.push(s), retryDelays: [], buildSnapshot: async () => { throw new Error("failed"); } });
  controller.select("a");
  callbacks.frame({ type: "snapshot", sessionId: "a", inheritedEventCount: 0, cursor: 0, records: [{ type: "event", event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } } }], assistantStream: { revision: 0 } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(states.at(-1).status, "failed"); assert.equal(states.at(-1).cursor, -1); assert.deepEqual(states.at(-1).records, []);
  controller.dispose();
});

test("终止错误排在异步快照之后时优先于连接关闭", async () => {
  const connections = []; const states = []; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const controller = new FollowController({ connect: (_id, cb) => { connections.push(cb); return { close() {} }; }, onState: (s) => states.push(s), retryDelays: [0], buildSnapshot: () => gate });
  controller.select("a");
  connections[0].frame({ type: "snapshot", sessionId: "a", inheritedEventCount: 0, cursor: -1, records: [], assistantStream: { revision: 0 } });
  connections[0].frame({ type: "error", error: { code: "follow_sync_failed", message: "终止", details: {} } });
  connections[0].close(); release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(connections.length, 1); assert.equal(states.at(-1).status, "failed"); assert.equal(states.at(-1).error, "终止");
  controller.dispose();
});

test("新 Turn 清除即时执行错误并保留历史", async () => {
  let callbacks; const states = [];
  const controller = new FollowController({ connect: (_id, cb) => { callbacks = cb; return { close() {} }; }, onState: (s) => states.push(s) });
  controller.select("a");
  callbacks.frame({ type: "snapshot", sessionId: "a", inheritedEventCount: 0, cursor: -1, records: [], assistantStream: { revision: 0 } });
  callbacks.frame({ type: "agent/error", turn: 1, message: "失败" });
  callbacks.frame({ type: "event", event: { type: "turn/start", seq: 0, time: 1, data: { turn: 2 } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(states.at(-1).agentError, undefined); assert.equal(states.at(-1).records.length, 1);
  controller.dispose();
});

const waitFollow = () => new Promise((resolve) => setTimeout(resolve, 10));
const activeSnapshot = () => ({ type: "snapshot", sessionId: "a", inheritedEventCount: 0, cursor: 1, records: [
  { type: "event", event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } } },
  { type: "event", event: { type: "step/start", seq: 1, time: 2, data: { turn: 1, step: 1 } } },
], assistantStream: { revision: 1, activeAttempt: { attemptId: "draft", turn: 1, step: 1, chunks: [], nextIndex: 0 } } });
const settlementEvent = (overrides = {}) => ({ type: "event", event: { type: "assistant/attempt", seq: 2, time: 3, data: { turn: 1, step: 1, outcome: "failed", reason: "fail", stream: [], includeInModelContext: false }, ...overrides } });
const settlementEnd = (overrides = {}) => ({ type: "assistant-stream", frame: { type: "end", attemptId: "draft", revision: 2, turn: 1, step: 1, index: 0, outcome: { kind: "committed", eventType: "assistant/attempt", seq: 2 }, ...overrides } });
function followHarness(options = {}) {
  const connections = []; const states = [];
  const controller = new FollowController({ connect: (_id, callbacks) => { connections.push(callbacks); return { close() { callbacks.close(); } }; }, onState: (state) => states.push(state), retryDelays: [], ...options });
  controller.select("a");
  return { controller, connections, states };
}

test("结算任一帧先到时保留草稿，end 后不接受分片", async () => {
  for (const first of [settlementEnd(), settlementEvent()]) {
    const { controller, connections, states } = followHarness();
    connections[0].frame(activeSnapshot()); connections[0].frame(first); await waitFollow();
    assert.equal(states.at(-1).status, "ready"); assert.equal(states.at(-1).draft.attemptId, "draft");
    if (first.type === "assistant-stream") {
      connections[0].frame({ type: "assistant-stream", frame: { type: "chunk", attemptId: "draft", revision: 3, index: 0, chunk: { type: "text", delta: "迟到" } } });
      await waitFollow(); assert.equal(states.at(-1).status, "failed"); assert.equal(states.at(-1).draft.chunks.length, 0);
    }
    controller.dispose();
  }
});

test("零引用可暂存，abandoned 清除草稿", async () => {
  for (const outcome of [{ kind: "committed", eventType: "assistant/attempt", seq: 0 }, { kind: "abandoned" }]) {
    const { controller, connections, states } = followHarness();
    connections[0].frame(activeSnapshot()); connections[0].frame(settlementEnd({ outcome })); await waitFollow();
    assert.equal(states.at(-1).status, "ready");
    assert.equal(states.at(-1).draft?.attemptId, outcome.kind === "abandoned" ? undefined : "draft"); controller.dispose();
  }
});

for (const [label, change] of [
  ["类型", { eventType: "assistant/message", seq: 2 }],
  ["序号", { eventType: "assistant/attempt", seq: 3 }],
]) test(`结算引用${label}不一致时恢复`, async () => {
  const { controller, connections, states } = followHarness();
  connections[0].frame(activeSnapshot()); connections[0].frame(settlementEnd({ outcome: { kind: "committed", ...change } })); connections[0].frame(settlementEvent()); await waitFollow();
  assert.equal(states.at(-1).status, "failed"); assert.equal(states.at(-1).cursor, 1); controller.dispose();
});

for (const [label, frame] of [
  ["Attempt", settlementEnd({ attemptId: "other" })], ["结束范围", settlementEnd({ step: 2 })],
  ["结束序号", settlementEnd({ index: 1 })], ["实时版本", settlementEnd({ revision: 3 })],
  ["分片序号", { type: "assistant-stream", frame: { type: "chunk", attemptId: "draft", revision: 2, index: 1, chunk: { type: "text", delta: "x" } } }],
]) test(`${label}不一致保留窗口并恢复`, async () => {
  const { controller, connections, states } = followHarness(); connections[0].frame(activeSnapshot()); connections[0].frame(frame); await waitFollow();
  assert.equal(states.at(-1).status, "failed"); assert.equal(states.at(-1).cursor, 1); assert.equal(states.at(-1).draft.attemptId, "draft"); controller.dispose();
});

test("结算事件范围不一致时不能作为普通事件接受", async () => {
  const { controller, connections, states } = followHarness(); connections[0].frame(activeSnapshot());
  connections[0].frame(settlementEnd()); connections[0].frame(settlementEvent({ data: { turn: 2, step: 1, outcome: "failed", reason: "fail", stream: [], includeInModelContext: false } })); await waitFollow();
  assert.equal(states.at(-1).status, "failed"); assert.equal(states.at(-1).cursor, 1); controller.dispose();
});

for (const missing of ["end", "event"]) for (const boundary of ["start", "turn/end"]) test(`缺少${missing}时遇到${boundary}触发恢复`, async () => {
  const { controller, connections, states } = followHarness(); connections[0].frame(activeSnapshot());
  connections[0].frame(missing === "end" ? settlementEvent() : settlementEnd());
  connections[0].frame(boundary === "start" ? { type: "assistant-stream", frame: { type: "start", attemptId: "next", revision: missing === "end" ? 2 : 3, turn: 1, step: 1 } } : { type: "event", event: { type: "turn/end", seq: missing === "end" ? 3 : 2, time: 4, data: { turn: 1, reason: { kind: "completed" } } } });
  await waitFollow(); assert.equal(states.at(-1).status, "failed"); controller.dispose();
});

test("重连快照从已接受结算重建并替换旧草稿", async () => {
  const { controller, connections, states } = followHarness({ retryDelays: [0] });
  connections[0].frame(activeSnapshot()); await waitFollow(); connections[0].close(); await waitFollow();
  const snapshot = activeSnapshot(); snapshot.records.push(settlementEvent()); snapshot.cursor = 2; snapshot.assistantStream = { revision: 2 };
  connections[1].frame(snapshot); await waitFollow();
  assert.equal(states.at(-1).status, "ready"); assert.equal(states.at(-1).cursor, 2); assert.equal(states.at(-1).draft, undefined); controller.dispose();
});

test("集中恢复策略限制次数和单次等待，新连接不重置预算", async () => {
  const { controller, connections, states } = followHarness({ retryDelays: undefined, retry: { delaysMs: [100, 100], maxDelayMs: 1, maxAttempts: 2 } });
  for (let index = 0; index < 3; index++) {
    connections[index].frame({ type: "agent/error", turn: 1, message: "首帧错误" }); await waitFollow();
  }
  assert.equal(connections.length, 3); assert.equal(states.at(-1).status, "failed"); controller.dispose();
});

test("服务端终止错误保留已安装窗口，关闭不重连，主动重试恢复", async () => {
  const { controller, connections, states } = followHarness({ retryDelays: [0] });
  connections[0].frame(activeSnapshot()); await waitFollow();
  connections[0].frame({ type: "error", error: { code: "follow_sync_failed", message: "终止", details: {} } }); connections[0].close(); await waitFollow();
  assert.equal(connections.length, 1); assert.equal(states.at(-1).status, "failed"); assert.equal(states.at(-1).cursor, 1); assert.equal(states.at(-1).draft.attemptId, "draft");
  controller.retry(); assert.equal(connections.length, 2); connections[1].frame(activeSnapshot()); await waitFollow(); assert.equal(states.at(-1).status, "ready"); controller.dispose();
});

test("旧重连计时器和旧连接回调不影响切换后的会话", async () => {
  const { controller, connections, states } = followHarness({ retryDelays: [30] });
  connections[0].frame(activeSnapshot()); await waitFollow(); connections[0].error(); await waitFollow();
  controller.select("b"); connections[0].close(); connections[0].error(); connections[0].frame(activeSnapshot()); await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(connections.length, 2); assert.equal(states.at(-1).sessionId, "b"); assert.equal(states.at(-1).status, "syncing"); controller.dispose();
});

test("首帧终止错误等待主动重试", async () => {
  const { controller, connections, states } = followHarness({ retryDelays: [0] });
  connections[0].frame({ type: "error", error: { code: "follow_sync_failed", message: "打开失败", details: {} } }); connections[0].close(); await waitFollow();
  assert.equal(states.at(-1).status, "failed"); assert.equal(states.at(-1).error, "打开失败"); assert.equal(connections.length, 1);
  controller.retry(); connections[1].frame(activeSnapshot()); await waitFollow(); assert.equal(states.at(-1).status, "ready"); controller.dispose();
});

test("重连快照构建失败保留旧窗口和排队增量", async () => {
  let count = 0; const { controller, connections, states } = followHarness({ retryDelays: [0], buildSnapshot: async () => { if (++count === 2) throw new Error("失败"); } });
  connections[0].frame(activeSnapshot()); await waitFollow(); connections[0].close(); await waitFollow();
  const replacement = activeSnapshot(); replacement.records.push(settlementEvent()); replacement.cursor = 2; replacement.assistantStream = { revision: 2 };
  connections[1].frame(replacement); connections[1].frame({ type: "event", event: { type: "turn/end", seq: 3, time: 4, data: { turn: 1, reason: { kind: "completed" } } } }); await waitFollow();
  assert.equal(states.at(-1).status, "failed"); assert.equal(states.at(-1).cursor, 1); assert.equal(states.at(-1).draft.attemptId, "draft"); controller.dispose();
});

test("旧会话延迟构建失败不能触发新会话恢复", async () => {
  let reject; const gate = new Promise((_resolve, fail) => { reject = fail; });
  const { controller, connections, states } = followHarness({ retryDelays: [0], buildSnapshot: () => gate });
  connections[0].frame(activeSnapshot()); await Promise.resolve(); controller.select("b"); reject(new Error("旧构建失败")); await waitFollow();
  assert.equal(connections.length, 2); assert.equal(states.at(-1).sessionId, "b"); assert.equal(states.at(-1).status, "syncing"); controller.dispose();
});

test("无效恢复配置在构造时拒绝", () => {
  const base = { connect: () => ({ close() {} }), onState() {} };
  for (const retry of [
    { delaysMs: [1], maxDelayMs: 1, maxAttempts: Infinity },
    { delaysMs: [1], maxDelayMs: 1, maxAttempts: -1 },
    { delaysMs: [1], maxDelayMs: 1, maxAttempts: 1.5 },
    { delaysMs: [], maxDelayMs: 1, maxAttempts: 1 },
    { delaysMs: [NaN], maxDelayMs: 1, maxAttempts: 1 },
    { delaysMs: [-1], maxDelayMs: 1, maxAttempts: 1 },
    { delaysMs: [2147483648], maxDelayMs: 1, maxAttempts: 1 },
    { delaysMs: [1], maxDelayMs: Infinity, maxAttempts: 1 },
    { delaysMs: [1], maxDelayMs: 1.5, maxAttempts: 1 },
  ]) assert.throws(() => new FollowController({ ...base, retry }), RangeError);
  for (const retryDelays of [[Infinity], [NaN], [-1], [2147483648]])
    assert.throws(() => new FollowController({ ...base, retryDelays }), RangeError);
});

test("恢复配置在构造时复制，不受调用方后续修改影响", async () => {
  const retry = { delaysMs: [0], maxDelayMs: 0, maxAttempts: 1 };
  const { controller, connections, states } = followHarness({ retryDelays: undefined, retry });
  retry.maxAttempts = Infinity; retry.delaysMs[0] = Infinity;
  connections[0].error(); await waitFollow(); connections[1].error(); await waitFollow();
  assert.equal(connections.length, 2); assert.equal(states.at(-1).status, "failed"); controller.dispose();
  const retryDelays = [0]; const legacy = followHarness({ retryDelays }); retryDelays.push(0);
  legacy.connections[0].error(); await waitFollow(); legacy.connections[1].error(); await waitFollow();
  assert.equal(legacy.connections.length, 2); assert.equal(legacy.states.at(-1).status, "failed"); legacy.controller.dispose();
});

test("零重试次数和空的旧延迟列表立即停止", async () => {
  for (const options of [{ retryDelays: [] }, { retryDelays: undefined, retry: { delaysMs: [0], maxDelayMs: 0, maxAttempts: 0 } }]) {
    const { controller, connections, states } = followHarness(options); connections[0].error(); await waitFollow();
    assert.equal(connections.length, 1); assert.equal(states.at(-1).status, "failed"); controller.dispose();
  }
});
