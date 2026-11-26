// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { App } from "./App.tsx";

const key = "mharness.sessions.current";
const legacy = "mharness.session-directory.v1";
const row = (sessionId, blank = false) => ({ sessionId, createdAt: 1, updatedAt: 1, running: false, blank });

test("新键提示经目录确认后恢复，选择在 follow 建立前保存并可关闭", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); localStorage.setItem(key, JSON.stringify({ sessionId: "a" }));
  const sources = []; const observed = []; let resolveGet;
  class Source { constructor(url) { this.url = url; sources.push(this); if (url.endsWith("/follow")) observed.push(localStorage.getItem(key)); } close() { this.closed = true; } frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); } }
  vi.stubGlobal("EventSource", Source); vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { resolveGet = resolve; })));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<App />)); await act(async () => sources[0].frame({ type: "api-session/ready" })); expect(sources).toHaveLength(1);
    await act(async () => resolveGet({ ok: true, json: async () => ({ revision: 0, sessions: [row("a"), row("b")] }) }));
    expect(sources[1].url).toBe("/api/sessions/a/follow"); expect(observed[0]).toBe('{"sessionId":"a"}');
    await act(async () => [...container.querySelectorAll("nav button")].find((button) => button.textContent.includes("b")).click());
    expect(observed.at(-1)).toBe('{"sessionId":"b"}');
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent.includes("关闭会话")).click());
    expect(localStorage.getItem(key)).toBe("{}"); expect(sources.at(-1).closed).toBe(true); expect(sources[0].closed).not.toBe(true);
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

function harness(initial = {}) {
  localStorage.clear(); for (const [key, value] of Object.entries(initial)) localStorage.setItem(key, JSON.stringify(value));
  const sources = []; const reads = []; let postResolve;
  class Source { constructor(url) { this.url = url; try { this.selectionAtOpen = localStorage.getItem(key); } catch { this.selectionAtOpen = null; } sources.push(this); } close() { this.closed = true; } frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); } }
  vi.stubGlobal("EventSource", Source);
  vi.stubGlobal("fetch", vi.fn((url, options) => options?.method === "POST" ? new Promise((resolve) => { postResolve = resolve; }) : new Promise((resolve) => reads.push(resolve))));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  return { sources, reads, container, root, post: (value) => postResolve(value),
    async mount() { await act(async () => root.render(<App />)); },
    async ready(index = 0) { await act(async () => sources[index].frame({ type: "api-session/ready" })); },
    async snapshot(index, sessions) { await act(async () => reads[index]({ ok: true, json: async () => ({ revision: 0, sessions }) })); },
    async click(text) { await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent.includes(text)).click()); },
    async dispose() { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); },
  };
}

test("读取失败后旧提示仍在，重试成功才迁移并打开 follow", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; const h = harness({ [legacy]: { selected: "a" } });
  const previous = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request(_name, action) { return Promise.resolve(action()); } } });
  try {
    await h.mount(); await h.ready(); await act(async () => h.reads[0]({ ok: false }));
    expect(localStorage.getItem(key)).toBeNull(); expect(localStorage.getItem(legacy)).not.toBeNull(); expect(h.sources).toHaveLength(1);
    await h.click("重试目录"); await h.ready(1); await h.snapshot(1, [row("a")]);
    expect(h.sources[2].selectionAtOpen).toBe('{"sessionId":"a"}'); expect(localStorage.getItem(legacy)).toBeNull();
  } finally { if (previous) Object.defineProperty(navigator, "locks", previous); else delete navigator.locks; await h.dispose(); }
});

test("启动旧提示失效时不覆盖另一窗口的新选择", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; const h = harness({ [legacy]: { selected: "a" } });
  try { await h.mount(); await h.ready(); localStorage.setItem(key, '{"sessionId":"b"}'); await h.snapshot(0, [row("b")]);
    expect(localStorage.getItem(key)).toBe('{"sessionId":"b"}'); expect(h.sources).toHaveLength(1); expect(h.container.querySelector('[aria-current="page"]')).toBeNull();
  } finally { await h.dispose(); }
});

test("创建先于启动快照时写入新选择，旧提示不得迁移覆盖", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; const h = harness({ [legacy]: { selected: "a" } });
  try { await h.mount(); await h.ready(); await h.click("新建会话"); await act(async () => h.post({ ok: true, json: async () => ({ sessionId: "b" }) }));
    expect(h.sources[1].selectionAtOpen).toBe('{"sessionId":"b"}'); await h.snapshot(0, [row("a")]);
    expect(h.container.querySelector('[aria-current="page"]').textContent).toContain("b"); expect(localStorage.getItem(key)).toBe('{"sessionId":"b"}');
  } finally { await h.dispose(); }
});

