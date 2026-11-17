// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { test, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createEventSessionApp } from "../../server/src/app.ts";
import { createModelTurnDriver } from "../../server/src/agent/model-turn.ts";
import { createMockAdapter } from "../../server/src/model/providers/mock.ts";
import { LlmRuntime } from "../../server/src/model/runtime.ts";
import { ToolRegistry, defineLocalTool } from "../../server/src/tools/registry.ts";
import { defineLocalToolOutput, HarnessError } from "../../server/src/tools/result.ts";
import { ApprovalService } from "../../server/src/approval/service.ts";
import { Session, SqliteSessionPersistence } from "@mharness/session/server";
import { projectTools } from "./session/tools.ts";
import { App } from "./App.tsx";

const nativeFetch = globalThis.fetch;
const sleep = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await act(async () => sleep()); }
  throw new Error("等待真实服务状态超时");
}
async function listen(app) {
  for (let i = 0; i < 20; i++) {
    try { return await app.listen({ host: "127.0.0.1", port: 20000 + Math.floor(Math.random() * 40000) }); }
    catch (error) { if (error.code !== "EADDRINUSE") throw error; }
  }
  throw new Error("没有可用的测试端口");
}

test("真实工具流、快照和持久历史一致地呈现参数与结果", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const dir = await mkdtemp(join(tmpdir(), "mharness-tools-live-"));
  let app, root, source;
  let base;
  const container = document.createElement("div"); document.body.append(container);
  try {
  const path = join(dir, "events.sqlite");
  const seed = new SqliteSessionPersistence(path);
  try {
    const session = new Session({ sessionId: "recovered", createdAt: 0 });
    const handle = await seed.create(session.header);
    await handle.flush();
    seed.bindWriter(handle, session);
    session.append({ type: "turn/start", data: { turn: 1 } });
    session.append({ type: "step/start", data: { turn: 1, step: 1 } });
    session.append({ type: "assistant/message", surfaceOp: "append", data: {
      turn: 1, step: 1, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true,
      message: { id: "recover-message", role: "assistant", source: { provider: "mock", model: "m" }, content: [{ type: "tool-call", id: "unstarted", name: "查找", arguments: '{"n":99}' }] },
    } });
    await session.flush();
    await handle.close();
  } finally { await seed.close(); }
  const registry = new ToolRegistry();
  let calls = 0;
  const input = z.strictObject({ n: z.number() });
  const output = defineLocalToolOutput({ schema: z.number(), render: (_args, value) => [{ type: "text", text: `结果 ${value}` }], presentationMeta: (_args, value) => ({ 展示: value }) });
  registry.register(defineLocalTool({ name: "查找", version: "v1", description: "查找", input, output, sideEffect: "read-only", approvalPolicy: "ask", concludeTurn: true, handler: ({ n }) => { calls++; if (n === 2) throw new HarnessError("公开失败", "BusinessError", "BUSINESS"); return n; } }));
  const approval = new ApprovalService();
  let requests = 0;
  const driver = createModelTurnDriver({ toolRegistry: registry, approvalService: approval, runtime: new LlmRuntime({ mock: createMockAdapter((request) => {
    const prompt = request.messages.findLast(message => message.role === "user")?.text;
    if (prompt === "截断") return [{ chunk: { type: "text", delta: "截断片段" } }, { chunk: { type: "finish", reason: { kind: "output_limit" } } }];
    if (prompt === "取消") return [{ chunk: { type: "text", delta: "取消片段" } }, { delayMs: 5000, chunk: { type: "finish", reason: { kind: "stop" } } }];
    return ++requests === 1 ? [
    { chunk: { type: "reasoning", delta: "推理内容" } },
    { chunk: { type: "tool_call", index: 0, callId: "valid", name: "查找", argumentsDelta: '{ "n": 1 }' } },
    { chunk: { type: "tool_call", index: 1, callId: "invalid", name: "查找", argumentsDelta: '{"n":"错误"}' } },
    { chunk: { type: "tool_call", index: 2, callId: "error", name: "查找", argumentsDelta: '{"n":2}' } },
    { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
  ] : [{ chunk: { type: "finish", reason: { kind: "stop" } } }];
  }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "" });
  app = await createEventSessionApp(path, false, driver, { approvalService: approval });
  base = await listen(app);
  class RealSource {
    constructor(url) {
      source = this; this.controller = new AbortController(); this.queue = []; this.delivered = [];
      void this.read(url);
    }
    async read(url) {
      try {
        const response = await nativeFetch(base + url, { signal: this.controller.signal });
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end; while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = block.split("\n").find(line => line.startsWith("data:"));
            if (data) this.queue.push(JSON.parse(data.slice(5).trim()));
          }
        }
      } catch (error) { if (!this.controller.signal.aborted) throw error; }
    }
    close() { this.controller.abort(); }
    async next() { await until(() => this.queue.length > 0); const frame = this.queue.shift(); this.delivered.push(frame); await act(async () => { this.onmessage?.({ data: JSON.stringify(frame) }); }); return frame; }
  }
    vi.stubGlobal("fetch", (url, options) => nativeFetch(base + url, options));
    vi.stubGlobal("EventSource", RealSource);
    const created = await nativeFetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const { sessionId } = await created.json();
    localStorage.clear(); localStorage.setItem("mharness.session-directory.v1", JSON.stringify({ sessions: [sessionId, "recovered"], selected: sessionId }));
    root = createRoot(container); await act(async () => root.render(<App />));
    await until(() => source); expect((await source.next()).type).toBe("snapshot");
    const submitted = await nativeFetch(`${base}/api/sessions/${sessionId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "request", content: [{ type: "text", text: "查询" }] }) });
    expect(submitted.status).toBe(202);
    let frame;
    do { frame = await source.next(); } while (frame.event?.type !== "tool/call");
    expect(container.textContent).toContain("准备调用");
    expect([...container.querySelectorAll("details summary")].find(item => item.textContent.includes("查找")).textContent).toContain('{ "n": 1 }');
    expect(container.querySelectorAll("article.assistant")).toHaveLength(1);
    expect(container.querySelector("article.assistant details").open).toBe(false);
    do { frame = await source.next(); } while (frame.event?.type !== "approval/asked");
    expect(container.textContent).toContain("等待审批");
    expect(container.textContent).toContain('"n": 1');
    const toolDetail = [...container.querySelectorAll("details")].find(item => item.querySelector("summary")?.textContent.includes("查找"));
    await act(async () => toolDetail.querySelector("summary").click());
    expect(toolDetail.open).toBe(true);
    expect(toolDetail.textContent).toContain("已校验参数");
    expect(calls).toBe(0);
    const answer = async (id) => nativeFetch(`${base}/api/sessions/${sessionId}/approvals/${id}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outcome: "allowed-once" }) });
    expect((await answer(frame.event.data.id)).status).toBe(200);
    do { frame = await source.next(); } while (!(frame.event?.type === "approval/asked" && frame.event.data.id));
    expect(container.textContent).toContain("INVALID_INPUT");
    expect((await answer(frame.event.data.id)).status).toBe(200);
    do { frame = await source.next(); } while (frame.event?.type !== "turn/end");
    expect(container.textContent).toContain("BUSINESS"); expect(container.textContent).toContain("公开失败");
    expect(container.textContent).toContain("展示"); expect(calls).toBe(2);
    const incremental = source.delivered.filter(item => item.type === "event");
    await act(async () => root.unmount()); root = undefined;
    await app.close();
    app = await createEventSessionApp(path, false, driver, { approvalService: approval });
    base = await listen(app);
    const history = await (await nativeFetch(`${base}/api/sessions/${sessionId}`)).json();
    const tools = projectTools(history.records);
    expect(tools.map(t => [t.callId, t.status, t.validatedArgs])).toEqual([["valid", "成功", { n: 1 }], ["invalid", "失败", undefined], ["error", "失败", { n: 2 }]]);
    expect(tools[0].version).toBe("v1"); expect(tools[0].result.meta).toEqual({ 展示: 1 });
    expect(tools[1].result.message.content[0].isError).toBe(true); expect(tools[1].result.error.code).toBe("INVALID_INPUT");
    expect(tools[2].result.message.content[0].isError).toBe(true); expect(tools[2].result.error.code).toBe("BUSINESS");
    expect(projectTools(incremental)).toEqual(projectTools(history.records));
    root = createRoot(container); await act(async () => root.render(<App />));
    await until(() => source.queue.length > 0); const snapshot = await source.next(); expect(snapshot.type).toBe("snapshot");
    expect(projectTools(snapshot.records)).toEqual(projectTools(history.records));
    expect(container.textContent).toContain("BUSINESS"); expect(container.textContent).toContain("展示");
    const submit = async (requestId, text) => nativeFetch(`${base}/api/sessions/${sessionId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, content: [{ type: "text", text }] }) });
    expect((await submit("truncate", "截断")).status).toBe(202);
    do { frame = await source.next(); } while (frame.event?.type !== "turn/end");
    expect(container.textContent).toContain("截断片段"); expect(container.textContent).toContain("已截断");
    expect((await submit("cancel", "取消")).status).toBe(202);
    do { frame = await source.next(); } while (!(frame.type === "assistant-stream" && JSON.stringify(frame).includes("取消片段")));
    expect((await nativeFetch(`${base}/api/sessions/${sessionId}/cancel`, { method: "POST" })).status).toBe(202);
    do { frame = await source.next(); } while (frame.event?.type !== "turn/end");
    expect(container.textContent).toContain("取消片段"); expect(container.textContent).toContain("已取消");
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent.includes("会话 2")).click());
    await until(() => source.queue.length > 0); expect((await source.next()).type).toBe("snapshot");
    expect(container.textContent).toContain("未开始"); expect(container.textContent).toContain("TOOL_NOT_STARTED");
    expect(container.textContent).toContain('{"n":99}');
    expect(container.querySelectorAll("article.assistant")).toHaveLength(0);
    expect(calls).toBe(2);
  } finally {
    if (root) await act(async () => root.unmount());
    container.remove(); vi.unstubAllGlobals();
    try { await app?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}, 20000);
