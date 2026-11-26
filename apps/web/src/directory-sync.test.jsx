// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { App } from "./App.tsx";

test("目录 ready 后合并快照并确认选中项，卸载关闭订阅", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); localStorage.setItem("mharness.session-directory.v1", JSON.stringify({ sessions: ["a"], selected: "a" }));
  const sources = []; let resolve;
  class Source { constructor(url) { this.url = url; sources.push(this); } close() { this.closed = true; } frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); } }
  vi.stubGlobal("EventSource", Source);
  vi.stubGlobal("fetch", vi.fn(() => new Promise((done) => { resolve = done; })));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<App />));
    expect(sources.map((s) => s.url)).toEqual(["/api/session-directory/events"]);
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => sources[0].frame({ type: "api-session/ready" }));
    expect(fetch.mock.calls[0][0]).toBe("/api/sessions");
    expect(sources).toHaveLength(1);
    await act(async () => { resolve({ ok: true, json: async () => ({ revision: 0, sessions: [{ sessionId: "a", createdAt: 1, updatedAt: 1, running: false, blank: true }] }) }); });
    expect(sources[1].url).toBe("/api/sessions/a/follow");
    expect(container.textContent).toContain("a");
  } finally { await act(async () => root.unmount()); expect(sources[0].closed).toBe(true); container.remove(); vi.unstubAllGlobals(); }
});

test("原型属性名称的空会话不会被误认为本页创建", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear();
  const sources = [];
  class Source { constructor(url) { this.url = url; sources.push(this); } close() {} frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); } }
  vi.stubGlobal("EventSource", Source);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ revision: 0, sessions: ["constructor", "__proto__", "toString"].map((sessionId) => ({ sessionId, createdAt: 1, updatedAt: 1, running: false, blank: true })) }) })));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try { await act(async () => root.render(<App />)); await act(async () => sources[0].frame({ type: "api-session/ready" })); expect(container.textContent).not.toContain("constructor"); expect(container.textContent).not.toContain("__proto__"); expect(container.textContent).not.toContain("toString"); }
  finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

test("创建响应未知前收到撤回时不显示待核实项", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); const sources = []; let resolvePost;
  class Source { constructor(url) { this.url = url; sources.push(this); } close() {} frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); } }
  vi.stubGlobal("EventSource", Source);
  vi.stubGlobal("fetch", vi.fn((url, options) => options?.method === "POST" ? new Promise((resolve) => { resolvePost = resolve; }) : Promise.resolve({ ok: true, json: async () => ({ revision: 0, sessions: [] }) })));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<App />)); await act(async () => sources[0].frame({ type: "api-session/ready" }));
    await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent.includes("新建会话")).click());
    await act(async () => { sources[0].frame({ type: "api-session/added", revision: 1, summary: { sessionId: "x", createdAt: 1, updatedAt: 1, blank: true, running: false } }); sources[0].frame({ type: "api-session/removed", revision: 2, sessionId: "x", reason: "creation-failed" }); });
    await act(async () => resolvePost({ status: 503, json: async () => ({ code: "session_creation_unknown", sessionId: "x" }) }));
    expect(container.textContent).not.toContain("核实待保存会话");
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

