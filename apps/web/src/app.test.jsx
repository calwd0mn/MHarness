import { useApprovals } from "./session/use-approvals.ts";
import { Approval as ApprovalView } from "./features/conversation/Approval.tsx";
// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";

function Approval({ approval, enabled, decision, closed }) {
  const approvals = useApprovals();
  return <ApprovalView approval={approval} enabled={enabled} decision={decision} closed={closed} request={approvals.get("a", approval.id, approval.operationId)} onSubmit={(outcome) => void approvals.submit("a", approval.id, approval.operationId, outcome)} />;
}

const connections = [];
class Source {
  constructor(url) { this.url = url; this.closed = false; connections.push(this); }
  close() { this.closed = true; }
  frame(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}
const snapshot = (id, records = [], assistantStream = { revision: 0 }) => ({ type: "snapshot", sessionId: id, inheritedEventCount: 0, cursor: records.length - 1, records, assistantStream });
let root;
let container;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const sendFrame = async (connection, frame) => { await act(async () => { connection.frame(frame); }); await flush(); };
const click = async (button) => { await act(async () => { button.click(); }); await flush(); };
const button = (text) => [...container.querySelectorAll("button")].find(item => item.textContent.includes(text));
const enter = async (value) => { const textarea = container.querySelector("textarea"); await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(textarea, value); textarea.dispatchEvent(new Event("input", { bubbles: true })); }); };
const submit = async () => { await act(async () => { container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); await flush(); };

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  connections.length = 0;
  localStorage.clear();
  localStorage.setItem("mharness.session-directory.v1", JSON.stringify({ sessions: ["a", "b"], selected: "a" }));
  vi.stubGlobal("EventSource", Source);
  vi.stubGlobal("fetch", vi.fn());
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<App />); });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

test("首屏和切换只订阅选中会话，旧回调不能覆盖当前画面", async () => {
  expect(connections.map(item => item.url)).toEqual(["/api/sessions/a/follow"]);
  await click(button("会话 2"));
  expect(connections[0].closed).toBe(true);
  expect(connections.map(item => item.url)).toEqual(["/api/sessions/a/follow", "/api/sessions/b/follow"]);
  await sendFrame(connections[0], snapshot("a"));
  await sendFrame(connections[1], snapshot("b"));
  expect(container.textContent).toContain("已连接");
  expect(fetch).not.toHaveBeenCalled();
});

test("网络结果未知时相同正文沿用编号，改文使用新编号", async () => {
  await sendFrame(connections[0], snapshot("a"));
  fetch.mockRejectedValue(new Error("lost"));
  await enter("你好"); await submit();
  expect(container.textContent).toContain("发送结果未知");
  const first = JSON.parse(fetch.mock.calls[0][1].body).requestId;
  await click(button("重试此消息")); await submit();
  expect(JSON.parse(fetch.mock.calls[1][1].body).requestId).toBe(first);
  await enter("修改"); await submit();
  expect(JSON.parse(fetch.mock.calls[2][1].body).requestId).not.toBe(first);
});

const record = (seq, type, data, extra = {}) => ({ type: "event", event: { seq, time: seq + 1, type, data, ...extra } });
const userRecord = (requestId) => record(0, "user/message", { id: "u", role: "user", source: { kind: "user" }, turn: 1, requestId, content: [{ type: "text", text: "你好" }] }, { surfaceOp: "append" });
const ok = () => ({ ok: true, json: async () => ({ accepted: true }) });
for (const eventFirst of [true, false]) test(`受理${eventFirst ? "事件" : "HTTP"}先到只显示一条用户消息`, async () => {
  await sendFrame(connections[0], snapshot("a"));
  let resolve;
  fetch.mockImplementation(() => new Promise(r => { resolve = r; }));
  await enter("你好"); await submit();
  const id = JSON.parse(fetch.mock.calls[0][1].body).requestId;
  if (eventFirst) {
    await sendFrame(connections[0], userRecord(id));
    const users = [...container.querySelectorAll("article.user")];
    expect(users).toHaveLength(1);
    expect(users[0].textContent).toBe("你你好");
  }
  await act(async () => { resolve(ok()); }); await flush();
  const afterResponse = [...container.querySelectorAll("article.user")];
  expect(afterResponse).toHaveLength(1);
  expect(afterResponse[0].textContent).toBe(eventFirst ? "你你好" : "你你好已受理，等待同步");
  if (!eventFirst) await sendFrame(connections[0], userRecord(id));
  const finalUsers = [...container.querySelectorAll("article.user")];
  expect(finalUsers).toHaveLength(1);
  expect(finalUsers[0].textContent).toBe("你你好");
});

test("忙碌保留正文，取消通过当前会话接口发出", async () => {
  await sendFrame(connections[0], snapshot("a"));
  fetch.mockResolvedValueOnce({ status: 409, ok: false }).mockResolvedValueOnce({ ok: true });
  await enter("你好"); await submit();
  expect(container.textContent).toContain("未受理");
  expect(container.querySelector("textarea").value).toBe("你好");
  await click(button("取消任务"));
  expect(fetch.mock.calls[1][0]).toBe("/api/sessions/a/cancel");
  expect(container.textContent).toContain("已请求取消");
});

