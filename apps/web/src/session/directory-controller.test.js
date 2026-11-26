import test from "node:test";
import assert from "node:assert/strict";
import { DirectoryController } from "./directory-controller.ts";

const summary = (sessionId, overrides = {}) => ({ sessionId, createdAt: 1, updatedAt: 1, running: false, blank: true, ...overrides });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("ready 后读取快照，只发布连续重放后的完整目录", async () => {
  const connections = []; const states = []; let resolveSnapshot; let reads = 0;
  const controller = new DirectoryController({
    connect(callbacks) { connections.push(callbacks); return { close() {} }; },
    read() { reads++; return new Promise((resolve) => { resolveSnapshot = resolve; }); },
    onState(state) { states.push(state); },
  });
  controller.start();
  assert.equal(reads, 0);
  connections[0].frame({ type: "api-session/ready" });
  connections[0].frame({ type: "api-session/status", revision: 12, sessionId: "a", running: true });
  connections[0].frame({ type: "api-session/added", revision: 13, summary: summary("b") });
  connections[0].frame({ type: "api-session/added", revision: 14, summary: summary("b", { blank: false }) });
  connections[0].frame({ type: "api-session/removed", revision: 15, sessionId: "b", reason: "creation-failed" });
  assert.equal(states.length, 0);
  resolveSnapshot({ revision: 12, sessions: [summary("a")] }); await tick();
  assert.equal(states.length, 1); assert.equal(states[0].revision, 15);
  assert.deepEqual(states[0].sessions, [summary("a")]);
  connections[0].frame({ type: "api-session/status", revision: 12, sessionId: "a", running: true });
  assert.equal(states.at(-1).sessions[0].running, false);
  controller.dispose();
});

test("缺号换代、旧请求和旧回调无效，版本可从零重新开始", async () => {
  const connections = []; const reads = []; const states = []; const scheduled = [];
  const controller = new DirectoryController({
    connect(callbacks) { const c = { callbacks, closed: false }; connections.push(c); return { close() { c.closed = true; } }; },
    read(signal) { return new Promise((resolve, reject) => reads.push({ resolve, reject, signal })); },
    onState(state) { states.push(state); }, schedule(fn) { scheduled.push(fn); return () => {}; },
  });
  controller.start(); connections[0].callbacks.frame({ type: "api-session/ready" });
  reads[0].resolve({ revision: 20, sessions: [summary("a")] }); await tick();
  connections[0].callbacks.error(); assert.equal(connections[0].closed, true); scheduled.shift()();
  connections[1].callbacks.frame({ type: "api-session/ready" });
  connections[1].callbacks.frame({ type: "api-session/added", revision: 1, summary: summary("b") });
  reads[1].resolve({ revision: 0, sessions: [] }); await tick();
  assert.equal(states.at(-1).revision, 1); assert.deepEqual(states.at(-1).sessions, [summary("b")]);
  connections[1].callbacks.frame({ type: "api-session/status", revision: 3, sessionId: "b", running: true });
  assert.equal(connections[1].closed, true); scheduled.shift()();
  connections[2].callbacks.frame({ type: "api-session/ready" });
  controller.retry(); assert.equal(reads[2].signal.aborted, true);
  reads[2].resolve({ revision: 99, sessions: [] }); connections[2].callbacks.error(); await tick();
  assert.equal(states.at(-1).revision, 1); assert.equal(connections.length, 4);
  controller.dispose(); assert.equal(connections[3].closed, true);
});

