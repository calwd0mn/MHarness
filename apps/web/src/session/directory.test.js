import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as directory from "./directory.ts";

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key), values };
}
const current = "mharness.sessions.current";
const old = "mharness.session-directory.v1";
let previousLocks;
beforeEach(() => {
  previousLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, "locks");
  Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: { request(_name, action) { return Promise.resolve(action()); } } });
});
afterEach(() => {
  if (previousLocks) Object.defineProperty(globalThis.navigator, "locks", previousLocks);
  else delete globalThis.navigator.locks;
});

test("新键优先并保留合法的预留地址", () => {
  const address = { parentSessionId: "a", childSessionId: "b", mode: "one-shot" };
  const store = storage({ [current]: JSON.stringify({ sessionId: "a", subagentAddress: address }), [old]: JSON.stringify({ selected: "legacy" }) });
  assert.deepEqual(directory.loadSelection(store), { source: "current", selection: { sessionId: "a", subagentAddress: address } });
  store.setItem(current, JSON.stringify({ sessionId: "a", subagentAddress: { ...address, parentSessionId: "other" } }));
  assert.deepEqual(directory.loadSelection(store).selection, { sessionId: "a" });
  for (const raw of ["{}", "{", JSON.stringify({ sessionId: "" })]) {
    store.setItem(current, raw); assert.deepEqual(directory.loadSelection(store), { source: "current", selection: {} });
  }
});

test("仅在新键缺失时读取旧提示，不依赖旧列表", () => {
  const store = storage({ [old]: JSON.stringify({ selected: "a" }) });
  assert.deepEqual(directory.loadSelection(store), { source: "legacy", selection: { sessionId: "a" } });
  store.removeItem(old); assert.deepEqual(directory.loadSelection(store), { source: "none", selection: {} });
});

test("只在启动提示仍一致时迁移或清理，写入失败保留旧键", () => {
  const store = storage({ [old]: JSON.stringify({ selected: "a" }) }); const hint = directory.loadSelection(store);
  store.setItem(current, JSON.stringify({ sessionId: "b" }));
  directory.confirmInitialSelection(store, hint, true); assert.equal(store.getItem(current), '{"sessionId":"b"}');
  store.removeItem(current); directory.confirmInitialSelection(store, hint, true);
  assert.equal(store.getItem(current), '{"sessionId":"a"}'); assert.equal(store.getItem(old), null);
  const blocked = storage({ [old]: JSON.stringify({ selected: "a" }) }); blocked.setItem = () => { throw new Error(); };
  assert.doesNotThrow(() => directory.confirmInitialSelection(blocked, directory.loadSelection(blocked), true)); assert.notEqual(blocked.getItem(old), null);
});

test("写入选择只包含顶层 ID 或空对象并容忍存储异常", () => {
  const store = storage({ [old]: "old" }); directory.saveSelection(store, "a"); assert.equal(store.getItem(current), '{"sessionId":"a"}'); assert.equal(store.getItem(old), null);
  directory.saveSelection(store, null); assert.equal(store.getItem(current), "{}");
  const blocked = { getItem() { throw new Error(); }, setItem() { throw new Error(); }, removeItem() { throw new Error(); } };
  assert.doesNotThrow(() => directory.loadSelection(blocked)); assert.doesNotThrow(() => directory.saveSelection(blocked, "a"));
});

test("启动提示比较地址字段，已有新提示恢复不写入", () => {
  const original = { sessionId: "a", subagentAddress: { parentSessionId: "a", childSessionId: "one", mode: "continuable" } };
  const store = storage({ [current]: JSON.stringify(original) }); const hint = directory.loadSelection(store);
  let writes = 0; const set = store.setItem; store.setItem = (key, value) => { writes++; set(key, value); };
  directory.confirmInitialSelection(store, hint, true); assert.equal(writes, 0);
  const changed = { ...original, subagentAddress: { ...original.subagentAddress, childSessionId: "two" } };
  set(current, JSON.stringify(changed)); directory.confirmInitialSelection(store, hint, false);
  assert.deepEqual(JSON.parse(store.getItem(current)), changed); assert.equal(writes, 0);
});

test("旧提示失效时写空，新键写成功但清理失败仍可读取", () => {
  const store = storage({ [old]: JSON.stringify({ selected: "a" }) });
  store.removeItem = () => { throw new Error(); };
  directory.confirmInitialSelection(store, directory.loadSelection(store), false);
  assert.equal(store.getItem(current), "{}"); assert.notEqual(store.getItem(old), null);
  assert.deepEqual(directory.loadSelection(store), { source: "current", selection: {} });
});

test("语义相同但字段顺序不同的启动提示仍可确认失效", () => {
  const store = storage({ [current]: '{"sessionId":"a","subagentAddress":{"parentSessionId":"a","childSessionId":"c","mode":"one-shot"}}' });
  const hint = { source: "current", selection: { subagentAddress: { mode: "one-shot", childSessionId: "c", parentSessionId: "a" }, sessionId: "a" } };
  directory.confirmInitialSelection(store, hint, false); assert.equal(store.getItem(current), "{}");
});

