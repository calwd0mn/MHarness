// @vitest-environment jsdom
import { expect, test } from "vitest";
import { approvalDecisionSchema, approvalDecisionRequestSchema } from "@mharness/session/contracts";

test("浏览器审批契约校验答复和已保存决定", () => {
  expect(approvalDecisionRequestSchema.safeParse({ outcome: "allowed-once" }).success).toBe(true);
  expect(approvalDecisionRequestSchema.safeParse({ outcome: "cancelled" }).success).toBe(false);
  expect(approvalDecisionSchema.safeParse({ id: "a", outcome: "cancelled" }).success).toBe(true);
});
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync, backup } from "node:sqlite";
import { z } from "zod";
import { vi } from "vitest";
import { App } from "./App.tsx";
import { decideApproval } from "./session/approval.ts";
import { createEventSessionApp } from "../../server/src/app.ts";
import { createModelTurnDriver } from "../../server/src/agent/model-turn.ts";
import { createMockAdapter } from "../../server/src/model/providers/mock.ts";
import { LlmRuntime } from "../../server/src/model/runtime.ts";
import { ApprovalService } from "../../server/src/approval/service.ts";
import { defineLocalTool, ToolRegistry } from "../../server/src/tools/registry.ts";
import { defineLocalToolOutput } from "../../server/src/tools/result.ts";

const nativeFetch = globalThis.fetch;
const listen = async (app) => {
  for (let port = 55000; port < 55100; port++) {
    try { return await app.listen({ host: "127.0.0.1", port }); }
    catch (error) { if (error.code !== "EADDRINUSE") throw error; }
  }
  throw new Error("没有可用测试端口");
};
const waitFor = async (check) => {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    let value;
    await act(async () => { value = await check(); await new Promise(resolve => setTimeout(resolve, 15)); });
    if (value) return value;
  }
  throw new Error("等待真实链路状态超时");
};