test("执行错误不重连，失败终态可仅凭快照恢复", async () => {
  await sendFrame(connections[0], snapshot("a"));
  await sendFrame(connections[0], { type: "agent/error", turn: 1, message: "模型失败" });
  expect(container.textContent).toContain("执行错误：模型失败");
  const records = [record(0, "turn/start", { turn: 1 }), record(1, "turn/end", { turn: 1, reason: { kind: "error", error: { code: "UNKNOWN", message: "模型失败" } } })];
  await sendFrame(connections[0], records[0]); await sendFrame(connections[0], records[1]);
  expect(container.textContent).toContain("本轮失败：模型失败");
  expect(connections).toHaveLength(1);
  await click(button("会话 2")); await sendFrame(connections[1], snapshot("b"));
  await click(button("会话 1")); await sendFrame(connections[2], snapshot("a", records));
  expect(container.textContent).toContain("本轮失败：模型失败");
  expect(connections).toHaveLength(3);
});

test("切走后切回恢复增长的草稿并结算为唯一回答", async () => {
  const records = [record(0, "turn/start", { turn: 1 }), record(1, "step/start", { turn: 1, step: 1 })];
  const stream = (text, revision = 1) => ({ revision, activeAttempt: { attemptId: "draft", turn: 1, step: 1, chunks: [{ type: "text", delta: text }], nextIndex: 1 } });
  await sendFrame(connections[0], snapshot("a", records, stream("部分")));
  expect(container.textContent).toContain("部分");
  await click(button("会话 2")); await sendFrame(connections[1], snapshot("b"));
  await click(button("会话 1")); await sendFrame(connections[2], snapshot("a", records, stream("部分增长")));
  expect(container.textContent).toContain("部分增长");
  const draftNode = container.querySelector("article.assistant");
  await sendFrame(connections[2], { type: "assistant-stream", frame: { type: "chunk", attemptId: "draft", revision: 2, index: 1, chunk: { type: "text", delta: "完成" } } });
  expect(container.textContent).toContain("部分增长完成");
  const final = record(2, "assistant/message", { turn: 1, step: 1, message: { id: "m", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "text", text: "部分增长完成" }] }, finishReason: { kind: "stop" }, stream: [], includeInModelContext: true }, { surfaceOp: "append" });
  await sendFrame(connections[2], { type: "assistant-stream", frame: { type: "end", attemptId: "draft", revision: 3, turn: 1, step: 1, index: 2, outcome: { kind: "committed", eventType: "assistant/message", seq: 2 } } });
  await sendFrame(connections[2], final);
  expect([...container.querySelectorAll("article.assistant")].map(node => node.textContent)).toEqual([expect.stringContaining("部分增长完成")]);
  expect(container.querySelector("article.assistant")).toBe(draftNode);
});


for (const eventFirst of [false, true]) test(`工具续答交接：${eventFirst ? "结算事件" : "结束帧"}先到时保留草稿节点`, async () => {
  const records = [record(0, "turn/start", { turn: 1 }), record(1, "step/start", { turn: 1, step: 1 })];
  const stream = { revision: 1, activeAttempt: { attemptId: "draft", turn: 1, step: 1, chunks: [{ type: "text", delta: "交接正文" }], nextIndex: 1 } };
  await sendFrame(connections[0], snapshot("a", records, stream));
  const node = container.querySelector("article.assistant");
  const assertDraft = () => {
    expect(container.querySelectorAll("article.assistant")).toHaveLength(1);
    expect(container.querySelector("article.assistant")).toBe(node);
    expect(node.textContent.split("交接正文")).toHaveLength(2);
    expect(node.textContent).toContain("正在生成");
  };
  assertDraft();
  const end = { type: "assistant-stream", frame: { type: "end", attemptId: "draft", revision: 2, turn: 1, step: 1, index: 1, outcome: { kind: "committed", eventType: "assistant/message", seq: 2 } } };
  const message = record(2, "assistant/message", { turn: 1, step: 1, message: { id: "m", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "text", text: "交接正文" }, { type: "tool-call", id: "x", name: "mock_read", arguments: '{}' }] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true }, { surfaceOp: "append" });
  const frames = eventFirst ? [message, end] : [end, message];
  await sendFrame(connections[0], frames[0]);
  assertDraft();
  await sendFrame(connections[0], frames[1]);
  expect(container.querySelectorAll("article.assistant")).toHaveLength(1);
  expect(container.querySelector("article.assistant")).toBe(node);
  expect(node.textContent.split("交接正文")).toHaveLength(2);
  expect(node.textContent).not.toContain("正在生成");
  await sendFrame(connections[0], record(3, "tool/call", { turn: 1, step: 1, callId: "x", name: "mock_read", arguments: '{}' }));
  await sendFrame(connections[0], record(4, "tool/operation", { turn: 1, step: 1, callId: "x", operationId: "op", toolName: "mock_read", toolVersion: "1", validatedArgs: {} }));
  await sendFrame(connections[0], record(5, "tool/result", { turn: 1, step: 1, operationId: "op", message: { id: "r", role: "user", source: { kind: "tool", callId: "x" }, content: [{ type: "tool-result", toolCallId: "x", isError: false, content: [{ type: "text", text: "读取结果" }] }] } }, { surfaceOp: "append", sourceEventSeqs: [3] }));
  await sendFrame(connections[0], record(6, "step/end", { turn: 1, step: 1 }));
  await sendFrame(connections[0], record(7, "step/start", { turn: 1, step: 2 }));
  await sendFrame(connections[0], { type: "assistant-stream", frame: { type: "start", attemptId: "next", revision: 3, turn: 1, step: 2 } });
  await sendFrame(connections[0], { type: "assistant-stream", frame: { type: "chunk", attemptId: "next", revision: 4, index: 0, chunk: { type: "text", delta: "后续正文" } } });
  expect(container.textContent).toContain("后续正文");
  expect(container.querySelector("article.assistant")).toBe(node);
  expect(container.textContent.split("交接正文")).toHaveLength(2);
  expect(connections).toHaveLength(1);
  expect(connections[0].closed).toBe(false);
});


