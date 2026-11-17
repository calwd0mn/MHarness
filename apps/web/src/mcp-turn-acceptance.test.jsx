// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./App.tsx";
import { createEventSessionApp } from "../../server/src/app.ts";
import { createModelTurnDriver } from "../../server/src/agent/model-turn.ts";
import { createMockAdapter } from "../../server/src/model/providers/mock.ts";
import { LlmRuntime } from "../../server/src/model/runtime.ts";
import { ToolRegistry } from "../../server/src/tools/registry.ts";
import { ApprovalService } from "../../server/src/approval/service.ts";
import { connectMcpTools } from "../../server/src/tools/mcp.ts";
import { startMockMcp } from "../../mock-mcp/src/server.ts";

const nativeFetch = globalThis.fetch;
async function waitFor(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    let value;
    await act(async () => { value = await check(); await new Promise(resolve => setTimeout(resolve, 10)); });
    if (value) return value;
  }
  throw new Error("等待验收状态超时");
}
async function safePort(start) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await start(55000 + Math.floor(Math.random() * 4000)); }
    catch (error) { if (error.code !== "EADDRINUSE") throw error; }
  }
  throw new Error("没有可用测试端口");
}
const scenarios = [
  { name: "正常问答", calls: [], reason: "completed", models: 1, codes: [] },
  { name: "单次允许", calls: [["w", "mock_write", "写入"]], action: "单次允许", reason: "completed", models: 2, codes: [null], effects: ["写入"] },
  { name: "只读超时继续", calls: [["r", "mock_read", "读取"]], hold: "mock_read", reason: "completed", models: 2, codes: ["TOOL_TIMEOUT"] },
  { name: "副作用超时结束", calls: [["w", "mock_write", "写入"], ["r", "mock_read", "后续"]], action: "单次允许", hold: "mock_write", reason: "error", models: 1, codes: ["TOOL_TIMEOUT", "TOOL_NOT_STARTED"], effects: ["写入"] },
  { name: "明确拒绝", calls: [["w", "mock_write", "写入"], ["r", "mock_read", "后续"]], action: "拒绝", reason: "blocked", models: 1, codes: ["APPROVAL_REJECTED", "TOOL_NOT_STARTED"] },
  { name: "审批时取消", calls: [["w", "mock_write", "写入"]], action: "取消任务", reason: "aborted", models: 1, codes: ["ABORTED_BEFORE_DISPATCH"] },
];

