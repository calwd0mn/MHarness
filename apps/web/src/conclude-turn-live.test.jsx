// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { App } from "./App.tsx";
import { projectTools } from "./session/tools.ts";
import { createEventSessionApp } from "../../server/src/app.ts";
import { createModelTurnDriver } from "../../server/src/agent/model-turn.ts";
import { createMockAdapter } from "../../server/src/model/providers/mock.ts";
import { LlmRuntime } from "../../server/src/model/runtime.ts";
import { defineLocalTool, ToolRegistry } from "../../server/src/tools/registry.ts";
import { defineLocalToolOutput, HarnessError } from "../../server/src/tools/result.ts";

const nativeFetch = globalThis.fetch;
async function waitFor(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    let result;
    await act(async () => { result = await check(); await new Promise(resolve => setTimeout(resolve, 10)); });
    if (result) return result;
  }
  throw new Error("等待真实链路状态超时");
}
async function listen(app) {
  for (let i = 0; i < 100; i++) {
    try { return await app.listen({ host: "127.0.0.1", port: 55000 + Math.floor(Math.random() * 1000) }); }
    catch (error) { if (error.code !== "EADDRINUSE") throw error; }
  }
  throw new Error("没有可用测试端口");
}

test("结束意向保留到批次完成，后续明确错误仍展示并持久化", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const dir = await mkdtemp(join(tmpdir(), "mharness-conclude-live-"));
  const sources = [], calls = [], requests = [];
  let app, root, container, origin;
  try {
    const registry = new ToolRegistry();
    const input = z.strictObject({ n: z.number() });
    const output = defineLocalToolOutput({ schema: z.number(), render: (_, value) => [{ type: "text", text: `成功结果 ${value}` }] });
    registry.register(defineLocalTool({ name: "finish", version: "v1", description: "finish", input, output, sideEffect: "read-only", approvalPolicy: "allow", concludeTurn: true, handler: ({ n }) => { calls.push(["finish", n]); return n; } }));
    registry.register(defineLocalTool({ name: "fail", version: "v1", description: "fail", input, output, sideEffect: "read-only", approvalPolicy: "allow", handler: ({ n }) => { calls.push(["fail", n]); throw new HarnessError("明确业务失败", "BusinessError", "BUSINESS_FAILURE"); } }));
    const driver = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(request => {
      requests.push(structuredClone(request));
      return [
        { chunk: { type: "text", delta: "批次说明" } },
        { chunk: { type: "tool_call", index: 0, callId: "call-a", name: "finish", argumentsDelta: '{"n":1}' } },
        { chunk: { type: "tool_call", index: 1, callId: "call-b", name: "fail", argumentsDelta: '{"n":2}' } },
        { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
      ];
    }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: registry });
    const db = join(dir, "events.sqlite");
    app = await createEventSessionApp(db, false, driver);
    origin = await listen(app);
    class NetworkSource {
      constructor(url) { this.controller = new AbortController(); this.queue = []; this.delivered = []; sources.push(this); void this.read(origin + url); }
      async read(url) {
        try {
          const response = await nativeFetch(url, { signal: this.controller.signal });
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          while (!this.controller.signal.aborted) {
            const { value, done } = await reader.read(); if (done) break;
            buffer += value;
            let end;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const data = block.split("\n").find(line => line.startsWith("data:"));
              if (data) this.queue.push(JSON.parse(data.slice(5).trim()));
            }
          }
        } catch (error) { if (!this.controller.signal.aborted) this.failure = error; }
      }
      close() { this.controller.abort(); }
      async next() {
        await waitFor(() => { if (this.failure) throw this.failure; return this.queue.length; });
        const frame = this.queue.shift(); this.delivered.push(frame);
        await act(async () => this.onmessage?.({ data: JSON.stringify(frame) }));
        return frame;
      }
    }
    vi.stubGlobal("fetch", (url, options) => nativeFetch(origin + url, options));
    vi.stubGlobal("EventSource", NetworkSource);
    const post = (path, body) => nativeFetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const { sessionId } = await (await post("/api/sessions", {})).json();
    const path = `/api/sessions/${sessionId}`;
    localStorage.clear(); localStorage.setItem("mharness.session-directory.v1", JSON.stringify({ sessions: [sessionId], selected: sessionId }));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(<App />));
    await waitFor(() => sources.length === 1);
    expect((await sources[0].next()).type).toBe("snapshot");
    expect((await post(path + "/messages", { requestId: "first", content: [{ type: "text", text: "开始" }] })).status).toBe(202);
    let frame;
    do { frame = await sources[0].next(); } while (frame.event?.type !== "turn/end");
    expect(frame.event.data.reason).toEqual({ kind: "completed" });
    expect(calls).toEqual([["finish", 1], ["fail", 2]]);
    expect(requests).toHaveLength(1);
    const incremental = sources[0].delivered.filter(item => item.type === "event");
    expect(container.textContent).toContain("批次说明");
    expect(container.textContent).toContain("成功结果 1");
    expect(container.textContent).toContain("明确业务失败");
    expect(container.textContent).toContain("本轮结束：completed");
    await act(async () => root.unmount()); root = undefined;
    await app.close(); app = undefined;
    app = await createEventSessionApp(db, false, driver);
    origin = await listen(app);
    const history = await (await nativeFetch(origin + path)).json();
    const events = history.records.map(record => record.event);
    const results = events.filter(event => event.type === "tool/result").map(event => event.data);
    expect(events.filter(event => event.type === "tool/call").map(event => [event.data.callId, event.data.name])).toEqual([["call-a", "finish"], ["call-b", "fail"]]);
    expect(results.map(result => [result.message.source.callId, result.message.content[0].isError])).toEqual([["call-a", false], ["call-b", true]]);
    expect(results[0].message.content[0].content).toEqual([{ type: "text", text: "成功结果 1" }]);
    expect(results[1].message.content[0].content).toEqual([{ type: "text", text: "明确业务失败" }]);
    expect(results[1].error).toEqual({ name: "BusinessError", code: "BUSINESS_FAILURE" });
    expect(events.filter(event => event.type === "step/start")).toHaveLength(1);
    expect(events.filter(event => event.type === "step/end").map(event => event.data)).toEqual([{ turn: 1, step: 1 }]);
    expect(events.filter(event => event.type === "turn/end").map(event => event.data)).toEqual([{ turn: 1, reason: { kind: "completed" } }]);
    expect(events.slice(-2).map(event => event.type)).toEqual(["step/end", "turn/end"]);
    expect(incremental).toEqual(history.records);
    expect(projectTools(incremental)).toEqual(projectTools(history.records));
    root = createRoot(container); await act(async () => root.render(<App />));
    await waitFor(() => sources.length === 2);
    const snapshot = await sources[1].next();
    expect(snapshot.type).toBe("snapshot");
    expect(snapshot.records).toEqual(history.records);
    expect(projectTools(snapshot.records)).toEqual(projectTools(history.records));
    expect(container.textContent).toContain("批次说明");
    expect(container.textContent).toContain("成功结果 1");
    expect(container.textContent).toContain("明确业务失败");
    expect(container.textContent).toContain("本轮结束：completed");
    expect(calls).toEqual([["finish", 1], ["fail", 2]]);
    expect(requests).toHaveLength(1);
  } finally {
    if (root) await act(async () => root.unmount());
    container?.remove(); sources.forEach(source => source.close()); vi.unstubAllGlobals();
    try { await app?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}, 20000);