test("断线等待期间保留画面，重连只安装新 follow 快照", async () => {
  await sendFrame(connections[0], snapshot("a", [userRecord("old")]));
  await act(async () => { connections[0].onerror(); });
  expect(container.textContent).toContain("正在同步");
  expect(container.textContent).toContain("你好");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
  expect(connections).toHaveLength(2);
  await sendFrame(connections[1], snapshot("a"));
  expect(container.textContent).not.toContain("你好");
  expect(container.textContent).toContain("已连接");
  expect(fetch).not.toHaveBeenCalled();
});

test("消息事件确认后即使响应丢失仍保持受理，再发相同正文使用新编号", async () => {
  await sendFrame(connections[0], snapshot("a"));
  let reject;
  fetch.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockResolvedValueOnce(ok());
  await enter("你好"); await submit();
  const first = JSON.parse(fetch.mock.calls[0][1].body).requestId;
  await sendFrame(connections[0], userRecord(first));
  await act(async () => { reject(new Error("lost")); }); await flush();
  expect(container.textContent).not.toContain("发送结果未知");
  expect(container.querySelectorAll("article.user")).toHaveLength(1);
  await enter("你好"); await submit();
  expect(JSON.parse(fetch.mock.calls[1][1].body).requestId).not.toBe(first);
});

test("终止错误保留已显示内容并等待主动重试", async () => {
  await sendFrame(connections[0], snapshot("a", [userRecord("old")]));
  await sendFrame(connections[0], { type: "error", error: { code: "follow_sync_failed", message: "同步故障", details: {} } });
  expect(container.textContent).toContain("你好");
  expect(container.textContent).toContain("同步故障");
  await act(async () => { connections[0].onerror(); await new Promise(resolve => setTimeout(resolve, 300)); });
  expect(connections).toHaveLength(1);
  await click(button("重新同步"));
  expect(connections).toHaveLength(2);
  await sendFrame(connections[1], snapshot("a"));
  expect(container.textContent).not.toContain("你好");
});

test("继承的同编号消息不能确认子会话的新提交", async () => {
  vi.spyOn(crypto, "randomUUID").mockReturnValue("same");
  const inherited = userRecord("same");
  await sendFrame(connections[0], { ...snapshot("a", [inherited]), inheritedEventCount: 1 });
  fetch.mockImplementation(() => new Promise(() => {}));
  await enter("你好"); await submit();
  expect(container.textContent).toContain("正在发送");
  const own = userRecord("same"); own.event.seq = 1; own.event.data.id = "u2";
  await sendFrame(connections[0], own);
  expect(container.textContent).not.toContain("正在发送");
  expect(container.querySelectorAll("article.user")).toHaveLength(2);
  vi.restoreAllMocks();
});

test("通用按钮在忙碌时禁用并提供文字反馈", async () => {
  const { Button } = await import("./components/ui/Button.tsx");
  await act(async () => root.render(<Button busy>保存</Button>));
  const control = container.querySelector("button");
  expect(control.disabled).toBe(true);
  expect(control.getAttribute("aria-busy")).toBe("true");
  expect(control.textContent).toContain("处理中");
});

test("切换会话时分别保留编辑草稿和输入焦点节点", async () => {
  await sendFrame(connections[0], snapshot("a"));
  const input = container.querySelector("textarea");
  input.focus();
  await enter("甲草稿");
  await click(button("会话 2"));
  await sendFrame(connections[1], snapshot("b"));
  expect(container.querySelector("textarea")).toBe(input);
  expect(input.value).toBe("");
  await enter("乙草稿");
  await click(button("会话 1"));
  await sendFrame(connections[2], snapshot("a"));
  expect(input.value).toBe("甲草稿");
  await click(button("会话 2"));
  expect(input.value).toBe("乙草稿");
});

test("发送保留原文空白，迟到忙碌响应不覆盖新草稿", async () => {
  await sendFrame(connections[0], snapshot("a"));
  let resolve;
  fetch.mockImplementation(() => new Promise(r => { resolve = r; }));
  await enter("  原文\n"); await submit();
  expect(JSON.parse(fetch.mock.calls[0][1].body).content[0].text).toBe("  原文\n");
  await enter("新草稿");
  await click(button("会话 2"));
  await act(async () => resolve({ status: 409, ok: false })); await flush();
  await click(button("会话 1"));
  expect(container.querySelector("textarea").value).toBe("新草稿");
});