test.each([true, false])("重连期间改选后按快照对账，快照是否包含选中项 %s", async (includesSelected) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); localStorage.setItem("mharness.session-directory.v1", JSON.stringify({ sessions: ["a", "b"], selected: "a" }));
  const sources = []; const reads = [];
  class Source { constructor(url) { this.url = url; sources.push(this); } close() { this.closed = true; } frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); } }
  vi.stubGlobal("EventSource", Source); vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => reads.push(resolve))));
  const row = (sessionId, blank = false) => ({ sessionId, createdAt: 1, updatedAt: 1, running: false, blank });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<App />)); await act(async () => sources[0].frame({ type: "api-session/ready" }));
    await act(async () => reads[0]({ ok: true, json: async () => ({ revision: 0, sessions: [row("a"), row("b")] }) }));
    vi.useFakeTimers(); await act(async () => { sources[0].onerror(); await vi.advanceTimersByTimeAsync(250); }); vi.useRealTimers();
    const directory = sources.findLast((s) => s.url === "/api/session-directory/events"); await act(async () => directory.frame({ type: "api-session/ready" }));
    await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent.includes("b")).click());
    expect(container.querySelector('[aria-current="page"]').textContent).toContain("b");
    const sessions = includesSelected ? [row("a", true), row("b", true)] : [row("a", true)];
    await act(async () => reads[1]({ ok: true, json: async () => ({ revision: 0, sessions }) }));
    if (includesSelected) {
      expect(container.querySelector('[aria-current="page"]').textContent).toContain("b");
      expect(container.textContent).not.toContain("会话 2");
      await act(async () => directory.frame({ type: "api-session/removed", revision: 1, sessionId: "b", reason: "creation-failed" }));
    }
    expect(container.querySelector('[aria-current="page"]')).toBeNull(); expect(sources.findLast((s) => s.url === "/api/sessions/b/follow").closed).toBe(true);
  } finally { vi.useRealTimers(); await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

test("读取期间确认创建受保护，随后较新快照可以对账", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); const sources = []; const reads = []; let post;
  class Source { constructor(url) { this.url = url; sources.push(this); } close() {} frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); } }
  vi.stubGlobal("EventSource", Source); vi.stubGlobal("fetch", vi.fn((url, options) => options?.method === "POST" ? new Promise((resolve) => { post = resolve; }) : new Promise((resolve) => reads.push(resolve))));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<App />)); await act(async () => sources[0].frame({ type: "api-session/ready" }));
    await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent.includes("新建会话")).click());
    await act(async () => post({ ok: true, json: async () => ({ sessionId: "x" }) }));
    await act(async () => reads[0]({ ok: true, json: async () => ({ revision: 0, sessions: [] }) }));
    expect(container.querySelector('[aria-current="page"]').textContent).toContain("x");
    vi.useFakeTimers(); await act(async () => { sources[0].onerror(); await vi.advanceTimersByTimeAsync(250); }); vi.useRealTimers();
    const directory = sources.findLast((s) => s.url === "/api/session-directory/events"); await act(async () => directory.frame({ type: "api-session/ready" }));
    await act(async () => reads[1]({ ok: true, json: async () => ({ revision: 0, sessions: [] }) }));
    expect(container.querySelector('[aria-current="page"]')).toBeNull();
  } finally { vi.useRealTimers(); await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

test.each([true, false])("初始读取失败保留提示，重试对账及收到通知不影响其他窗口；原提示有效 %s", async (validHint) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); localStorage.setItem("mharness.session-directory.v1", JSON.stringify({ sessions: ["a"], selected: "a" }));
  const sources = []; const reads = [];
  class Source { constructor(url) { this.url = url; sources.push(this); } close() {} frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); } }
  vi.stubGlobal("EventSource", Source); vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => reads.push(resolve))));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<App />)); await act(async () => sources[0].frame({ type: "api-session/ready" }));
    await act(async () => reads[0]({ ok: false })); expect(container.textContent).toContain("重试目录"); expect(JSON.parse(localStorage.getItem("mharness.session-directory.v1")).selected).toBe("a");
    await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent.includes("重试目录")).click());
    const directory = sources.findLast((s) => s.url === "/api/session-directory/events"); await act(async () => directory.frame({ type: "api-session/ready" }));
    localStorage.setItem("mharness.session-directory.v1", JSON.stringify({ sessions: ["b"], selected: "b" }));
    const a = { sessionId: "a", createdAt: 1, updatedAt: 1, blank: false, running: false };
    await act(async () => reads[1]({ ok: true, json: async () => ({ revision: 0, sessions: validHint ? [a] : [] }) }));
    const selected = container.querySelector('[aria-current="page"]');
    if (validHint) expect(selected.textContent).toContain("a");
    else expect(selected).toBeNull();
    await act(async () => directory.frame({ type: "api-session/added", revision: 1, summary: { ...a, sessionId: "c" } }));
    expect(JSON.parse(localStorage.getItem("mharness.session-directory.v1")).selected).toBe("b");
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

test.each([
  { responseFirst: true, timing: "实时" },
  { responseFirst: false, timing: "实时" },
  { responseFirst: true, timing: "快照前" },
  { responseFirst: false, timing: "快照前" },
  { responseFirst: true, timing: "快照后" },
  { responseFirst: false, timing: "快照后" },
])("撤回后不保留待核实项（响应先到 $responseFirst，帧到达 $timing）", async ({ responseFirst, timing }) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); const sources = []; let post, read;
  class Source { constructor(url) { this.url = url; sources.push(this); } close() {} frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); } }
  vi.stubGlobal("EventSource", Source);
  vi.stubGlobal("fetch", vi.fn((_url, options) => options?.method === "POST"
    ? new Promise((resolve) => { post = resolve; })
    : timing !== "实时"
      ? new Promise((resolve) => { read = resolve; })
      : Promise.resolve({ ok: true, json: async () => ({ revision: 0, sessions: [] }) })));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<App />)); await act(async () => sources[0].frame({ type: "api-session/ready" })); await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent.includes("新建会话")).click());
    const response = () => post({ status: 503, json: async () => ({ code: "session_creation_unknown", sessionId: "x" }) });
    const remove = () => sources[0].frame({ type: "api-session/removed", revision: 1, sessionId: "x", reason: "creation-failed" });
    if (responseFirst) await act(async () => response());
    if (timing !== "快照后") await act(async () => remove());
    if (timing !== "实时") await act(async () => read({ ok: true, json: async () => ({ revision: 1, sessions: [] }) }));
    if (timing === "快照后") {
      if (responseFirst) expect(container.textContent).toContain("核实待保存会话");
      await act(async () => remove());
    }
    if (!responseFirst) await act(async () => response());
    expect(container.textContent).not.toContain("核实待保存会话");
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

