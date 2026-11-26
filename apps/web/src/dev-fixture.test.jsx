// @vitest-environment jsdom
import React, { act } from "react";
import { expect, test, vi } from "vitest";

const created = vi.hoisted(() => ({ root: undefined }));
vi.mock("react-dom/client", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, createRoot(...args) { created.root = original.createRoot(...args); return created.root; } };
});

test("演示入口使用本页选择，不更改真实站点存储", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const realStorage = window.localStorage;
  realStorage.clear(); realStorage.setItem("mharness.sessions.current", '{"sessionId":"real"}');
  realStorage.setItem("mharness.session-directory.v1", '{"selected":"legacy"}');
  const storageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  const sourceDescriptor = Object.getOwnPropertyDescriptor(window, "EventSource");
  const fetchDescriptor = Object.getOwnPropertyDescriptor(window, "fetch");
  const container = document.createElement("div"); container.id = "root"; document.body.append(container);
  const sources = [];
  const define = Object.defineProperty;
  const defineSpy = vi.spyOn(Object, "defineProperty").mockImplementation((target, property, descriptor) => {
    if (target === window && property === "EventSource") {
      const FixtureSource = descriptor.value;
      descriptor = { ...descriptor, value: class extends FixtureSource {
        constructor(url) { super(url); if (url.endsWith("/session-directory/events")) sources.push(this); }
      } };
    }
    return define(target, property, descriptor);
  });
  try {
    await act(async () => { await import("./fixture.tsx"); });
    expect(realStorage.getItem("mharness.sessions.current")).toBe('{"sessionId":"real"}');
    expect(realStorage.getItem("mharness.session-directory.v1")).toBe('{"selected":"legacy"}');
    expect(container.querySelector('[aria-current="page"]').textContent).toContain("fixture");
    let response;
    await act(async () => { response = await fetch("/api/sessions", { method: "POST", body: "{}" }); });
    expect(response.status).toBe(201);
    const { sessionId } = await response.json();
    const directory = await (await fetch("/api/sessions")).json();
    expect(directory.sessions.filter((entry) => entry.sessionId === sessionId)).toHaveLength(1);
    expect(directory.sessions.map((entry) => entry.sessionId)).toEqual([sessionId, "fixture"]);
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent.includes("新建会话")).click());
    expect(container.querySelector('[aria-current="page"]').textContent).toContain("fixture-2");
    expect([...container.querySelectorAll("nav button small")].filter((item) => item.textContent === "fixture-2")).toHaveLength(1);
    vi.useFakeTimers();
    await act(async () => { sources[0].onerror(); await vi.advanceTimersByTimeAsync(250); });
    vi.useRealTimers();
    expect(sources).toHaveLength(2);
    expect(container.querySelector('[aria-current="page"]').textContent).toContain("fixture-2");
    expect([...container.querySelectorAll("nav button small")].filter((item) => item.textContent === "fixture-2")).toHaveLength(1);
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent.includes("fixture" ) && !button.textContent.includes("fixture-")).click());
    expect(container.textContent).not.toContain("fixture-2");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent.includes("关闭会话")).click());
    expect(realStorage.getItem("mharness.sessions.current")).toBe('{"sessionId":"real"}');
    const active = new EventSource("/api/session-directory/events");
    const closed = new EventSource("/api/session-directory/events");
    const activeFrames = []; const closedFrames = [];
    active.onmessage = (event) => activeFrames.push(JSON.parse(event.data));
    closed.onmessage = (event) => closedFrames.push(JSON.parse(event.data));
    await act(async () => {}); activeFrames.length = 0; closedFrames.length = 0;
    closed.close();
    let addedResponse;
    await act(async () => { addedResponse = await fetch("/api/sessions", { method: "POST", body: "{}" }); });
    const added = await addedResponse.json();
    const after = await (await fetch("/api/sessions")).json();
    expect(activeFrames).toHaveLength(1);
    expect(activeFrames[0]).toMatchObject({ type: "api-session/added", revision: after.revision, summary: { sessionId: added.sessionId } });
    expect(closedFrames).toEqual([]);
    expect(after.sessions.filter((entry) => entry.sessionId === added.sessionId)).toHaveLength(1);
    active.close();
    const immediateFrames = [];
    let immediateResponse;
    await act(async () => {
      const immediate = new EventSource("/api/session-directory/events");
      immediate.onmessage = (event) => immediateFrames.push(JSON.parse(event.data));
      immediateResponse = await fetch("/api/sessions", { method: "POST", body: "{}" });
      immediate.close();
    });
    expect(immediateResponse.status).toBe(201);
    expect(immediateFrames.map((frame) => frame.type)).toEqual(["api-session/ready", "api-session/added"]);
    const cancelledFrames = [];
    await act(async () => {
      const cancelled = new EventSource("/api/session-directory/events");
      cancelled.onmessage = (event) => cancelledFrames.push(JSON.parse(event.data));
      const response = fetch("/api/sessions", { method: "POST", body: "{}" });
      cancelled.close();
      await response;
    });
    expect(cancelledFrames).toEqual([]);
  } finally {
    vi.useRealTimers(); defineSpy.mockRestore();
    if (created.root) await act(async () => created.root.unmount());
    container.remove();
    for (const [name, descriptor] of [["localStorage", storageDescriptor], ["EventSource", sourceDescriptor], ["fetch", fetchDescriptor]]) {
      if (descriptor) Object.defineProperty(window, name, descriptor); else delete window[name];
    }
    realStorage.clear();
  }
});