test("助手 Markdown 安全显示链接、代码并可复制", async () => {
  const { AssistantMarkdown } = await import("./features/conversation/AssistantMarkdown.tsx");
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await act(async () => root.render(<AssistantMarkdown text={'# 标题\n\n<script>alert(1)</script>\n\n[危险](javascript:alert(1)) [安全](https://example.com)\n\n```js\nconst x = 1;\n```'} />));
  expect(container.querySelector("h1").textContent).toBe("标题");
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(container.querySelector('a[href="https://example.com"]')).not.toBeNull();
  await click(button("复制"));
  expect(writeText).toHaveBeenCalledWith("const x = 1;\n");
  expect(container.textContent).toContain("已复制");
});


test("流式推理独立折叠，未闭合代码块可读且复制失败可见", async () => {
  const records = [record(0, "turn/start", { turn: 1 }), record(1, "step/start", { turn: 1, step: 1 })];
  const stream = { revision: 1, activeAttempt: { attemptId: "draft", turn: 1, step: 1, chunks: [{ type: "reasoning", delta: "思考内容" }, { type: "text", delta: "```js\n未完成" }], nextIndex: 2 } };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  await sendFrame(connections[0], snapshot("a", records, stream));
  expect(container.querySelector("details summary").textContent).toContain("推理");
  expect(container.querySelector("details").textContent).toContain("思考内容");
  expect(container.querySelector("pre").textContent).toContain("未完成");
  await click(button("复制"));
  expect(container.textContent).toContain("复制失败");
});

test("阅读位置按会话保存，主动上滚后可返回最新", async () => {
  await sendFrame(connections[0], snapshot("a", [userRecord("a")]));
  const area = container.querySelector(".messages");
  Object.defineProperties(area, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
  await act(async () => { area.scrollTop = 100; area.dispatchEvent(new Event("scroll")); });
  expect(button("返回最新")).toBeTruthy();
  await click(button("会话 2")); await sendFrame(connections[1], snapshot("b"));
  await click(button("会话 1")); await sendFrame(connections[2], snapshot("a", [userRecord("a")]));
  expect(area.scrollTop).toBe(100);
  await click(button("返回最新"));
  expect(area.scrollTop).toBe(1000);
  expect(button("返回最新")).toBeFalsy();
});

test("工具投影按 Step 区分复用的调用、审批和结果", async () => {
  const { projectTools } = await import("./session/tools.ts");
  const result = (seq, step, operationId, text, callSeq) => record(seq, "tool/result", { turn: 1, step, operationId, message: { id: `r${step}`, role: "user", source: { kind: "tool", callId: "x" }, content: [{ type: "tool-result", toolCallId: "x", isError: false, content: [{ type: "text", text }] }] } }, { surfaceOp: "append", sourceEventSeqs: [callSeq] });
  const events = [
    record(0, "turn/start", { turn: 1 }), record(1, "step/start", { turn: 1, step: 1 }),
    record(2, "tool/call", { turn: 1, step: 1, callId: "x", name: "one", arguments: '{"raw":1}' }),
    record(3, "tool/operation", { turn: 1, step: 1, callId: "x", operationId: "op1", toolName: "one", toolVersion: "1", validatedArgs: { value: 1 } }),
    record(4, "approval/asked", { id: "p1", operationId: "op1", toolName: "one", reason: "原因一" }),
    record(5, "approval/decided", { id: "p1", outcome: "allowed-once" }), result(6, 1, "op1", "结果一", 2),
    record(7, "step/end", { turn: 1, step: 1 }), record(8, "step/start", { turn: 1, step: 2 }),
    record(9, "tool/call", { turn: 1, step: 2, callId: "x", name: "two", arguments: '{"raw":2}' }),
    record(10, "tool/operation", { turn: 1, step: 2, callId: "x", operationId: "op2", toolName: "two", toolVersion: "2", validatedArgs: { value: 2 } }),
    record(11, "approval/asked", { id: "p2", operationId: "op2", toolName: "two", reason: "原因二" }),
    record(12, "approval/decided", { id: "p2", outcome: "allowed-once" }), result(13, 2, "op2", "结果二", 9),
  ];
  events[6].event.data.meta = { extra: "保留" };
  const initial = projectTools(events.slice(0, 10));
  expect(initial[1]).toMatchObject({ status: "准备调用", rawArguments: '{"raw":2}' });
  const pending = projectTools(events.slice(0, 12));
  expect(pending).toHaveLength(2);
  expect(pending[0]).toMatchObject({ step: 1, rawArguments: '{"raw":1}', operationId: "op1", version: "1", validatedArgs: { value: 1 }, approval: { id: "p1", operationId: "op1" }, decision: "allowed-once", status: "成功", result: { operationId: "op1" } });
  expect(JSON.stringify(pending[0].result)).toContain("结果一");
  expect(pending[0].result.meta).toEqual({ extra: "保留" });
  expect(pending[1]).toMatchObject({ step: 2, rawArguments: '{"raw":2}', operationId: "op2", version: "2", validatedArgs: { value: 2 }, approval: { id: "p2", operationId: "op2" }, status: "等待审批" });
  expect(pending[1].decision).toBeUndefined(); expect(pending[1].result).toBeUndefined();
  const tools = projectTools(events);
  expect(tools[0]).toEqual(pending[0]);
  expect(tools[1]).toMatchObject({ step: 2, rawArguments: '{"raw":2}', operationId: "op2", version: "2", validatedArgs: { value: 2 }, approval: { id: "p2", operationId: "op2" }, decision: "allowed-once", status: "成功", result: { operationId: "op2" } });
  expect(JSON.stringify(tools[1].result)).toContain("结果二");
  expect(events[6].event.sourceEventSeqs).toEqual([events[2].event.seq]);
  expect(events[13].event.sourceEventSeqs).toEqual([events[9].event.seq]);
});

test("切回会话时等快照内容安装后恢复被空画面夹取的位置", async () => {
  await sendFrame(connections[0], snapshot("a", [userRecord("a")]));
  const area = container.querySelector(".messages");
  let top = 0;
  Object.defineProperties(area, { scrollHeight: { configurable: true, get: () => container.querySelector("article.user") ? 1000 : 200 }, clientHeight: { configurable: true, value: 200 }, scrollTop: { configurable: true, get: () => top, set: value => { top = Math.max(0, Math.min(value, area.scrollHeight - area.clientHeight)); } } });
  await act(async () => { area.scrollTop = 100; area.dispatchEvent(new Event("scroll")); });
  await click(button("会话 2")); await sendFrame(connections[1], snapshot("b"));
  await click(button("会话 1"));
  expect(area.scrollTop).toBe(0);
  await sendFrame(connections[2], snapshot("a", [userRecord("a")]));
  expect(area.scrollTop).toBe(100);
});

test("工具声明不提前建卡，替换结果不改历史原始结果", async () => {
  const { projectTools } = await import("./session/tools.ts");
  const declaration = record(0, "assistant/message", { turn: 1, step: 1, message: { id: "m", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "tool-call", id: "x", name: "工具", arguments: "{}" }] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true }, { surfaceOp: "append" });
  const call = record(1, "tool/call", { turn: 1, step: 1, callId: "x", name: "工具", arguments: "{}" });
  const result = (seq, text, surfaceOp) => record(seq, "tool/result", { turn: 1, step: 1, message: { id: "r", role: "user", source: { kind: "tool", callId: "x" }, content: [{ type: "tool-result", toolCallId: "x", isError: false, content: [{ type: "text", text }] }] } }, { surfaceOp, sourceEventSeqs: [1] });
  expect(projectTools([declaration])).toHaveLength(0);
  expect(JSON.stringify(projectTools([declaration, call, result(2, "原始结果", "append"), result(3, "摘要", { op: "replace", start: 2, end: 2 })]))).toContain("原始结果");
});