test("读取失败释放该代连接与请求，保留旧目录并等待手动重试", async () => {
  const connections = [];
  const reads = [];
  const states = [];
  const failures = [];
  const controller = new DirectoryController({
    connect(callbacks) {
      const connection = { ...callbacks, closed: false };
      connections.push(connection);
      return { close() { connection.closed = true; } };
    },
    read(signal) { return new Promise((resolve, reject) => reads.push({ signal, resolve, reject })); },
    onState: (state) => states.push(state),
    onFailure: () => failures.push(true),
    schedule() { assert.fail("读取失败的旧回调不应安排重连"); },
  });
  controller.start();
  connections[0].frame({ type: "api-session/ready" });
  reads[0].resolve({ revision: 1, sessions: [summary("a")] });
  await tick();
  controller.retry();
  connections[1].frame({ type: "api-session/ready" });
  reads[1].reject(new Error("failed"));
  await tick();
  assert.equal(connections[1].closed, true);
  assert.equal(reads[1].signal.aborted, true);
  assert.equal(failures.length, 1);
  assert.equal(states.at(-1).revision, 1);
  connections[1].frame({ type: "api-session/added", revision: 2, summary: summary("b") });
  connections[1].error();
  assert.equal(connections.length, 2);
  assert.equal(states.length, 1);
  controller.retry();
  assert.equal(connections.length, 3);
  connections[2].frame({ type: "api-session/ready" });
  reads[2].resolve({ revision: 0, sessions: [summary("c")] });
  await tick();
  assert.deepEqual(states.at(-1).sessions, [summary("c")]);
  controller.dispose();
});

test("未安装时的错误只更新已发布的会话，未知会话不会在快照中获得旧错误", async () => {
  const connections = []; const reads = []; const states = [];
  const controller = new DirectoryController({ connect(cb) { connections.push(cb); return { close() {} }; }, read() { return new Promise((resolve) => reads.push(resolve)); }, onState: (state) => states.push(state) });
  controller.start(); connections[0].frame({ type: "api-session/ready" }); reads[0]({ revision: 0, sessions: [summary("a")] }); await tick();
  controller.retry(); connections[1].frame({ type: "api-session/ready" });
  connections[1].frame({ type: "api-session/error", sessionId: "b", message: "未知" });
  connections[1].frame({ type: "api-session/error", sessionId: "a", message: "失败" });
  assert.equal(states.at(-1).sessions[0].lastAgentError, "失败");
  reads[1]({ revision: 0, sessions: [summary("a"), summary("b")] }); await tick();
  assert.equal(states.at(-1).sessions.find((s) => s.sessionId === "a").lastAgentError, "失败");
  assert.equal(states.at(-1).sessions.find((s) => s.sessionId === "b").lastAgentError, undefined);
  controller.dispose();
});

test("相同活动时间按 ID 码点排序", async () => {
  let cb; const states = [];
  const controller = new DirectoryController({ connect(callbacks) { cb = callbacks; return { close() {} }; }, read: async () => ({ revision: 0, sessions: [summary("a"), summary("A"), summary("_")] }), onState: (s) => states.push(s) });
  controller.start(); cb.frame({ type: "api-session/ready" }); await tick();
  assert.deepEqual(states.at(-1).sessions.map((s) => s.sessionId), ["A", "_", "a"]); controller.dispose();
});

test("实时错误不会重复发布先前快照的对账令牌", async () => {
  let cb; const states = [];
  const controller = new DirectoryController({ connect(callbacks) { cb = callbacks; return { close() {} }; }, read: async () => ({ revision: 0, sessions: [summary("a")] }), onSnapshotStart: () => 3, onState: (s) => states.push(s) });
  controller.start(); cb.frame({ type: "api-session/ready" }); await tick();
  assert.equal(states.at(-1).snapshotToken, 3);
  cb.frame({ type: "api-session/error", sessionId: "a", message: "失败" });
  assert.equal(states.at(-1).snapshotToken, undefined); controller.dispose();
});

test("增量更新首 Turn、运行状态和单调活动时间，错误不推进版本", async () => {
  let cb; const states = [];
  const controller = new DirectoryController({ connect(callbacks) { cb = callbacks; return { close() {} }; }, read: async () => ({ revision: 0, sessions: [summary("a"), summary("b", { updatedAt: 2 })] }), onState: (s) => states.push(s) });
  controller.start(); cb.frame({ type: "api-session/ready" }); await tick();
  cb.frame({ type: "api-session/updated", revision: 1, sessionId: "a", blank: false, seq: 0 });
  cb.frame({ type: "api-session/activity", revision: 2, sessionId: "a", updatedAt: 5 });
  cb.frame({ type: "api-session/activity", revision: 3, sessionId: "a", updatedAt: 3 });
  cb.frame({ type: "api-session/error", sessionId: "a", message: "故障" });
  cb.frame({ type: "api-session/status", revision: 4, sessionId: "a", running: true });
  assert.equal(states.at(-1).revision, 4); assert.deepEqual(states.at(-1).sessions.map((s) => s.sessionId), ["a", "b"]);
  assert.deepEqual(states.at(-1).sessions[0], summary("a", { blank: false, updatedAt: 5, running: true, lastAgentError: "故障" })); controller.dispose();
});

