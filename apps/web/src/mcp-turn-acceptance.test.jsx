// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { Client, StreamableHTTPClientTransport } from "../../server/src/test-support/mcp-client.ts";
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
async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
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
  { name: "正常工具续答", continuation: true, calls: [["r", "mock_read", "读取续答"]], reason: "completed", models: 2, codes: [null] },
  { name: "仅后台写入失败", backgroundFailure: true, calls: [], reason: "completed" },
  { name: "首次模型检查点失败", checkpoint: "initial", calls: [], reason: "error" },
  { name: "工具前检查点失败", checkpoint: "dispatch", calls: [["w", "mock_write", "写入"]], reason: "error" },
  { name: "模型续答前检查点失败", checkpoint: "continuation", calls: [["w", "mock_write", "写入"]], reason: "error" },
  { name: "流式断线恢复", reconnectStream: true, calls: [], reason: "completed", models: 1, codes: [] },
  { name: "工具响应丢失", drop: true, calls: [["w", "mock_write", "写入"]], action: "单次允许", hold: "mock_write", reason: "completed", models: 2, codes: ["MCP_TRANSPORT_ERROR"], effects: ["写入"] },
  { name: "审批期间刷新", refreshApproval: true, calls: [["w", "mock_write", "写入"]], action: "单次允许", reason: "completed", models: 2, codes: [null], effects: ["写入"] },
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
  let upstream, proxy, connection, app, root, container, origin, reconnectedAttemptId;
  let releaseStream, releaseCheckpoint, activeSession, checkpointReached = false, lock;
  const checkpointGate = new Promise(resolve => { releaseCheckpoint = resolve; });
  const streamGate = new Promise(resolve => { releaseStream = resolve; });
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
                if (scenario.drop) res.destroy();
                else if (!res.destroyed) {
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
      { name: "mock_write", version: "1", sideEffect: "side-effect", supportsIdempotency: true, approvalPolicy: scenario.checkpoint ? "allow" : "ask", ...(scenario.hold === "mock_write" && !scenario.drop ? { timeoutMs: 1500 } : {}) },
    ]);
    const approvalService = new ApprovalService();
    const scriptedAdapter = createMockAdapter(request => {
      modelRequests.push(structuredClone(request));
      if (modelRequests.length === 1 && scenario.calls.length) return [
        ...(scenario.checkpoint || scenario.continuation ? [{ chunk: { type: "text", delta: "已结算答案" } }] : []),
        ...scenario.calls.map(([id, name, text], index) => ({ chunk: { type: "tool_call", index, callId: id, name, argumentsDelta: JSON.stringify({ text }) } })),
        { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
      ];
      return [{ chunk: { type: "text", delta: "验收回答" } }, { chunk: { type: "finish", reason: { kind: "stop" } } }];
    });
    const adapter = scenario.reconnectStream || scenario.backgroundFailure ? {
      async *generate(request) {
        modelRequests.push(structuredClone(request));
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "验收" };
        await streamGate;
        yield { type: "text-delta", index: 0, text: "回答" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "验收回答" } };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    } : scriptedAdapter;
    const driver = createModelTurnDriver({ approvalService, runtime: new LlmRuntime({ mock: adapter }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: registry });
    const runTurn = scenario.checkpoint || scenario.backgroundFailure ? async context => {
      activeSession = context.session;
      const original = context.session.flush.bind(context.session);
      context.session.flush = async () => {
        const events = context.session.snapshot().events;
        const types = events.map(event => event.type);
        const target = scenario.checkpoint === "initial" ? !types.includes("assistant/message")
          : scenario.checkpoint === "dispatch" ? types.includes("tool/operation") && !types.includes("tool/result")
          : scenario.checkpoint === "continuation" && types.includes("tool/result");
        if (target && !checkpointReached) {
          lock = new DatabaseSync(join(dir, "session.sqlite"));
          lock.exec("BEGIN IMMEDIATE");
          checkpointReached = true;
          await checkpointGate;
        }
        return original();
      };
      try { await driver(context); } finally { context.session.flush = original; }
    } : driver;
    app = await createEventSessionApp(join(dir, "session.sqlite"), false, runTurn, { approvalService });
    origin = await safePort(port => app.listen({ host: "127.0.0.1", port }));
    class NetworkSource {
      constructor(url) {
        this.controller = new AbortController();
        this.queue = [];
        this.delivered = [];
        this.heartbeats = 0;
        this.isDirectory = url.endsWith("/session-directory/events");
        if (!this.isDirectory) sources.push(this);
        void this.read(origin + url);
      }
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
              if (this.isDirectory) {
                if (data) act(() => this.onmessage?.({ data: data.slice(5).trim() }));
                continue;
              }
              if (data) this.queue.push(JSON.parse(data.slice(5).trim()));
              else if (block === ": heartbeat") this.queue.push({ heartbeat: ++this.heartbeats });
            }
          }
        } catch (error) { if (!this.controller.signal.aborted) this.failure = error; }
      }
      close() { this.controller.abort(); }
      async nextItem(timeoutMs = 8000) {
        await waitFor(() => { if (this.failure) throw this.failure; return this.queue.length; }, timeoutMs);
        const frame = this.queue.shift();
        if (frame.heartbeat) return frame;
        this.delivered.push(frame);
        await act(async () => this.onmessage?.({ data: JSON.stringify(frame) })); return frame;
      }
      async next() {
        let frame;
        do { frame = await this.nextItem(); } while (frame.heartbeat);
        return frame;
      }
      async throughHeartbeatAfter(observed) {
        const deadline = Date.now() + 20000;
        for (;;) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error("等待告警后的 SSE 心跳超时");
          const frame = await this.nextItem(remaining);
          if (frame.heartbeat > observed) return;
        }
      }
    }
    vi.stubGlobal("fetch", (url, options) => nativeFetch(String(url).startsWith("/") ? origin + url : url, options));
    vi.stubGlobal("EventSource", NetworkSource);
    const post = (path, body) => nativeFetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const { sessionId } = await (await post("/api/sessions", {})).json();
    const path = `/api/sessions/${sessionId}`;
    localStorage.clear(); localStorage.setItem("mharness.session-directory.v1", JSON.stringify({ sessions: [sessionId], selected: sessionId }));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(<App />)); await waitFor(() => sources.length === 1); const initial = await sources[0].next();
    expect(initial.type).toBe("snapshot");
    if (scenario.continuation) expect(initial).toMatchObject({ sessionId, records: [], cursor: -1, assistantStream: { revision: 0 } });
    if (scenario.continuation) expect(initial.assistantStream.activeAttempt).toBeUndefined();
    const textarea = container.querySelector("textarea");
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(textarea, "开始验收"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    if (scenario.backgroundFailure) {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        let chunk;
        do { chunk = await sources[0].next(); } while (chunk.type !== "assistant-stream" || chunk.frame.type !== "chunk");
        const prefix = (await (await nativeFetch(origin + path)).json()).records;
        lock = new DatabaseSync(join(dir, "session.sqlite"));
        lock.exec("BEGIN IMMEDIATE");
        releaseStream();
        let end;
        do { end = await sources[0].next(); } while (end.event?.type !== "turn/end");
        expect(end.event.data.reason.kind).toBe("completed");
        await waitFor(() => errors.mock.calls.some(args => String(args[0]).includes("会话后台写入失败")));
        // 告警后的心跳确认同一连接已排空此前的业务帧，避免漏掉排队中的错误。
        await sources[0].throughHeartbeatAfter(sources[0].heartbeats);
        const delivered = sources[0].delivered;
        expect(delivered.filter(frame => frame.type === "agent/error" || frame.type === "error")).toHaveLength(0);
        expect(container.textContent).toContain("验收回答");
        expect(container.textContent).toContain("本轮结束：completed");
        expect((await (await nativeFetch(origin + path)).json()).records).toEqual(prefix);
        const live = activeSession.snapshot().events;
        expect(live.slice(0, prefix.length)).toEqual(prefix.map(record => record.event));
        lock.exec("ROLLBACK"); lock.close(); lock = undefined;
        await activeSession.flush();
        const history = (await (await nativeFetch(origin + path)).json()).records;
        expect(history.map(record => record.event)).toEqual(live);
        expect(modelRequests).toHaveLength(1);
      } finally { errors.mockRestore(); }
      return;
    }
    if (scenario.checkpoint) {
      if (scenario.checkpoint !== "initial") {
        let item;
        do { item = await sources[0].next(); } while (item.event?.type !== (scenario.checkpoint === "dispatch" ? "tool/operation" : "tool/result"));
        await waitFor(() => container.textContent.includes("已结算答案"));
      }
      await waitFor(() => checkpointReached);
      const prefix = (await (await nativeFetch(origin + path)).json()).records;
      const beforeFailure = activeSession.snapshot().events;
      if (scenario.checkpoint === "dispatch") {
        const operation = beforeFailure.find(event => event.type === "tool/operation");
        expect(operation).toBeTruthy();
        expect(prefix.some(record => record.event.seq === operation.seq)).toBe(false);
      }
      releaseCheckpoint();
      let item;
      do {
        item = await sources[0].next();
        if (item.type === "agent/error") {
          expect(item.message).toBe("本轮执行失败");
          expect(container.textContent).toContain("本轮执行失败");
          expect(sources).toHaveLength(1);
        }
      } while (item.event?.type !== "turn/end");
      expect(item.event.data.reason.kind).toBe("error");
      expect(item.event.data.reason.error.code).toBe("ERR_SQLITE_ERROR");
      const delivered = sources[0].delivered;
      const errors = delivered.filter(frame => frame.type === "agent/error");
      expect(errors).toHaveLength(1);
      expect(delivered.indexOf(errors[0])).toBeLessThan(delivered.indexOf(item));
      expect(delivered.filter(frame => frame.type === "error")).toHaveLength(0);
      expect(delivered.filter(frame => frame.event?.type === "turn/end")).toHaveLength(1);
      expect(delivered.filter(frame => frame.type === "assistant-stream" && frame.frame.type === "end" && frame.frame.outcome.kind === "abandoned")).toHaveLength(0);
      expect(JSON.stringify(delivered)).not.toMatch(/database is locked|SQLITE_BUSY/i);
      expect(modelRequests).toHaveLength(scenario.checkpoint === "initial" ? 0 : 1);
      expect(requests).toHaveLength(scenario.checkpoint === "continuation" ? 1 : 0);
      expect(upstream.effects()).toEqual(scenario.checkpoint === "continuation" ? ["写入"] : []);
      expect((await (await nativeFetch(origin + path)).json()).records).toEqual(prefix);
      await act(async () => root.unmount());
      root = createRoot(container);
      await act(async () => root.render(<App />));
      await waitFor(() => sources.length === 2);
      const snapshot = await sources[1].next();
      expect(snapshot.type).toBe("snapshot");
      expect(snapshot.records.at(-1).event).toEqual(item.event);
      if (scenario.checkpoint !== "initial") {
        expect(snapshot.records.some(record => record.event.type === "assistant/message")).toBe(true);
        expect(container.textContent).toContain("已结算答案");
      }
      expect(container.textContent).toContain("本轮失败");
      const live = snapshot.records;
      if (scenario.checkpoint === "continuation") {
        const result = live.find(record => record.event.type === "tool/result").event;
        const operation = live.find(record => record.event.type === "tool/operation").event;
        expect(result.data.error).toBeUndefined();
        expect(result.data.operationId).toBe(operation.data.operationId);
        expect(requests[0].arguments.operationId).toBe(operation.data.operationId);
      }
      expect(live.slice(0, prefix.length)).toEqual(prefix);
      lock.exec("ROLLBACK"); lock.close(); lock = undefined;
      await activeSession.flush();
      expect((await (await nativeFetch(origin + path)).json()).records).toEqual(live);
      expect(modelRequests).toHaveLength(scenario.checkpoint === "initial" ? 0 : 1);
      expect(requests).toHaveLength(scenario.checkpoint === "continuation" ? 1 : 0);
      return;
    }
    if (scenario.reconnectStream) {
      let chunk;
      do { chunk = await sources[0].next(); } while (chunk.type !== "assistant-stream" || chunk.frame.type !== "chunk");
      expect(container.textContent).toContain("验收");
      const attemptId = chunk.frame.attemptId;
      reconnectedAttemptId = attemptId;
      sources[0].close();
      await act(async () => sources[0].onerror?.());
      await waitFor(() => sources.length === 2);
      const snapshot = await sources[1].next();
      expect(snapshot.type).toBe("snapshot");
      expect(snapshot.assistantStream.activeAttempt.attemptId).toBe(attemptId);
      expect(snapshot.assistantStream.activeAttempt.nextIndex).toBe(1);
      expect(snapshot.assistantStream.activeAttempt.chunks).toEqual([{ type: "text", delta: "验收" }]);
      expect(container.textContent).toContain("验收");
      releaseStream();
    }
    if (scenario.action) {
      let frame; do { frame = await sources[0].next(); } while (frame.event?.type !== "approval/asked");
      expect(requests).toHaveLength(0); expect(upstream.effects()).toEqual([]);
      if (scenario.refreshApproval) {
        const asked = frame.event;
        const committed = await waitFor(async () => {
          const history = await (await nativeFetch(origin + path)).json();
          return history.records.some(record => record.event.type === "approval/asked") && history;
        });
        expect(committed.records.find(record => record.event.type === "approval/asked").event).toEqual(asked);
        await act(async () => root.unmount());
        root = createRoot(container);
        await act(async () => root.render(<App />));
        await waitFor(() => sources.length === 2);
        const snapshot = await sources[1].next();
        expect(snapshot.type).toBe("snapshot");
        expect(snapshot.records.find(record => record.event.type === "approval/asked").event).toEqual(asked);
        expect(modelRequests).toHaveLength(1);
        expect(requests).toHaveLength(0);
        expect(upstream.effects()).toEqual([]);
      }
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
      if (scenario.drop) await held[0].release();
    }
    if (scenario.continuation) {
      let frame;
      do { frame = await sources[0].next(); } while (frame.type !== "assistant-stream" || frame.frame.type !== "chunk" || frame.frame.chunk.type !== "text");
      const node = container.querySelector("article.assistant");
      const assertA = generating => {
        expect(container.querySelector("article.assistant")).toBe(node);
        expect(container.textContent.split("已结算答案")).toHaveLength(2);
        expect(node.textContent.includes("正在生成")).toBe(generating);
      };
      assertA(true);
      do { frame = await sources[0].next(); } while (frame.event?.type !== "assistant/message" && !(frame.type === "assistant-stream" && frame.frame.type === "end"));
      expect(frame.event?.type).toBe("assistant/message");
      const eventA = frame.event;
      assertA(true);
      do { frame = await sources[0].next(); } while (frame.type !== "assistant-stream" || frame.frame.type !== "end");
      const endA = frame.frame;
      assertA(false);
      do { frame = await sources[0].next(); } while (frame.type !== "assistant-stream" || frame.frame.type !== "start");
      const startB = frame.frame;
      assertA(false);
      do { frame = await sources[0].next(); } while (frame.event?.type !== "turn/end");
      assertA(false);
      expect(container.textContent.split("验收回答")).toHaveLength(2);
      const frames = sources[0].delivered;
      const index = predicate => frames.findIndex(predicate);
      const eventIndex = (type, step) => index(item => item.event?.type === type && (step === undefined || item.event.data.step === step));
      const startAIndex = index(item => item.type === "assistant-stream" && item.frame.type === "start");
      const startA = frames[startAIndex].frame;
      const chunkAIndex = index(item => item.type === "assistant-stream" && item.frame.type === "chunk" && item.frame.attemptId === startA.attemptId && item.frame.chunk.type === "text");
      const endAIndex = index(item => item.type === "assistant-stream" && item.frame.type === "end" && item.frame.attemptId === startA.attemptId);
      const ordered = [eventIndex("turn/start"), eventIndex("step/start", 1), startAIndex, chunkAIndex, eventIndex("assistant/message", 1), endAIndex, eventIndex("tool/call", 1), eventIndex("tool/result", 1), eventIndex("step/end", 1), eventIndex("step/start", 2), index(item => item.type === "assistant-stream" && item.frame.type === "start" && item.frame.attemptId === startB.attemptId)];
      expect(ordered.every(position => position >= 0)).toBe(true);
      expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
      expect(endA).toMatchObject({ attemptId: startA.attemptId, turn: 1, step: 1, outcome: { kind: "committed", eventType: "assistant/message", seq: eventA.seq } });
      expect(startA).toMatchObject({ turn: 1, step: 1 });
      expect(startB).toMatchObject({ turn: 1, step: 2 });
      expect(startB.attemptId).not.toBe(startA.attemptId);
      const stream = frames.filter(item => item.type === "assistant-stream").map(item => item.frame);
      const starts = stream.filter(item => item.type === "start");
      const ends = stream.filter(item => item.type === "end");
      const settlements = frames.filter(item => item.event?.type === "assistant/message").map(item => item.event);
      expect(starts).toEqual([startA, startB]);
      expect(ends).toHaveLength(2);
      expect(settlements).toHaveLength(2);
      for (const [position, start] of starts.entries()) {
        const chunks = stream.filter(item => item.type === "chunk" && item.attemptId === start.attemptId);
        const end = ends[position];
        const settlement = settlements[position];
        expect(chunks.map(item => item.index)).toEqual(chunks.map((_, index) => index));
        expect(end).toMatchObject({ attemptId: start.attemptId, turn: 1, step: position + 1, index: chunks.length, outcome: { kind: "committed", eventType: "assistant/message", seq: settlement.seq } });
        expect(settlement.data).toMatchObject({ turn: 1, step: position + 1, finishReason: { kind: position === 0 ? "tool_calls" : "stop" } });
      }
      expect(settlements[1].data.message.content).toEqual([{ type: "text", text: "验收回答" }]);
      expect(eventA.data).toMatchObject({ turn: 1, step: 1, finishReason: { kind: "tool_calls" } });
      expect(eventA.data.message.content).toEqual(expect.arrayContaining([{ type: "text", text: "已结算答案" }, expect.objectContaining({ type: "tool-call", id: "r", name: "mock_read", arguments: JSON.stringify({ text: "读取续答" }) })]));
      expect(frames.filter(item => item.event?.type === "turn/end")).toHaveLength(1);
      expect(frame.event.data.reason.kind).toBe("completed");
      const history = await waitFor(async () => { const value = await (await nativeFetch(origin + path)).json(); return value.records.length === frames.filter(item => item.type === "event").length && value; });
      expect(frames.filter(item => item.type === "event")).toEqual(history.records);
      const events = history.records.map(item => item.event);
      const call = events.find(event => event.type === "tool/call");
      const operation = events.find(event => event.type === "tool/operation");
      const result = events.find(event => event.type === "tool/result");
      expect(call.data).toMatchObject({ turn: 1, step: 1, callId: "r" });
      expect(result.data).toMatchObject({ turn: 1, step: 1, operationId: operation.data.operationId, message: { source: { callId: "r" } } });
      expect(result.sourceEventSeqs).toEqual([call.seq]);
      expect(JSON.stringify(result.data)).toContain("读取续答");
      expect(modelRequests).toHaveLength(2);
      const messages = modelRequests[1].messages;
      expect(messages.filter(message => message.role === "assistant")).toEqual([expect.objectContaining({ text: "已结算答案", toolCalls: [{ callId: "r", name: "mock_read", arguments: JSON.stringify({ text: "读取续答" }) }] })]);
      expect(messages.filter(message => message.role === "tool")).toEqual([expect.objectContaining({ callId: "r", text: expect.stringContaining("读取续答") })]);
      expect(messages.findIndex(message => message.role === "assistant")).toBeLessThan(messages.findIndex(message => message.role === "tool"));
      expect(requests).toEqual([{ name: "mock_read", arguments: { text: "读取续答", operationId: operation.data.operationId } }]);
      expect(upstream.effects()).toEqual([]);
      return;
    }
    const activeSource = sources[scenario.refreshApproval || scenario.reconnectStream ? 1 : 0];
    let frame; do { frame = await activeSource.next(); } while (frame.event?.type !== "turn/end");
    expect(frame.event.data.reason.kind).toBe(scenario.reason);
    if (scenario.reason === "error") expect(frame.event.data.reason.error.code).toBe("TOOL_TIMEOUT");
    if (scenario.reason === "aborted") expect(frame.event.data.reason.reason).toBe("user");
    const incremental = activeSource.delivered.filter(item => item.type === "event");
    const snapshotPrefix = scenario.refreshApproval || scenario.reconnectStream ? activeSource.delivered.find(item => item.type === "snapshot").records : [];
    const observed = [...snapshotPrefix, ...incremental];
    const history = await waitFor(async () => { const value = await (await nativeFetch(origin + path)).json(); return value.records.length === observed.length && value; });
    expect(observed).toEqual(history.records);
    expect(history.records.map(record => record.event.seq)).toEqual(history.records.map((_, index) => index));
    const events = history.records.map(record => record.event);
    if (scenario.reconnectStream) {
      const stream = activeSource.delivered.filter(frame => frame.type === "assistant-stream").map(frame => frame.frame);
      expect(stream.filter(frame => frame.type === "chunk").map(frame => [frame.attemptId, frame.index, frame.chunk.delta])).toEqual([[reconnectedAttemptId, 1, "回答"]]);
      expect(stream.filter(frame => frame.type === "end").map(frame => [frame.attemptId, frame.outcome.kind])).toEqual([[reconnectedAttemptId, "committed"]]);
      expect(events.filter(event => event.type === "assistant/attempt")).toHaveLength(0);
      expect(events.filter(event => event.type === "turn/end")).toHaveLength(1);
    }
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
      if (!scenario.drop) expect(toolMessages[0].text).toContain(scenario.hold ? "等待工具响应超时" : "写入");
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
    if (scenario.drop) {
      const client = new Client({ name: "acceptance-retry", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(upstream.url)));
      try {
        const retried = await client.callTool(requests[0]);
        expect(retried).toEqual(held[0].envelope.result);
      } finally { await client.close(); }
      expect(upstream.effects()).toEqual(["写入"]);
      expect(requests).toHaveLength(1);
      expect((await (await nativeFetch(origin + path)).json()).records).toEqual(history.records);
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
    const finalSourceIndex = scenario.refreshApproval || scenario.reconnectStream ? 2 : 1;
    await waitFor(() => sources.length === finalSourceIndex + 1);
    const snapshot = await sources[finalSourceIndex].next();
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
    releaseStream(); releaseCheckpoint();
    if (lock) { lock.exec("ROLLBACK"); lock.close(); }
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
}, 35000);