test("重复选择当前行仍阻止迟到创建抢回选择且不回写", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; const h = harness({ [key]: { sessionId: "a" } });
  try { await h.mount(); await h.ready(); await h.snapshot(0, [row("a")]); await h.click("新建会话");
    localStorage.setItem(key, '{"sessionId":"other"}'); await h.click("会话 1"); await act(async () => h.post({ ok: true, json: async () => ({ sessionId: "b" }) }));
    expect(h.container.querySelector('[aria-current="page"]').textContent).toContain("a"); expect(localStorage.getItem(key)).toBe('{"sessionId":"other"}');
  } finally { await h.dispose(); }
});

test("已确认选择被撤回时写空并关闭 follow，follow 错误可重试", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; const h = harness({ [key]: { sessionId: "a" } });
  try { await h.mount(); await h.ready(); await h.snapshot(0, [row("a")]);
    await act(async () => h.sources[1].frame({ type: "error", error: { code: "follow_sync_failed", message: "失败", details: {} } }));
    expect(localStorage.getItem(key)).toBe('{"sessionId":"a"}'); await h.click("重新同步"); expect(h.sources[2].url).toBe("/api/sessions/a/follow");
    localStorage.setItem(key, '{"sessionId":"b"}');
    await act(async () => h.sources[0].frame({ type: "api-session/removed", revision: 1, sessionId: "a", reason: "creation-failed" }));
    expect(localStorage.getItem(key)).toBe("{}"); expect(h.sources[2].closed).toBe(true);
  } finally { await h.dispose(); }
});

test("没有提示时显示非空目录但不打开 follow；清空后刷新不复活旧键", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; const h = harness({ [key]: {}, [legacy]: { selected: "a" } });
  try { await h.mount(); await h.ready(); await h.snapshot(0, [row("a"), row("empty", true)]);
    expect(h.sources).toHaveLength(1); expect(h.container.textContent).toContain("a"); expect(h.container.textContent).not.toContain("empty");
    await h.click("会话 1"); await h.click("关闭会话"); expect(localStorage.getItem(key)).toBe("{}");
    await act(async () => h.root.unmount()); const root = createRoot(h.container); await act(async () => root.render(<App />)); await act(async () => h.sources.at(-1).frame({ type: "api-session/ready" })); await h.snapshot(1, [row("a")]);
    expect(h.sources.at(-1).url).toBe("/api/session-directory/events"); await act(async () => root.unmount());
  } finally { h.container.remove(); vi.unstubAllGlobals(); }
});

test("开始创建后主动关闭，迟到 201 不改变空选择", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; const h = harness({ [key]: { sessionId: "a" } });
  try { await h.mount(); await h.ready(); await h.snapshot(0, [row("a")]); await h.click("新建会话"); await h.click("关闭会话");
    await act(async () => h.post({ ok: true, json: async () => ({ sessionId: "b" }) }));
    expect(h.container.querySelector('[aria-current="page"]')).toBeNull(); expect(localStorage.getItem(key)).toBe("{}");
  } finally { await h.dispose(); }
});

test("存储拒绝访问时仍能选择和关闭会话", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; const h = harness();
  const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  try { await h.mount(); await h.ready(); await h.snapshot(0, [row("a")]); await h.click("会话 1");
    expect(h.container.querySelector('[aria-current="page"]').textContent).toContain("a"); await h.click("关闭会话"); expect(h.container.querySelector('[aria-current="page"]')).toBeNull();
  } finally { get.mockRestore(); set.mockRestore(); await h.dispose(); }
});