test("工具卡片在消息之间按原始事件顺序展示", async () => {
  const first = userRecord("first");
  const call = record(1, "tool/call", { turn: 1, step: 1, callId: "x", name: "查找", arguments: "{}" });
  const second = userRecord("second"); second.event.seq = 2; second.event.data.id = "u2"; second.event.data.content[0].text = "第二条";
  await sendFrame(connections[0], snapshot("a", [first, call, second]));
  const content = container.querySelector(".messages").textContent;
  expect(content.indexOf("你好")).toBeLessThan(content.indexOf("查找"));
  expect(content.indexOf("查找")).toBeLessThan(content.indexOf("第二条"));
});

test("审批点击与键盘共用请求锁，冲突按服务端决定收敛", async () => {
  let resolve;
  fetch.mockImplementation(() => new Promise(r => { resolve = r; }));
  const approval = { id: "p", operationId: "op", toolName: "工具", reason: "需要许可" };
  await act(async () => root.render(<Approval approval={approval} enabled />));
  const detail = container.querySelector('[tabindex="0"]');
  await act(async () => { button("单次允许").click(); detail.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ outcome: "allowed-once" });
  await act(async () => resolve({ status: 409, ok: false, json: async () => ({ id: "p", outcome: "rejected" }) })); await flush();
  expect(container.textContent).toContain("已拒绝");
});

test("视口尺寸变化时仅跟随模式滚到底部", async () => {
  let resize;
  class Observer { constructor(callback) { resize = callback; } observe() {} disconnect() {} }
  vi.stubGlobal("ResizeObserver", Observer);
  await sendFrame(connections[0], snapshot("a", [userRecord("a")]));
  const area = container.querySelector(".messages");
  let height = 1000;
  Object.defineProperties(area, { scrollHeight: { configurable: true, get: () => height }, clientHeight: { configurable: true, value: 200 } });
  await act(async () => { height = 1400; resize(); });
  expect(area.scrollTop).toBe(1400);
  await act(async () => { area.scrollTop = 100; area.dispatchEvent(new Event("scroll")); height = 1600; resize(); });
  expect(area.scrollTop).toBe(100);
});