for (const scenario of scenarios) test(`真实页面和 MCP 闭环：${scenario.name}`, async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const dir = await mkdtemp(join(tmpdir(), "mharness-acceptance-"));
  const requests = [], modelRequests = [], sources = [], held = [];
  let upstream, proxy, connection, app, root, container, origin;
  try {
    const ledgerPath = join(dir, "ledger.sqlite");
    upstream = await safePort(port => startMockMcp(port, ledgerPath));
    proxy = createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString();
        const request = body ? JSON.parse(body) : {};
        if (request.method === "tools/call") requests.push(structuredClone(request.params));
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) if (value && key !== "host" && key !== "content-length") headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        const response = await nativeFetch(upstream.url, { method: req.method, headers, ...(body ? { body } : {}) });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (request.method === "tools/call" && request.params.name === scenario.hold) {
          const envelope = JSON.parse(bytes.toString());
          let released = false;
          const closed = new Promise(resolve => {
            if (res.destroyed) resolve();
            else res.once("close", resolve);
          });
          held.push({
            status: response.status,
            envelope,
            async release() {
              if (!released) {
                released = true;
                if (!res.destroyed) {
                  res.writeHead(response.status, Object.fromEntries(response.headers));
                  res.end(bytes);
                }
              }
              await closed;
            },
          });
          return;
        }
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(bytes);
      } catch { res.destroy(); }
    });
    await safePort(port => new Promise((resolve, reject) => {
      const failed = error => reject(error);
      proxy.once("error", failed);
      proxy.listen(port, "127.0.0.1", () => {
        proxy.off("error", failed);
        resolve();
      });
    }));
    const registry = new ToolRegistry();
    connection = await connectMcpTools(registry, `http://127.0.0.1:${proxy.address().port}/mcp`, [
      { name: "mock_read", version: "1", sideEffect: "read-only", approvalPolicy: "allow", ...(scenario.hold === "mock_read" ? { timeoutMs: 1500 } : {}) },
      { name: "mock_write", version: "1", sideEffect: "side-effect", supportsIdempotency: true, approvalPolicy: "ask", ...(scenario.hold === "mock_write" ? { timeoutMs: 1500 } : {}) },
    ]);
    const approvalService = new ApprovalService();
    const driver = createModelTurnDriver({ approvalService, runtime: new LlmRuntime({ mock: createMockAdapter(request => {
      modelRequests.push(structuredClone(request));
      if (modelRequests.length === 1 && scenario.calls.length) return [
        ...scenario.calls.map(([id, name, text], index) => ({ chunk: { type: "tool_call", index, callId: id, name, argumentsDelta: JSON.stringify({ text }) } })),
        { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
      ];
      return [{ chunk: { type: "text", delta: "验收回答" } }, { chunk: { type: "finish", reason: { kind: "stop" } } }];
    }) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: registry });
    app = await createEventSessionApp(join(dir, "session.sqlite"), false, driver, { approvalService });
    origin = await safePort(port => app.listen({ host: "127.0.0.1", port }));
    class NetworkSource {
      constructor(url) { this.controller = new AbortController(); this.queue = []; this.delivered = []; sources.push(this); void this.read(origin + url); }
      async read(url) {
        try {
          const response = await nativeFetch(url, { signal: this.controller.signal });
          if (!response.ok || !response.body) throw new Error(`SSE 连接失败：HTTP ${response.status}`);
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader(); let buffer = "";
          while (!this.controller.signal.aborted) {
            const { value, done } = await reader.read(); if (done) break; buffer += value; let end;
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
        await act(async () => this.onmessage?.({ data: JSON.stringify(frame) })); return frame;
      }
    }
    vi.stubGlobal("fetch", (url, options) => nativeFetch(String(url).startsWith("/") ? origin + url : url, options));
    vi.stubGlobal("EventSource", NetworkSource);
    const post = (path, body) => nativeFetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const { sessionId } = await (await post("/api/sessions", {})).json();
    const path = `/api/sessions/${sessionId}`;
    localStorage.clear(); localStorage.setItem("mharness.session-directory.v1", JSON.stringify({ sessions: [sessionId], selected: sessionId }));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(<App />)); await waitFor(() => sources.length === 1); expect((await sources[0].next()).type).toBe("snapshot");
    const textarea = container.querySelector("textarea");
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(textarea, "开始验收"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    if (scenario.action) {
      let frame; do { frame = await sources[0].next(); } while (frame.event?.type !== "approval/asked");
      expect(requests).toHaveLength(0); expect(upstream.effects()).toEqual([]);
      const card = [...container.querySelectorAll("details")].find(item => item.textContent.includes("mock_write"));
      expect(card.textContent).toContain("等待审批");
      expect(card.textContent).toContain("工具版本1");
      expect(card.textContent).toContain('"text": "写入"');
      const button = [...container.querySelectorAll("button")].find(item => item.textContent === scenario.action);
      expect(button).toBeTruthy(); await act(async () => button.click());
    }
    if (scenario.hold) {
      await waitFor(() => held.length === 1);
      expect(sources[0].queue.some(item => item.event?.type === "turn/end" || item.event?.data?.error?.code === "TOOL_TIMEOUT")).toBe(false);
      expect(held[0].status).toBe(200); expect(held[0].envelope.result).toBeTruthy(); expect(held[0].envelope.result.isError).not.toBe(true);
      if (scenario.hold === "mock_write") {
        const reader = new DatabaseSync(ledgerPath, { readOnly: true });
        const committed = reader.prepare("SELECT operation_id, text FROM mock_effects").all(); reader.close();
        expect(committed.map(row => [JSON.parse(row.operation_id), JSON.parse(row.text)])).toEqual([[requests[0].arguments.operationId, "写入"]]);
        expect(held[0].envelope.result.structuredContent).toEqual({ text: "写入", operationId: requests[0].arguments.operationId });
      }
    }
    let frame; do { frame = await sources[0].next(); } while (frame.event?.type !== "turn/end");
    expect(frame.event.data.reason.kind).toBe(scenario.reason);
    if (scenario.reason === "error") expect(frame.event.data.reason.error.code).toBe("TOOL_TIMEOUT");
    if (scenario.reason === "aborted") expect(frame.event.data.reason.reason).toBe("user");
    const incremental = sources[0].delivered.filter(item => item.type === "event");
    const history = await waitFor(async () => { const value = await (await nativeFetch(origin + path)).json(); return value.records.length === incremental.length && value; });
    expect(incremental).toEqual(history.records);
    expect(history.records.map(record => record.event.seq)).toEqual(history.records.map((_, index) => index));
    const events = history.records.map(record => record.event);
    expect(events.filter(event => event.type === "user/message" && event.data.source.kind === "user")).toHaveLength(1);
    const declarations = events.filter(event => event.type === "assistant/message");
    const results = events.filter(event => event.type === "tool/result");
    expect(declarations.flatMap(event => event.data.message.content.filter(part => part.type === "tool-call").map(part => [part.id, part.name, JSON.parse(part.arguments).text]))).toEqual(scenario.calls);
    const answers = declarations.flatMap(event => event.data.message.content.filter(part => part.type === "text" && part.text === "验收回答"));
    expect(answers).toHaveLength(scenario.reason === "completed" ? 1 : 0);
    expect(container.textContent.split("开始验收").length - 1).toBe(1);
    expect(container.textContent.split("验收回答").length - 1).toBe(scenario.reason === "completed" ? 1 : 0);
    expect(results.map(event => event.data.error?.code ?? null)).toEqual(scenario.codes);
    for (const declaration of declarations) for (const call of declaration.data.message.content.filter(part => part.type === "tool-call")) {
      const matching = results.filter(event => event.data.turn === declaration.data.turn && event.data.step === declaration.data.step && event.data.message.source.callId === call.id);
      expect(matching).toHaveLength(1);
      const dispatched = events.find(event => event.type === "tool/call" && event.data.turn === declaration.data.turn && event.data.step === declaration.data.step && event.data.callId === call.id);
      const operation = events.find(event => event.type === "tool/operation" && event.data.turn === declaration.data.turn && event.data.step === declaration.data.step && event.data.callId === call.id);
      expect(matching[0].sourceEventSeqs).toEqual([dispatched?.seq ?? declaration.seq]);
      expect(matching[0].data.operationId).toBe(operation?.data.operationId);
    }
    if (["明确拒绝", "副作用超时结束"].includes(scenario.name)) {
      expect(events.some(event => ["tool/call", "tool/operation"].includes(event.type) && event.data.callId === "r")).toBe(false);
    }
    expect(modelRequests).toHaveLength(scenario.models);
    if (scenario.models === 2) {
      const toolMessages = modelRequests[1].messages.filter(message => message.role === "tool");
      expect(toolMessages.map(message => message.callId)).toEqual([scenario.calls[0][0]]);
      expect(toolMessages[0].text).toContain(scenario.hold ? "等待工具响应超时" : "写入");
    }
    const expectedRequests = scenario.action === "拒绝" || scenario.action === "取消任务" ? 0 : scenario.calls.length ? 1 : 0;
    expect(requests).toHaveLength(expectedRequests);
    if (requests.length) {
      const operation = events.find(event => event.type === "tool/operation");
      expect(requests[0]).toEqual({ name: scenario.calls[0][1], arguments: { text: scenario.calls[0][2], operationId: operation.data.operationId } });
    }
    if (scenario.action) {
      const asked = events.find(event => event.type === "approval/asked");
      const decision = events.find(event => event.type === "approval/decided");
      expect(decision.data.id).toBe(asked.data.id);
      expect(decision.data.outcome).toBe(scenario.action === "单次允许" ? "allowed-once" : scenario.action === "拒绝" ? "rejected" : "cancelled");
    }
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    const operations = db.prepare("SELECT * FROM mock_operations").all();
    const effects = db.prepare("SELECT * FROM mock_effects").all();
    db.close();
    expect(effects.map(row => JSON.parse(row.text))).toEqual(scenario.effects ?? []);
    expect(operations).toHaveLength((scenario.effects ?? []).length);
    if (operations.length) {
      expect(JSON.parse(operations[0].operation_id)).toBe(requests[0].arguments.operationId);
      expect(JSON.parse(operations[0].arguments)).toEqual({ text: scenario.calls[0][2] });
      expect(JSON.parse(operations[0].tool_name)).toBe("mock_write");
    }
    const statuses = scenario.codes.map(code => code === null ? "成功" : code === "TOOL_NOT_STARTED" ? "未开始" : code === "TOOL_TIMEOUT" ? "超时" : code === "ABORTED_BEFORE_DISPATCH" ? "已取消" : "失败");
    for (const [index, status] of statuses.entries()) {
      const [id, name] = scenario.calls[index];
      const card = [...container.querySelectorAll("details")].find(item => item.querySelector("summary")?.textContent.startsWith(name));
      expect(card?.querySelector("summary")?.textContent).toContain(`${name} · ${status}`);
      expect(card?.textContent).toContain(id === "w" ? "写入" : scenario.calls[index][2]);
    }
    expect(container.textContent).toContain(scenario.reason === "error" ? "本轮失败：工具超时，最终结果未确认" : `本轮结束：${scenario.reason}`);
    if (scenario.reason === "completed") expect(container.textContent).toContain("验收回答");
    for (const code of scenario.codes.filter(Boolean)) expect(container.textContent).toContain(code);
    await Promise.all(held.map(item => item.release()));
    expect(modelRequests).toHaveLength(scenario.models);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<App />));
    await waitFor(() => sources.length === 2);
    const snapshot = await sources[1].next();
    expect(snapshot.type).toBe("snapshot");
    expect(snapshot.records).toEqual(history.records);
    expect(container.textContent).toContain(scenario.reason === "error" ? "本轮失败：工具超时，最终结果未确认" : `本轮结束：${scenario.reason}`);
    if (scenario.reason === "completed") expect(container.textContent).toContain("验收回答");
    for (const code of scenario.codes.filter(Boolean)) expect(container.textContent).toContain(code);
    expect(requests).toHaveLength(expectedRequests);
    expect(modelRequests).toHaveLength(scenario.models);
    expect((await (await nativeFetch(origin + path)).json()).records).toEqual(history.records);
    expect(upstream.effects()).toEqual(scenario.effects ?? []);
  } finally {
    await Promise.all(held.map(item => item.release()));
    if (root) await act(async () => root.unmount());
    container?.remove();
    sources.forEach(source => source.close());
    vi.unstubAllGlobals();
    try { await app?.close(); } finally {
      try { await connection?.close(); } finally {
        try { if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); } } finally {
          try { await upstream?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
        }
      }
    }
  }
}, 25000);