test("两个窗口保持各自选择，普通更新不回写，刷新恢复最新共享提示", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); const sources = [];
  class Source { constructor(url) { this.url = url; sources.push(this); } close() { this.closed = true; } frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); } }
  vi.stubGlobal("EventSource", Source); vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ revision: 0, sessions: [row("a"), row("b")] }) })));
  const containers = [document.createElement("div"), document.createElement("div")]; containers.forEach((node) => document.body.append(node));
  const roots = containers.map((node) => createRoot(node));
  try {
    await act(async () => roots.forEach((root) => root.render(<App />)));
    await act(async () => { sources[0].frame({ type: "api-session/ready" }); sources[1].frame({ type: "api-session/ready" }); });
    expect(sources.map(({ url }) => url)).toEqual([
      "/api/session-directory/events",
      "/api/session-directory/events",
    ]);
    expect(localStorage.getItem(key)).toBeNull();
    await act(async () => containers[0].querySelectorAll("nav button")[0].click());
    await act(async () => containers[1].querySelectorAll("nav button")[1].click());
    expect(localStorage.getItem(key)).toBe('{"sessionId":"b"}');
    const firstFollow = sources.find((source) => source.url === "/api/sessions/a/follow");
    const write = vi.spyOn(Storage.prototype, "setItem");
    try {
      await act(async () => {
        sources[0].frame({ type: "api-session/status", revision: 1, sessionId: "a", running: true });
        firstFollow.frame({ type: "snapshot", sessionId: "a", inheritedEventCount: 0, cursor: -1, records: [], assistantStream: { revision: 0 } });
        firstFollow.frame({
          type: "event",
          event: {
            type: "user/message", seq: 0, time: 2, surfaceOp: "append",
            data: {
              id: "message", role: "user", source: { kind: "user" }, turn: 1, requestId: "request",
              content: [{ type: "text", text: "会话 A 收到的消息" }],
            },
          },
        });
      });
      expect(containers[0].textContent).toContain("会话 A 收到的消息");
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
    expect(containers[0].querySelector('[aria-current="page"]').textContent).toContain("a"); expect(containers[1].querySelector('[aria-current="page"]').textContent).toContain("b"); expect(localStorage.getItem(key)).toBe('{"sessionId":"b"}');
    await act(async () => roots[0].unmount()); const replacement = createRoot(containers[0]); await act(async () => replacement.render(<App />));
    const latestDirectory = sources.findLast((source) => source.url === "/api/session-directory/events"); await act(async () => latestDirectory.frame({ type: "api-session/ready" }));
    expect(containers[0].querySelector('[aria-current="page"]').textContent).toContain("b"); await act(async () => replacement.unmount());
  } finally { await act(async () => roots[1].unmount()); containers.forEach((node) => node.remove()); vi.unstubAllGlobals(); }
});

test("异步锁写入完成后才打开 follow，等待期间关闭不会迟到打开", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; const h = harness(); const queue = [];
  const previous = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request(name, callback) { return new Promise((resolve, reject) => queue.push({ name, run: () => { try { resolve(callback()); } catch (error) { reject(error); } } })); } } });
  try {
    await h.mount(); await h.ready(); await h.snapshot(0, [row("a"), row("b")]); await h.click("会话 1");
    expect(queue).toHaveLength(1); expect(h.sources).toHaveLength(1);
    await act(async () => queue.shift().run()); expect(h.sources[1].url).toBe("/api/sessions/a/follow"); expect(h.sources[1].selectionAtOpen).toBe('{"sessionId":"a"}');
    await h.click("会话 2"); expect(h.sources).toHaveLength(2); expect(h.sources[1].closed).toBe(true); expect(h.container.querySelector("header").textContent).toContain("正在同步"); await h.click("关闭会话");
    expect(h.container.querySelector("header").textContent).toContain("正在清除恢复提示");
    await h.click("新建会话");
    await act(async () => h.post({ ok: false, status: 500 }));
    expect(h.container.textContent).toContain("创建会话失败");
    await act(async () => queue.shift().run());
    expect(h.container.querySelector("header").textContent).toContain("正在清除恢复提示");
    await act(async () => queue.shift().run());
    expect(h.container.querySelector("header").textContent).not.toContain("正在清除恢复提示");
    expect(h.container.textContent).toContain("创建会话失败");
    expect(h.sources.some((source) => source.url === "/api/sessions/b/follow")).toBe(false); expect(localStorage.getItem(key)).toBe("{}");
  } finally { if (previous) Object.defineProperty(navigator, "locks", previous); else delete navigator.locks; await h.dispose(); }
});

test("等待写入时选中项撤回，旧 follow 不会迟到打开", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; const h = harness(); const queue = [];
  const previous = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request(_name, callback) { return new Promise((resolve) => queue.push(() => resolve(callback()))); } } });
  try {
    await h.mount(); await h.ready(); await h.snapshot(0, [row("a")]); await h.click("会话 1");
    await act(async () => h.sources[0].frame({ type: "api-session/removed", revision: 1, sessionId: "a", reason: "creation-failed" }));
    await act(async () => queue.shift()()); await act(async () => queue.shift()());
    expect(h.sources).toHaveLength(1); expect(localStorage.getItem(key)).toBe("{}");
  } finally { if (previous) Object.defineProperty(navigator, "locks", previous); else delete navigator.locks; await h.dispose(); }
});

test("锁请求失败仍打开内存中选中的会话", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; const h = harness(); const previous = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request() { return Promise.reject(new Error("blocked")); } } });
  try { await h.mount(); await h.ready(); await h.snapshot(0, [row("a")]); await h.click("会话 1"); expect(h.sources[1].url).toBe("/api/sessions/a/follow"); expect(localStorage.getItem(key)).toBeNull(); }
  finally { if (previous) Object.defineProperty(navigator, "locks", previous); else delete navigator.locks; await h.dispose(); }
});