test("真实 Agent、SQLite、HTTP 和 SSE 驱动审批刷新、决定与恢复", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const dir = await mkdtemp(join(tmpdir(), "mharness-approval-live-"));
  const db = join(dir, "events.sqlite");
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register(defineLocalTool({ name: "change", version: "v2", description: "change", input: z.strictObject({ amount: z.number() }), sideEffect: "side-effect", concludeTurn: true,
    output: defineLocalToolOutput({ schema: z.number(), render: (_, value) => [{ type: "text", text: String(value) }] }), handler: ({ amount }) => { executions++; return amount; } }));
  const approvals = new ApprovalService();
  const driver = createModelTurnDriver({ runtime: new LlmRuntime({ mock: createMockAdapter(() => [
    { chunk: { type: "tool_call", index: 0, callId: "call-1", name: "change", argumentsDelta: '{"amount":42}' } },
    { chunk: { type: "finish", reason: { kind: "tool_calls" } } },
  ]) }), config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "", toolRegistry: registry, approvalService: approvals });
  const app = await createEventSessionApp(db, false, driver, { approvalService: approvals });
  let root, container, recovered;
  const sources = [];
  try {
    const origin = await listen(app);
    let activeOrigin = origin;
    const post = (path, body) => nativeFetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await post("/api/sessions", {});
    const { sessionId } = await created.json();
    const path = `/api/sessions/${sessionId}`;
    const replies = [];
    vi.stubGlobal("fetch", async (url, options) => {
      const response = await nativeFetch(origin + url, options);
      if (String(url).endsWith("/decision")) replies.push({ status: response.status, body: await response.clone().json() });
      return response;
    });
    class NetworkEventSource {
      constructor(url) {
        this.controller = new AbortController(); sources.push(this);
        void this.open(activeOrigin + url);
      }
      async open(url) {
        try {
          const response = await nativeFetch(url, { signal: this.controller.signal });
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let pending = "";
          while (!this.controller.signal.aborted) {
            const { value, done } = await reader.read(); if (done) break;
            pending += value;
            let split;
            while ((split = pending.indexOf("\n\n")) >= 0) {
              const frame = pending.slice(0, split); pending = pending.slice(split + 2);
              if (frame.startsWith("data: ")) this.onmessage?.({ data: frame.slice(6) });
            }
          }
        } catch (error) { if (!this.controller.signal.aborted) this.onerror?.(error); }
      }
      close() { this.controller.abort(); }
    }
    vi.stubGlobal("EventSource", NetworkEventSource);
    localStorage.clear();
    localStorage.setItem("mharness.session-directory.v1", JSON.stringify({ sessions: [sessionId], selected: sessionId }));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(<App />));
    await waitFor(() => container.textContent.includes("已连接"));
    expect((await post(path + "/messages", { requestId: "r1", content: [{ type: "text", text: "执行" }] })).status).toBe(202);
    await waitFor(() => container.textContent.includes("等待审批"));
    expect(executions).toBe(0);
    const history = await waitFor(async () => {
      const data = await (await nativeFetch(origin + path)).json();
      return data.records.some(record => record.event.type === "approval/asked") && data;
    });
    const operation = history.records.find(record => record.event.type === "tool/operation").event.data;
    const asked = history.records.find(record => record.event.type === "approval/asked").event.data;
    expect(asked.operationId).toBe(operation.operationId);
    expect(asked.id).toBeTruthy();
    expect(operation).toMatchObject({ toolName: "change", toolVersion: "v2", validatedArgs: { amount: 42 } });
    expect(container.textContent).toContain("change"); expect(container.textContent).toContain("v2"); expect(container.textContent).toContain('"amount": 42');

    const source = new DatabaseSync(db, { readOnly: true });
    try { await backup(source, join(dir, "recovery.sqlite")); } finally { source.close(); }
    await act(async () => root.unmount()); root = createRoot(container);
    await act(async () => root.render(<App />));
    await waitFor(() => container.textContent.includes("等待审批"));
    expect(container.textContent).toContain('"amount": 42');
    const decisionPath = `${path}/approvals/${asked.id}/decision`;
    const allow = [...container.querySelectorAll("button")].find(button => button.textContent === "单次允许");
    await act(async () => allow.click());
    await waitFor(() => replies.length === 1);
    expect(replies[0]).toEqual({ status: 200, body: { id: asked.id, outcome: "allowed-once" } });
    await waitFor(() => executions === 1 && container.textContent.includes("已允许"));
    const duplicate = await post(decisionPath, { outcome: "allowed-once" });
    expect(duplicate.status).toBe(200); expect(await duplicate.json()).toEqual({ id: asked.id, outcome: "allowed-once" });
    const conflict = await post(decisionPath, { outcome: "rejected" });
    expect(conflict.status).toBe(409); expect(await conflict.json()).toEqual({ id: asked.id, outcome: "allowed-once" });
    expect(await decideApproval(sessionId, asked.id, "rejected")).toEqual({ kind: "decided", outcome: "allowed-once" });
    expect(await decideApproval(sessionId, "missing", "allowed-once")).toEqual({ kind: "missing" });
    await waitFor(() => container.textContent.includes("成功"));
    expect(container.querySelector('[aria-label="审批详情"] button')).toBeNull();
    expect(executions).toBe(1);

    const secondCreated = await post("/api/sessions", {});
    const secondId = (await secondCreated.json()).sessionId;
    const secondPath = `/api/sessions/${secondId}`;
    localStorage.setItem("mharness.session-directory.v1", JSON.stringify({ sessions: [secondId], selected: secondId }));
    await act(async () => root.unmount()); root = createRoot(container);
    await act(async () => root.render(<App />));
    await waitFor(() => container.textContent.includes("已连接"));
    expect((await post(secondPath + "/messages", { requestId: "r2", content: [{ type: "text", text: "拒绝" }] })).status).toBe(202);
    await waitFor(() => container.textContent.includes("等待审批"));
    const reject = [...container.querySelectorAll("button")].find(button => button.textContent === "拒绝");
    await act(async () => reject.click());
    await waitFor(() => container.textContent.includes("已拒绝"));
    const rejectedHistory = await waitFor(async () => {
      const data = await (await nativeFetch(origin + secondPath)).json();
      return data.records.some(record => record.event.type === "turn/end") && data;
    });
    expect(rejectedHistory.records.find(record => record.event.type === "approval/decided").event.data.outcome).toBe("rejected");
    expect(rejectedHistory.records.find(record => record.event.type === "tool/result").event.data.error.code).toBe("APPROVAL_REJECTED");
    expect(executions).toBe(1);
    localStorage.setItem("mharness.session-directory.v1", JSON.stringify({ sessions: [sessionId], selected: sessionId }));
    recovered = await createEventSessionApp(join(dir, "recovery.sqlite"));
    const recoveryOrigin = await listen(recovered);
    const stale = await nativeFetch(recoveryOrigin + decisionPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outcome: "allowed-once" }) });
    expect(stale.status).toBe(409); expect(await stale.json()).toEqual({ code: "approval_not_active" });
    activeOrigin = recoveryOrigin;
    vi.stubGlobal("fetch", (url, options) => nativeFetch(activeOrigin + url, options));
    expect(await decideApproval(sessionId, asked.id, "allowed-once")).toEqual({ kind: "inactive" });
    await act(async () => root.unmount()); root = createRoot(container);
    await act(async () => root.render(<App />));
    await waitFor(() => container.textContent.includes("审批已失效"));
    expect(container.querySelector('[aria-label="审批详情"] button')).toBeNull();
    expect(executions).toBe(1);
  } finally {
    if (root) await act(async () => root.unmount());
    container?.remove(); sources.forEach(source => source.close());
    await recovered?.close(); await app.close(); await rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  }
}, 20000);