for (const [status, body, expected] of [[200, { id: "p", outcome: "allowed-once" }, "已允许"], [409, { code: "approval_not_active" }, "审批已失效"], [404, {}, "审批不存在"]]) test(`审批 HTTP ${status} 按权威响应结束交互`, async () => {
  fetch.mockResolvedValue({ status, ok: status === 200, json: async () => body });
  await act(async () => root.render(<Approval approval={{ id: "p", operationId: "op", toolName: "工具", reason: "原因" }} enabled />));
  await click(button("单次允许"));
  expect(container.textContent).toContain(expected);
  expect(button("单次允许")).toBeFalsy();
});

test("审批网络未知仅允许重试原决定，事件确认不会被迟到响应覆盖", async () => {
  const approval = { id: "p", operationId: "op", toolName: "工具", reason: "原因" };
  fetch.mockRejectedValueOnce(new Error("lost"));
  await act(async () => root.render(<Approval approval={approval} enabled />));
  await click(button("单次允许"));
  expect(container.textContent).toContain("结果未知");
  expect(button("拒绝").disabled).toBe(true);
  let resolve;
  fetch.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await click(button("单次允许"));
  await act(async () => root.render(<Approval approval={approval} enabled decision="rejected" />));
  await act(async () => resolve({ status: 200, ok: true, json: async () => ({ id: "p", outcome: "allowed-once" }) })); await flush();
  expect(container.textContent).toContain("已拒绝");
  expect(container.textContent).not.toContain("已允许");
});

test("审批快捷键不抢原生按钮、输入与输入法", async () => {
  await act(async () => root.render(<Approval approval={{ id: "p", operationId: "op", toolName: "工具", reason: "原因" }} enabled />));
  const detail = container.querySelector('[tabindex="0"]');
  await act(async () => { button("拒绝").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); detail.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true })); });
  expect(fetch).not.toHaveBeenCalled();
});

test("输入更新时助手代码节点与复制反馈保持稳定", async () => {
  const assistant = record(0, "assistant/message", { turn: 1, step: 1, message: { id: "m", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "text", text: "```js\n内容\n```" }] }, finishReason: { kind: "stop" }, stream: [], includeInModelContext: true }, { surfaceOp: "append" });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  await sendFrame(connections[0], snapshot("a", [assistant]));
  const code = container.querySelector("pre");
  await click(button("复制"));
  await enter("新输入");
  expect(container.querySelector("pre")).toBe(code);
  expect(container.textContent).toContain("已复制");
});

test("会话导航可折叠并用可访问状态说明当前展开情况", async () => {
  const toggle = button("收起会话导航");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await click(toggle);
  expect(button("展开会话导航").getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector('nav[aria-label="会话"]')).toBeNull();
  await click(button("展开会话导航"));
  expect(container.querySelector('nav[aria-label="会话"]')).not.toBeNull();
});

for (const outcome of ["cancelled", "unavailable"]) test(`审批冲突已有 ${outcome} 时结束交互`, async () => {
  fetch.mockResolvedValue({ status: 409, ok: false, json: async () => ({ id: "p", outcome }) });
  await act(async () => root.render(<Approval approval={{ id: "p", operationId: "op", toolName: "工具", reason: "原因" }} enabled />));
  await click(button("单次允许"));
  expect(container.textContent).toContain("审批已结束");
  expect(button("单次允许")).toBeFalsy();
});

test("真实 App 使用事件与 HTTP 替身联动审批，切换后旧回调不能污染新会话", async () => {
  const events = [record(0, "turn/start", { turn: 1 }), record(1, "step/start", { turn: 1, step: 1 }),
    record(2, "tool/call", { turn: 1, step: 1, callId: "x", name: "示例工具", arguments: "{}" }),
    record(3, "tool/operation", { turn: 1, step: 1, callId: "x", operationId: "op", toolName: "示例工具", toolVersion: "1", validatedArgs: { ok: true } }),
    record(4, "approval/asked", { id: "p", operationId: "op", toolName: "示例工具", reason: "原因" })];
  await sendFrame(connections[0], snapshot("a", events));
  expect(container.textContent).toContain("等待审批");
  let resolve; fetch.mockImplementation(() => new Promise(r => { resolve = r; }));
  await click(button("单次允许"));
  expect(fetch.mock.calls[0][0]).toBe("/api/sessions/a/approvals/p/decision");
  await click(button("会话 2")); await sendFrame(connections[1], snapshot("b", events));
  await act(async () => resolve({ status: 200, ok: true, json: async () => ({ id: "p", outcome: "allowed-once" }) })); await flush();
  expect(container.textContent).not.toContain("已允许");
  expect(button("单次允许").disabled).toBe(false);
  await sendFrame(connections[1], record(5, "approval/decided", { id: "p", outcome: "rejected" }));
  expect(container.textContent).toContain("已拒绝");
});

test("取消与截断的助手尝试按事实区分", async () => {
  const events = [record(0, "assistant/attempt", { turn: 1, step: 1, outcome: "cancelled", reason: "user", stream: [], text: "取消片段", includeInModelContext: false }), record(1, "assistant/attempt", { turn: 2, step: 1, outcome: "truncated", reason: "output_limit", stream: [], text: "截断片段", includeInModelContext: false })];
  await sendFrame(connections[0], snapshot("a", events));
  expect(container.textContent).toContain("已取消");
  expect(container.textContent).toContain("已截断");
});

