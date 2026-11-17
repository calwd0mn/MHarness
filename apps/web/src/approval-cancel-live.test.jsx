// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { App } from "./App.tsx";
import { createEventSessionApp } from "../../server/src/app.ts";
import { createModelTurnDriver } from "../../server/src/agent/model-turn.ts";
import { createMockAdapter } from "../../server/src/model/providers/mock.ts";
import { LlmRuntime } from "../../server/src/model/runtime.ts";
import { ApprovalService } from "../../server/src/approval/service.ts";
import { defineLocalTool, ToolRegistry } from "../../server/src/tools/registry.ts";
import { defineLocalToolOutput } from "../../server/src/tools/result.ts";

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

test("中间消息 end 丢失后恢复并取消审批，下一轮保留完整上下文", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const dir = await mkdtemp(join(tmpdir(), "mharness-cancel-live-"));
  const sources = [];
  const requests = [];
  let app, root, container, executions = 0;
  try {
    const registry = new ToolRegistry();
    registry.register(defineLocalTool({ name: "change", version: "v1", description: "change", input: z.strictObject({ amount: z.number() }), sideEffect: "side-effect", approvalPolicy: "ask", concludeTurn: true,
      output: defineLocalToolOutput({ schema: z.number(), render: (_, value) => [{ type: "text", text: String(value) }] }), handler: ({ amount }) => { executions++; return amount; } }));
    const approvals = new ApprovalService();
    const driver = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(request => {
      requests.push(structuredClone(request));
      return requests.length === 1 ? [
        { chunk: { type: "text", delta: "执行前的说明" } },
        { chunk: { type: "tool_call", index: 0, callId: "call-1", name: "change", argumentsDelta: '{"amount":42}' } },
        { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
      ] : [{ chunk: { type: "text", delta: "下一轮完成" } }, { chunk: { type: "finish", reason: { kind: "stop" } } }];
    }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: registry, approvalService: approvals });
    app = await createEventSessionApp(join(dir, "events.sqlite"), false, driver, { approvalService: approvals });
    const origin = await listen(app);
    class NetworkSource {
      constructor(url) { this.controller = new AbortController(); this.queue = []; sources.push(this); void this.read(origin + url); }
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
      async next(deliver = true) {
        await waitFor(() => { if (this.failure) throw this.failure; return this.queue.length; });
        const frame = this.queue.shift();
        if (deliver) await act(async () => this.onmessage?.({ data: JSON.stringify(frame) }));
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
    let frame, dropped;
    do {
      await waitFor(() => sources[0].queue.length);
      const next = sources[0].queue[0];
      const isEnd = next.type === "assistant-stream" && next.frame.type === "end";
      frame = await sources[0].next(!isEnd);
      if (isEnd) dropped = frame;
    } while (!dropped);
    expect(dropped.frame.outcome.kind).toBe("committed");
    const before = await waitFor(async () => {
      const history = await (await nativeFetch(origin + path)).json();
      return history.records.some(record => record.event.type === "approval/asked") && history;
    });
    expect(before.records.filter(record => record.event.type === "assistant/message")).toHaveLength(1);
    const operations = before.records.filter(record => record.event.type === "tool/operation" && record.event.data.callId === "call-1");
    const approvalRecords = before.records.filter(record => record.event.type === "approval/asked" && record.event.data.callId === "call-1");
    expect(operations).toHaveLength(1);
    expect(approvalRecords).toHaveLength(1);
    const operation = operations[0].event.data;
    const asked = approvalRecords[0].event.data;
    expect(operation.operationId).toBeTruthy();
    expect(asked.id).toBeTruthy();
    expect(asked.operationId).toBe(operation.operationId);
    expect(executions).toBe(0);
    await act(async () => sources[0].onerror?.(new Error("模拟断线")));
    await waitFor(() => sources.length >= 2);
    expect((await sources[1].next()).type).toBe("snapshot");
    await waitFor(() => container.textContent.includes("等待审批"));
    expect(container.querySelector('[aria-label="审批详情"] button')).not.toBeNull();
    expect(container.textContent.split("执行前的说明")).toHaveLength(2);
    expect(container.querySelectorAll("article.assistant")).toHaveLength(1);
    const cancel = [...container.querySelectorAll("button")].find(button => button.textContent === "取消任务");
    expect(cancel).toBeTruthy();
    await act(async () => cancel.click());
    let history = await waitFor(async () => {
      const data = await (await nativeFetch(origin + path)).json();
      return data.records.some(record => record.event.type === "turn/end") && data;
    });
    do { frame = await sources[1].next(); } while (frame.event?.type !== "turn/end");
    await waitFor(() => container.textContent.includes("已取消"));
    expect(container.querySelector('[aria-label="审批详情"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="审批详情"] button')).toBeNull();
    const message = history.records.find(record => record.event.type === "assistant/message").event.data.message;
    expect(message.content).toEqual([{ type: "text", text: "执行前的说明" }, { type: "tool-call", id: "call-1", name: "change", arguments: '{"amount":42}' }]);
    const result = history.records.find(record => record.event.type === "tool/result").event.data;
    expect(result.error.code).toBe("ABORTED_BEFORE_DISPATCH");
    expect(result.message.source.callId).toBe("call-1");
    expect(result.operationId).toBe(operation.operationId);
    const decisions = history.records.filter(record => record.event.type === "approval/decided" && record.event.data.id === asked.id);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].event.data).toEqual({ id: asked.id, outcome: "cancelled" });
    expect(executions).toBe(0);
    expect((await post(path + "/messages", { requestId: "second", content: [{ type: "text", text: "继续" }] })).status).toBe(202);
    await waitFor(() => requests.length === 2);
    expect(requests[1].messages).toContainEqual({ role: "assistant", text: "执行前的说明", toolCalls: [{ callId: "call-1", name: "change", arguments: '{"amount":42}' }] });
    expect(requests[1].messages).toContainEqual({ role: "tool", callId: "call-1", text: JSON.stringify(result.message.content[0].content) });
    history = await waitFor(async () => {
      const data = await (await nativeFetch(origin + path)).json();
      return data.records.filter(record => record.event.type === "turn/end").length === 2 && data;
    });
    expect(history.records.filter(record => record.event.type === "assistant/message" && record.event.data.message.content.some(part => part.type === "text" && part.text === "执行前的说明"))).toHaveLength(1);
    expect(executions).toBe(0);
  } finally {
    if (root) await act(async () => root.unmount());
    container?.remove(); sources.forEach(source => source.close()); vi.unstubAllGlobals();
    try { await app?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}, 20000);