test("撤回已进入目录状态时，旧导航按钮不能打开 follow 或保存选择", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  const sources = [];
  class Source {
    constructor(url) { this.url = url; sources.push(this); }
    close() {}
    frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  vi.stubGlobal("EventSource", Source);
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({
      revision: 0,
      sessions: [{ sessionId: "old", createdAt: 1, updatedAt: 1, blank: false, running: false }],
    }),
  })));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<App />));
    await act(async () => sources[0].frame({ type: "api-session/ready" }));
    const priorButton = container.querySelector("nav button");
    await act(async () => {
      sources[0].frame({ type: "api-session/removed", revision: 1, sessionId: "old", reason: "creation-failed" });
      priorButton.click();
    });
    expect(sources.map(({ url }) => url)).toEqual(["/api/session-directory/events"]);
    expect(localStorage.getItem("mharness.session-directory.v1")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

test.each([true, false])("断线遗漏撤回时重连快照对账待核实会话，曾收到新增 %s", async (observedAddition) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  const sources = [];
  let revision = 0;
  class Source {
    constructor(url) { this.url = url; sources.push(this); }
    close() {}
    frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  vi.stubGlobal("EventSource", Source);
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => options?.method === "POST"
    ? { status: 503, json: async () => ({ code: "session_creation_unknown", sessionId: "x" }) }
    : { ok: true, json: async () => ({ revision, sessions: [] }) }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<App />));
    await act(async () => sources[0].frame({ type: "api-session/ready" }));
    if (observedAddition) {
      await act(async () => sources[0].frame({
        type: "api-session/added",
        revision: 1,
        summary: { sessionId: "x", createdAt: 1, updatedAt: 1, blank: true, running: false },
      }));
    }
    const create = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("新建会话"));
    await act(async () => create.click());
    expect(container.textContent).toContain("核实待保存会话");
    revision = 2;
    vi.useFakeTimers();
    await act(async () => { sources[0].onerror(); await vi.advanceTimersByTimeAsync(250); });
    vi.useRealTimers();
    await act(async () => sources[1].frame({ type: "api-session/ready" }));
    expect(container.textContent).not.toContain("核实待保存会话");
  } finally {
    vi.useRealTimers();
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

test("added 先于 201 时沿用服务端摘要，切走后隐藏空会话", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); const sources = []; let post;
  class Source { constructor(url) { this.url = url; sources.push(this); } close() {} frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); } }
  vi.stubGlobal("EventSource", Source); vi.stubGlobal("fetch", vi.fn((url, options) => options?.method === "POST" ? new Promise((resolve) => { post = resolve; }) : Promise.resolve({ ok: true, json: async () => ({ revision: 0, sessions: [{ sessionId: "a", createdAt: 1, updatedAt: 1, blank: false, running: false }] }) })));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<App />)); await act(async () => sources[0].frame({ type: "api-session/ready" })); await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent.includes("新建会话")).click());
    await act(async () => sources[0].frame({ type: "api-session/added", revision: 1, summary: { sessionId: "x", createdAt: 2, updatedAt: 2, blank: true, running: false } }));
    await act(async () => post({ ok: true, json: async () => ({ sessionId: "x" }) }));
    expect([...container.querySelectorAll("nav button")].filter((b) => b.textContent.includes("x"))).toHaveLength(1);
    await act(async () => [...container.querySelectorAll("nav button")].find((b) => b.textContent.includes("a")).click());
    expect([...container.querySelectorAll("nav button")].some((b) => b.textContent.includes("x"))).toBe(false);
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

test("201 先于目录帧时立即把已确认的新会话按活动时间排序", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  const sources = [];
  class Source {
    constructor(url) { this.url = url; sources.push(this); }
    close() {}
    frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  vi.stubGlobal("EventSource", Source);
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => options?.method === "POST"
    ? { ok: true, json: async () => ({ sessionId: "new" }) }
    : { ok: true, json: async () => ({ revision: 0, sessions: [{ sessionId: "old", createdAt: 1, updatedAt: 1, blank: false, running: false }] }) }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<App />));
    await act(async () => sources[0].frame({ type: "api-session/ready" }));
    const create = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("新建会话"));
    await act(async () => create.click());
    expect([...container.querySelectorAll("nav button small")].map((item) => item.textContent)).toEqual(["new", "old"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

test("快照截点之后已撤回的行不会短暂呈现", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); const sources = []; let read;
  class Source { constructor(url) { this.url = url; sources.push(this); } close() {} frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); } }
  vi.stubGlobal("EventSource", Source); vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { read = resolve; })));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); const observed = [];
  const observer = new MutationObserver(() => observed.push(container.textContent)); observer.observe(container, { subtree: true, childList: true, characterData: true });
  try {
    await act(async () => root.render(<App />)); await act(async () => sources[0].frame({ type: "api-session/ready" }));
    await act(async () => sources[0].frame({ type: "api-session/removed", revision: 1, sessionId: "gone", reason: "creation-failed" }));
    await act(async () => read({ ok: true, json: async () => ({ revision: 0, sessions: [{ sessionId: "gone", createdAt: 1, updatedAt: 1, blank: false, running: false }] }) }));
    expect(observed.some((text) => text.includes("gone"))).toBe(false);
  } finally { observer.disconnect(); await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