test("审批 HTTP 先确认时工具摘要立即收敛而不声称执行完成", async () => {
  const events = [record(0, "tool/call", { turn: 1, step: 1, callId: "x", name: "工具", arguments: "{}" }), record(1, "tool/operation", { turn: 1, step: 1, callId: "x", operationId: "op", toolName: "工具", toolVersion: "1", validatedArgs: {} }), record(2, "approval/asked", { id: "p", operationId: "op", toolName: "工具", reason: "原因" })];
  await sendFrame(connections[0], snapshot("a", events));
  fetch.mockResolvedValue({ status: 200, ok: true, json: async () => ({ id: "p", outcome: "allowed-once" }) });
  await click(button("单次允许"));
  expect(container.querySelector("details summary").textContent).toContain("等待结果");
  expect(container.querySelector("details summary").textContent).not.toContain("等待审批");
});

test("迟到忙碌响应不覆盖切走前主动清空的草稿", async () => {
  await sendFrame(connections[0], snapshot("a"));
  let resolve; fetch.mockImplementation(() => new Promise(r => { resolve = r; }));
  await enter("原文"); await submit(); await enter("编辑"); await enter("");
  await click(button("会话 2")); await sendFrame(connections[1], snapshot("b"));
  await act(async () => resolve({ status: 409, ok: false })); await flush();
  await click(button("会话 1"));
  expect(container.querySelector("textarea").value).toBe("");
});

test("迟到创建成功加入目录但不抢显式选择，即使切回原会话", async () => {
  let resolve; fetch.mockImplementation(() => new Promise(r => { resolve = r; }));
  await click(button("新建会话")); await click(button("会话 2")); await click(button("会话 1"));
  await act(async () => resolve({ ok: true, json: async () => ({ sessionId: "c" }) })); await flush();
  expect(button("会话 1").getAttribute("aria-current")).toBe("page");
  expect(button("会话 3")).toBeTruthy();
});

test("迟到创建失败不污染新会话通知", async () => {
  let reject; fetch.mockImplementation(() => new Promise((_, r) => { reject = r; }));
  await click(button("新建会话")); await click(button("会话 2"));
  await act(async () => reject(new Error("failed"))); await flush();
  expect(container.textContent).not.toContain("创建会话失败");
});

test("创建请求卸载后完成不订阅新会话", async () => {
  let resolve; fetch.mockImplementation(() => new Promise(r => { resolve = r; }));
  await click(button("新建会话"));
  await act(async () => root.unmount());
  await act(async () => resolve({ ok: true, json: async () => ({ sessionId: "c" }) })); await flush();
  expect(connections).toHaveLength(1);
  expect(connections[0].closed).toBe(true);
  root = createRoot(container);
});

test("无正文失败、取消和截断尝试保留状态且后续轮次可读", async () => {
  const records = [
    record(0, "assistant/attempt", { turn: 1, step: 1, outcome: "failed", reason: { diagnostic: "不展示诊断" }, stream: [], includeInModelContext: false }),
    record(1, "assistant/attempt", { turn: 2, step: 1, outcome: "cancelled", reason: "cancel", stream: [], includeInModelContext: false }),
    record(2, "assistant/attempt", { turn: 3, step: 1, outcome: "truncated", reason: "output_limit", stream: [], includeInModelContext: false }),
    record(3, "turn/start", { turn: 4 }),
  ];
  await sendFrame(connections[0], snapshot("a", records));
  expect(container.textContent).toContain("失败");
  expect(container.textContent).toContain("已取消");
  expect(container.textContent).toContain("已截断");
  expect(container.textContent).not.toContain("不展示诊断");
  expect(container.textContent).toContain("正在处理");
  expect(container.querySelectorAll("article.assistant")).toHaveLength(0);
});

const approvalWindow = () => [record(0, "turn/start", { turn: 1 }), record(1, "step/start", { turn: 1, step: 1 }), record(2, "tool/call", { turn: 1, step: 1, callId: "x", name: "工具", arguments: "{}" }), record(3, "tool/operation", { turn: 1, step: 1, callId: "x", operationId: "op", toolName: "工具", toolVersion: "1", validatedArgs: {} }), record(4, "approval/asked", { id: "p", operationId: "op", toolName: "工具", reason: "原因" })];

test("审批网络未知切回后仅可重试原决定", async () => {
  const events = approvalWindow(); await sendFrame(connections[0], snapshot("a", events));
  fetch.mockRejectedValueOnce(new Error("lost")); await click(button("单次允许"));
  await click(button("会话 2")); await sendFrame(connections[1], snapshot("b"));
  await click(button("会话 1")); await sendFrame(connections[2], snapshot("a", events));
  expect(container.textContent).toContain("结果未知");
  expect(button("拒绝").disabled).toBe(true);
  fetch.mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ id: "p", outcome: "allowed-once" }) });
  await click(button("单次允许"));
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ outcome: "allowed-once" });
});