test("同批改选后切回原会话，follow 等待最近一次选择写入", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const h = harness();
  const grants = [];
  const previous = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request(_name, callback) {
      return new Promise((resolve) => grants.push(() => resolve(callback())));
    } },
  });
  try {
    await h.mount(); await h.ready(); await h.snapshot(0, [row("a"), row("b")]);
    await h.click("会话 1");
    const [a, b] = h.container.querySelectorAll("nav button");
    await act(async () => { b.click(); a.click(); });
    expect(grants).toHaveLength(3);
    await act(async () => grants.shift()());
    expect(h.sources).toHaveLength(1);
    await act(async () => grants.shift()());
    expect(localStorage.getItem(key)).toBe('{"sessionId":"b"}');
    expect(h.sources).toHaveLength(1);
    await act(async () => grants.shift()());
    expect(h.sources[1].url).toBe("/api/sessions/a/follow");
    expect(h.sources[1].selectionAtOpen).toBe('{"sessionId":"a"}');
  } finally {
    if (previous) Object.defineProperty(navigator, "locks", previous);
    else delete navigator.locks;
    await h.dispose();
  }
});

test("无锁时有效旧提示仍在本页恢复，启动不会迁移或清理共享键", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; const h = harness({ [legacy]: { selected: "a" } });
  const previous = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  try {
    await h.mount(); await h.ready(); await h.snapshot(0, [row("a")]);
    expect(h.sources[1].url).toBe("/api/sessions/a/follow");
    expect(localStorage.getItem(key)).toBeNull(); expect(localStorage.getItem(legacy)).not.toBeNull();
    await h.click("关闭会话"); expect(localStorage.getItem(key)).toBe("{}"); expect(localStorage.getItem(legacy)).toBeNull();
  } finally { if (previous) Object.defineProperty(navigator, "locks", previous); else delete navigator.locks; await h.dispose(); }
});

test("双窗口创建空会话后按首次 Turn 与活动时间同步侧栏", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); localStorage.setItem(key, JSON.stringify({ sessionId: "a" }));
  const sources = []; let resolvePost;
  class Source { constructor(url) { this.url = url; sources.push(this); } close() { this.closed = true; } frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); } }
  vi.stubGlobal("EventSource", Source);
  const a = { ...row("a"), createdAt: 1, updatedAt: 2 }; const b = { ...row("b"), createdAt: 1, updatedAt: 1 };
  vi.stubGlobal("fetch", vi.fn((_url, options) => options?.method === "POST" ? new Promise((resolve) => { resolvePost = resolve; }) : Promise.resolve({ ok: true, json: async () => ({ revision: 0, sessions: [a, b] }) })));
  const containers = [document.createElement("div"), document.createElement("div")]; containers.forEach((node) => document.body.append(node)); const roots = containers.map((node) => createRoot(node));
  const ids = (container) => [...container.querySelectorAll("nav button small")].map((item) => item.textContent);
  try {
    await act(async () => roots.forEach((root) => root.render(<App />)));
    await act(async () => { sources[0].frame({ type: "api-session/ready" }); sources[1].frame({ type: "api-session/ready" }); });
    await act(async () => [...containers[1].querySelectorAll("button")].find((button) => button.textContent.includes("新建会话")).click());
    const summary = { sessionId: "x", createdAt: 3, updatedAt: 3, blank: true, running: false };
    await act(async () => { for (const source of sources.slice(0, 2)) source.frame({ type: "api-session/added", revision: 1, summary }); });
    await act(async () => resolvePost({ ok: true, status: 201, json: async () => ({ sessionId: "x" }) }));
    expect(ids(containers[0])).toEqual(["a", "b"]); expect(ids(containers[1])).toEqual(["x", "a", "b"]);
    expect(containers[0].querySelector('[aria-current="page"]').textContent).toContain("a"); expect(containers[1].querySelector('[aria-current="page"]').textContent).toContain("x");
    expect(localStorage.getItem(key)).toBe('{"sessionId":"x"}');
    const write = vi.spyOn(Storage.prototype, "setItem");
    try {
      await act(async () => sources[0].frame({ type: "api-session/status", revision: 2, sessionId: "x", running: true }));
      expect(ids(containers[0])).toEqual(["a", "b"]);
      await act(async () => sources[0].frame({ type: "api-session/updated", revision: 3, sessionId: "x", blank: false, seq: 0 }));
      expect(ids(containers[0])).toEqual(["x", "a", "b"]);
      await act(async () => sources[0].frame({ type: "api-session/activity", revision: 4, sessionId: "b", updatedAt: 3 }));
      expect(ids(containers[0])).toEqual(["b", "x", "a"]);
      expect(containers[0].querySelector('[aria-current="page"]').textContent).toContain("a");
      expect(localStorage.getItem(key)).toBe('{"sessionId":"x"}'); expect(write).not.toHaveBeenCalled();
    } finally { write.mockRestore(); }
  } finally { await act(async () => roots.forEach((root) => root.unmount())); containers.forEach((node) => node.remove()); vi.unstubAllGlobals(); }
});