test("选择写入与启动确认使用同一互斥锁，按排队顺序保护其他窗口", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, "locks"); const queue = [];
  Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: { request(name, callback) { return new Promise((resolve, reject) => queue.push({ name, run: () => { try { resolve(callback()); } catch (error) { reject(error); } } })); } } });
  try {
    const store = storage({ [old]: JSON.stringify({ selected: "x" }) }); const hint = directory.loadSelection(store);
    const first = directory.confirmInitialSelection(store, hint, true); const second = directory.saveSelection(store, "y");
    assert.equal(queue.length, 2); assert.equal(queue[0].name, current); queue.shift().run(); await first; queue.shift().run(); await second;
    assert.equal(store.getItem(current), '{"sessionId":"y"}');
    const store2 = storage({ [old]: JSON.stringify({ selected: "x" }) }); const hint2 = directory.loadSelection(store2);
    const write = directory.saveSelection(store2, "y"); const confirm = directory.confirmInitialSelection(store2, hint2, false);
    queue.shift().run(); await write; queue.shift().run(); await confirm; assert.equal(store2.getItem(current), '{"sessionId":"y"}');
  } finally { if (original) Object.defineProperty(globalThis.navigator, "locks", original); else delete globalThis.navigator.locks; }
});

test("另一窗口在确认读取期间排队时，其后续写入最终保留", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, "locks"); const queue = [];
  Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: { request(_name, callback) { return new Promise((resolve, reject) => queue.push(() => { try { resolve(callback()); } catch (error) { reject(error); } })); } } });
  try {
    const store = storage({ [old]: JSON.stringify({ selected: "x" }) }); const hint = directory.loadSelection(store);
    const get = store.getItem; let other; let entered = false;
    store.getItem = (key) => { if (!entered) { entered = true; other = directory.saveSelection(store, "y"); } return get(key); };
    const first = directory.confirmInitialSelection(store, hint, true); queue.shift()(); await first;
    assert.equal(queue.length, 1); queue.shift()(); await other; assert.equal(store.getItem(current), '{"sessionId":"y"}');
  } finally { if (original) Object.defineProperty(globalThis.navigator, "locks", original); else delete globalThis.navigator.locks; }
});

test("锁请求拒绝时不写存储且不向调用方传播错误", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, "locks");
  Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: { request() { return Promise.reject(new Error("blocked")); } } });
  try { const store = storage({ [old]: '{"selected":"x"}' }); await directory.saveSelection(store, "y"); await directory.confirmInitialSelection(store, directory.loadSelection(store), false); assert.equal(store.getItem(current), null); assert.notEqual(store.getItem(old), null); }
  finally { if (original) Object.defineProperty(globalThis.navigator, "locks", original); else delete globalThis.navigator.locks; }
});

test("存储不可用时无需等待其他窗口释放选择锁", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, "locks");
  let requests = 0;
  Object.defineProperty(globalThis.navigator, "locks", {
    configurable: true,
    value: { request() { requests++; return new Promise(() => {}); } },
  });
  try {
    directory.saveSelection(undefined, "a");
    directory.confirmInitialSelection(undefined, { source: "legacy", selection: { sessionId: "a" } }, true);
    assert.equal(requests, 0);
  } finally {
    if (original) Object.defineProperty(globalThis.navigator, "locks", original);
    else delete globalThis.navigator.locks;
  }
});

for (const valid of [true, false]) test(`无锁时启动${valid ? "迁移" : "清理"}不能覆盖并发写入`, () => {
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, "locks");
  Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: undefined });
  try {
    const store = storage({ [old]: '{"selected":"x"}' }); const hint = directory.loadSelection(store);
    const get = store.getItem; let inserted = false;
    store.getItem = (key) => { const value = get(key); if (key === old && !inserted) { inserted = true; store.setItem(current, '{"sessionId":"y"}'); } return value; };
    directory.confirmInitialSelection(store, hint, valid);
    assert.equal(store.getItem(current), inserted ? '{"sessionId":"y"}' : null);
    assert.notEqual(store.getItem(old), null);
  } finally { if (original) Object.defineProperty(globalThis.navigator, "locks", original); else delete globalThis.navigator.locks; }
});

test("无锁时明确选择同步保存并清理旧键", () => {
  Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: undefined });
  const store = storage({ [old]: '{"selected":"x"}' });
  assert.equal(directory.saveSelection(store, "y"), undefined);
  assert.equal(store.getItem(current), '{"sessionId":"y"}'); assert.equal(store.getItem(old), null);
});

test("锁请求同步抛错时不退化成无锁写入", async () => {
  Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: { request() { throw new Error("denied"); } } });
  const store = storage({ [old]: '{"selected":"x"}' }); const hint = directory.loadSelection(store);
  await directory.saveSelection(store, "y"); await directory.confirmInitialSelection(store, hint, true);
  assert.equal(store.getItem(current), null); assert.notEqual(store.getItem(old), null);
});