test("审批请求跨切换保持锁，事件先到时迟到回调不可覆盖", async () => {
  const events = approvalWindow(); await sendFrame(connections[0], snapshot("a", events));
  let resolve; fetch.mockImplementation(() => new Promise(r => { resolve = r; }));
  await click(button("单次允许"));
  await click(button("会话 2")); await sendFrame(connections[1], snapshot("b"));
  await click(button("会话 1")); await sendFrame(connections[2], snapshot("a", events));
  expect(button("单次允许").disabled).toBe(true);
  expect(button("拒绝").disabled).toBe(true);
  await sendFrame(connections[2], record(5, "approval/decided", { id: "p", outcome: "rejected" }));
  await act(async () => resolve({ status: 200, ok: true, json: async () => ({ id: "p", outcome: "allowed-once" }) })); await flush();
  expect(container.textContent).toContain("已拒绝");
  expect(container.textContent).not.toContain("已允许");
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("审批请求切走后 HTTP 确认仍归原会话，切回可见", async () => {
  const events = approvalWindow(); await sendFrame(connections[0], snapshot("a", events));
  let resolve; fetch.mockImplementation(() => new Promise(r => { resolve = r; }));
  await click(button("单次允许")); await click(button("会话 2")); await sendFrame(connections[1], snapshot("b"));
  await act(async () => resolve({ status: 200, ok: true, json: async () => ({ id: "p", outcome: "allowed-once" }) })); await flush();
  expect(container.textContent).not.toContain("已允许");
  await click(button("会话 1")); await sendFrame(connections[2], snapshot("a", events));
  expect(container.textContent).toContain("已允许");
  expect(container.textContent).toContain("等待结果");
});

const completeWindow = () => [
  record(0, "turn/start", { turn: 1 }), record(1, "step/start", { turn: 1, step: 1 }),
  record(2, "user/message", { id: "u", role: "user", source: { kind: "user" }, turn: 1, requestId: "r", content: [{ type: "text", text: "查询" }] }, { surfaceOp: "append" }),
  record(3, "assistant/message", { turn: 1, step: 1, message: { id: "m", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "text", text: "准备查询" }, { type: "tool-call", id: "x", name: "工具", arguments: "{}" }] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true }, { surfaceOp: "append" }),
  record(4, "tool/call", { turn: 1, step: 1, callId: "x", name: "工具", arguments: "{}" }),
  record(5, "tool/operation", { turn: 1, step: 1, callId: "x", operationId: "op", toolName: "工具", toolVersion: "1", validatedArgs: {} }),
  record(6, "approval/asked", { id: "p", operationId: "op", toolName: "工具", reason: "原因" }),
];
const toolResult = () => record(7, "tool/result", { turn: 1, step: 1, operationId: "op", message: { id: "result", role: "user", source: { kind: "tool", callId: "x" }, content: [{ type: "tool-result", toolCallId: "x", isError: false, content: [{ type: "text", text: "工具结果" }] }] } }, { surfaceOp: "append", sourceEventSeqs: [4] });

test("完整事件增量展示正文和工具结果，终态关闭审批并保留历史", async () => {
  const events = completeWindow(); await sendFrame(connections[0], snapshot("a", events));
  let resolve; fetch.mockImplementation(() => new Promise(r => { resolve = r; }));
  await click(button("单次允许"));
  await sendFrame(connections[0], toolResult());
  expect(container.textContent).toContain("查询"); expect(container.textContent).toContain("准备查询");
  expect(container.textContent).toContain("工具结果"); expect(button("单次允许")).toBeFalsy();
  await sendFrame(connections[0], record(8, "step/end", { turn: 1, step: 1 }));
  await sendFrame(connections[0], record(9, "turn/end", { turn: 1, reason: { kind: "completed" } }));
  await act(async () => resolve({ status: 200, ok: true, json: async () => ({ id: "p", outcome: "allowed-once" }) })); await flush();
  expect(container.textContent).toContain("工具结果"); expect(container.textContent).toContain("本轮结束：completed");
  expect(container.textContent).not.toContain("已允许");
});

test("同步终止失败保留工具历史但禁用审批，快照恢复后启用", async () => {
  const events = completeWindow(); await sendFrame(connections[0], snapshot("a", events));
  await sendFrame(connections[0], { type: "error", error: { code: "follow_sync_failed", message: "同步故障", details: {} } });
  expect(container.textContent).toContain("准备查询"); expect(container.textContent).toContain("工具");
  expect(button("单次允许").disabled).toBe(true);
  await click(button("重新同步")); await sendFrame(connections[1], snapshot("a", events));
  expect(button("单次允许").disabled).toBe(false);
});

test("没有工具结果的轮次终态关闭待审批操作", async () => {
  await sendFrame(connections[0], snapshot("a", completeWindow()));
  await sendFrame(connections[0], record(7, "step/end", { turn: 1, step: 1 }));
  await sendFrame(connections[0], record(8, "turn/end", { turn: 1, reason: { kind: "interrupted" } }));
  expect(button("单次允许")).toBeFalsy();
  expect(container.textContent).toContain("审批已失效");
  expect(container.textContent).toContain("准备查询");
});