test("重放缺号不发布候选目录并安排重连", async () => {
  const connections = []; const states = []; const jobs = []; let resolve;
  const controller = new DirectoryController({ connect(cb) { connections.push(cb); return { close() {} }; }, read: () => new Promise((done) => { resolve = done; }), onState: (s) => states.push(s), schedule(fn) { jobs.push(fn); return () => {}; } });
  controller.start(); connections[0].frame({ type: "api-session/ready" }); connections[0].frame({ type: "api-session/added", revision: 2, summary: summary("a") });
  resolve({ revision: 0, sessions: [] }); await tick(); assert.equal(states.length, 0); assert.equal(jobs.length, 1); jobs[0](); assert.equal(connections.length, 2); controller.dispose();
});

test("等待自动重连期间重复启动仍只保留一条目录连接", () => {
  const connections = [];
  const scheduled = [];
  const controller = new DirectoryController({
    connect(callbacks) {
      const connection = { callbacks, closes: 0 };
      connections.push(connection);
      return { close() { connection.closes++; } };
    },
    read: async () => ({ revision: 0, sessions: [] }),
    onState() {},
    schedule(callback) {
      scheduled.push(callback);
      return () => {};
    },
  });
  try {
    controller.start();
    connections[0].callbacks.error();
    controller.start();
    assert.equal(connections.length, 1);
    scheduled[0]();
    assert.equal(connections.length, 2);
  } finally {
    controller.dispose();
  }
  assert.deepEqual(connections.map(({ closes }) => closes), [1, 1]);
});

test("销毁释放正在读取的代次并取消已排队的重连", async () => {
  const connections = [];
  let read;
  let scheduled;
  let cancelled = false;
  const controller = new DirectoryController({
    connect(callbacks) {
      const connection = { ...callbacks, closed: false };
      connections.push(connection);
      return { close() { connection.closed = true; } };
    },
    read(signal) { return new Promise((resolve) => { read = { signal, resolve }; }); },
    onState() { assert.fail("失效请求不应发布目录"); },
    schedule(callback) {
      scheduled = callback;
      return () => { cancelled = true; };
    },
  });
  controller.start();
  connections[0].error();
  controller.dispose();
  assert.equal(cancelled, true);
  scheduled();
  assert.equal(connections.length, 1);

  const reading = new DirectoryController({
    connect(callbacks) {
      connections.push(callbacks);
      return { close() {} };
    },
    read(signal) { return new Promise((resolve) => { read = { signal, resolve }; }); },
    onState() { assert.fail("销毁后不应安装迟到快照"); },
  });
  reading.start();
  connections[1].frame({ type: "api-session/ready" });
  reading.dispose();
  assert.equal(read.signal.aborted, true);
  read.resolve({ revision: 99, sessions: [] });
  await tick();
});

test("已覆盖的撤回仅提示对账缺失项，保持已安装快照和版本", async () => {
  let callbacks;
  const states = [];
  const missing = [];
  const controller = new DirectoryController({
    connect(connection) { callbacks = connection; return { close() {} }; },
    read: async () => ({ revision: 4, sessions: [summary("kept")] }),
    onState: (state) => states.push(state),
    onCoveredRemoval: (id) => missing.push(id),
  });
  controller.start();
  callbacks.frame({ type: "api-session/ready" });
  await tick();
  callbacks.frame({ type: "api-session/removed", revision: 2, sessionId: "kept", reason: "creation-failed" });
  callbacks.frame({ type: "api-session/removed", revision: 4, sessionId: "missing", reason: "creation-failed" });
  assert.equal(states.length, 1);
  assert.equal(states[0].revision, 4);
  assert.deepEqual(states[0].sessions, [summary("kept")]);
  assert.deepEqual(missing, ["missing"]);
  callbacks.frame({ type: "api-session/status", revision: 5, sessionId: "kept", running: true });
  assert.equal(states.at(-1).revision, 5);
  assert.equal(states.at(-1).sessions[0].running, true);
  controller.dispose();
});
