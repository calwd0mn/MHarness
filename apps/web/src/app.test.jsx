import { useApprovals } from "./session/use-approvals.ts";
import { Approval as ApprovalView } from "./features/conversation/Approval.tsx";
// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Session } from "@mharness/session/server";
import { App } from "./App.tsx";

function Approval({ approval, enabled, decision, closed }) {
  const approvals = useApprovals();
  return <ApprovalView approval={approval} enabled={enabled} decision={decision} closed={closed} request={approvals.get("a", approval.id, approval.operationId)} onSubmit={(outcome) => void approvals.submit("a", approval.id, approval.operationId, outcome)} />;
}

const connections = [];
class Source {
  constructor(url) { this.url = url; this.closed = false; if (url === "/api/session-directory/events") queueMicrotask(() => this.frame({ type: "api-session/ready" })); else connections.push(this); }
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
  localStorage.setItem("mharness.sessions.current", JSON.stringify({ sessionId: "a" }));
  vi.stubGlobal("EventSource", Source);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ revision: 0, sessions: ["a", "b"].map((sessionId) => ({ sessionId, createdAt: 1, updatedAt: 1, running: false, blank: false })) }) }));
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<App />); });
  fetch.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

test("创建结果未知时显示非交互状态并保留选择", async () => {
  fetch.mockResolvedValueOnce({ status: 503, json: async () => ({ code: "session_creation_unknown", sessionId: "pending" }) });
  await click(button("新建会话"));
  expect(container.textContent).toContain("创建结果未知");
  expect(button("核实待保存会话")).toBeUndefined();
  expect(localStorage.getItem("mharness.sessions.current")).toBe('{"sessionId":"a"}');
  expect(connections.map(({ url }) => url)).toEqual(["/api/sessions/a/follow"]);
  expect(fetch.mock.calls).toHaveLength(1);
});

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
test("手动压缩独立提交并展示终态", async () => {
  await sendFrame(connections[0], snapshot("a"));
  fetch.mockImplementation(async (_url, options) => ({ status: 200, json: async () => ({ compactionId: JSON.parse(options.body).compactionId, commandId: "cmd", status: "succeeded" }) }));
  await enter("  /compact  "); await submit();
  expect(fetch.mock.calls[0][0]).toBe("/api/sessions/a/compact");
  expect(Object.keys(JSON.parse(fetch.mock.calls[0][1].body))).toEqual(["compactionId"]);
  expect(container.querySelectorAll("article.user")).toHaveLength(0);
  expect(container.textContent).toContain("已压缩");
});
for (const content of ["/Compact", "/compact now", "/compact\n请继续", "说 /compact"]) test(`普通消息保留原文 ${content}`, async () => {
  await sendFrame(connections[0], snapshot("a"));
  fetch.mockResolvedValue(ok());
  await enter(content); await submit();
  expect(fetch.mock.calls[0][0]).toBe("/api/sessions/a/messages");
  expect(JSON.parse(fetch.mock.calls[0][1].body).content[0].text).toBe(content);
});
for (const [status, body, label] of [
  [409, { code: "agent_busy" }, "压缩结果未知"],
  [409, { commandId: "cmd", result: { kind: "error", text: "助手忙碌" } }, "助手忙碌"],
  [400, { commandId: null, result: { kind: "error", text: "请求无效" } }, "请求无效"],
  [413, { commandId: null, result: { kind: "error", text: "正文过大" } }, "正文过大"],
  [415, { commandId: null, result: { kind: "error", text: "媒体类型无效" } }, "媒体类型无效"],
  [415, { commandId: "cmd", result: { kind: "error", text: "不应显示" } }, "压缩结果未知"],
  [400, { code: "invalid_request" }, "压缩结果未知"],
  [409, { code: "compaction_id_conflict" }, "标识已使用"],
  [503, { code: "compaction_unavailable" }, "暂不可用"],
  [500, { code: "compaction_internal_error" }, "压缩结果未知"],
  [500, { code: "private-error" }, "压缩结果未知"],
  [503, { code: "agent_busy" }, "压缩结果未知"],
  [202, { accepted: true }, "压缩结果未知"],
  [200, { status: "succeeded" }, "压缩结果未知"],
]) test(`压缩 HTTP ${status} 显示 ${label}`, async () => {
  await sendFrame(connections[0], snapshot("a"));
  fetch.mockResolvedValue({ status, json: async () => body });
  await enter("/compact"); await submit();
  expect(container.textContent).toContain(label);
});
for (const status of [200, 500]) test(`压缩 HTTP ${status} 不会误用其他响应的终态`, async () => {
  await sendFrame(connections[0], snapshot("a"));
  fetch.mockImplementation(async (_url, options) => ({
    status,
    json: async () => ({
      compactionId: status === 500 ? JSON.parse(options.body).compactionId : "2dfe7336-a43e-4fcb-9530-1880d94588ce",
      status: "failed",
    }),
  }));
  await enter("/compact"); await submit();
  expect(container.textContent).toContain("压缩结果未知");
  expect(container.textContent).not.toContain("压缩失败");
});
test("无法解析的压缩 500 只显示结果未知", async () => {
  await sendFrame(connections[0], snapshot("a"));
  fetch.mockResolvedValue({ status: 500, json: async () => { throw new SyntaxError("private-body"); } });
  await enter("/compact"); await submit();
  expect(container.textContent).toContain("压缩结果未知");
  expect(container.textContent).not.toContain("private-body");
});
for (const hangingBody of [false, true]) test(`HTTP ${hangingBody ? "响应体" : "请求"}挂起时按可靠日志恢复，迟到冲突仍优先`, async () => {
  await sendFrame(connections[0], snapshot("a"));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  fetch.mockImplementation(() => hangingBody ? Promise.resolve({ status: 200, json: () => gate }) : gate);
  vi.useFakeTimers();
  try {
    await enter("/compact");
    await act(async () => { container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    const id = JSON.parse(fetch.mock.calls[0][1].body).compactionId;
    await act(async () => { connections[0].frame(record(0, "compaction/start", { compactionId: id, turn: null })); });
    await act(async () => { connections[0].frame(record(1, "compaction/end", { compactionId: id, turn: null, status: "succeeded" })); });
    expect(container.textContent).toContain("已压缩");
    expect(container.textContent).not.toContain("正在提交压缩");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(container.textContent).toContain("已压缩");
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { release(hangingBody ? { compactionId: id, commandId: "cmd", status: "succeeded" } : { status: 409, json: async () => ({ code: "compaction_id_conflict" }) }); });
    if (!hangingBody) expect(container.textContent).toContain("标识已使用");
  } finally { vi.useRealTimers(); }
});
test("提交前的旧开始不能用于恢复同 ID 的新请求", async () => {
  const id = "2dfe7336-a43e-4fcb-9530-1880d94588ce";
  await sendFrame(connections[0], snapshot("a", [record(0, "compaction/start", { compactionId: id, turn: null })]));
  vi.spyOn(crypto, "randomUUID").mockReturnValue(id);
  fetch.mockRejectedValue(new Error("lost"));
  await enter("/compact"); await submit();
  await sendFrame(connections[0], record(1, "compaction/end", { compactionId: id, turn: null, status: "succeeded" }));
  expect(container.textContent).toContain("压缩结果未知");
  expect(container.textContent).not.toContain("已压缩");
  vi.restoreAllMocks();
});
test("取消请求确认不等于压缩终态", async () => {
  await sendFrame(connections[0], snapshot("a"));
  fetch.mockRejectedValueOnce(new Error("lost")).mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ accept: true }) });
  await enter("/compact"); await submit();
  const id = JSON.parse(fetch.mock.calls[0][1].body).compactionId;
  await sendFrame(connections[0], record(0, "compaction/start", { compactionId: id, turn: null }));
  expect(container.textContent).toContain("压缩进行中");
  await click(button("取消任务"));
  expect(container.textContent).toContain("已请求取消");
  expect(container.textContent).toContain("压缩进行中");
  expect(container.textContent).not.toContain("压缩已取消");
  await sendFrame(connections[0], record(1, "compaction/end", { compactionId: id, turn: null, status: "cancelled", reason: "cancel" }));
  expect(container.textContent).toContain("压缩已取消");
});
test("follow 成功先于取消 HTTP 确认时保留成功状态", async () => {
  await sendFrame(connections[0], snapshot("a", [userRecord("original")]));
  let confirmCancel;
  const cancellation = new Promise(resolve => { confirmCancel = resolve; });
  fetch.mockRejectedValueOnce(new Error("lost")).mockReturnValueOnce(cancellation);
  await enter("/compact"); await submit();
  const id = JSON.parse(fetch.mock.calls[0][1].body).compactionId;
  await sendFrame(connections[0], record(1, "compaction/start", { compactionId: id, turn: null }));
  expect(container.textContent).toContain("压缩进行中");

  await click(button("取消任务"));
  expect(fetch.mock.calls[1][0]).toBe("/api/sessions/a/cancel");
  expect(container.textContent).not.toContain("已请求取消");
  await sendFrame(connections[0], record(2, "compaction/summary", { compactionId: id, summary: "摘要", shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], route: { provider: "p", model: "m" } }));
  await sendFrame(connections[0], record(3, "user/message", { id: "summary", role: "user", source: { kind: "compact", compactionId: id }, content: [{ type: "text", text: "摘要" }] }, { surfaceOp: { op: "replace", start: 0, end: 0 }, sourceEventSeqs: [0, 2] }));
  await sendFrame(connections[0], record(4, "compaction/end", { compactionId: id, turn: null, status: "succeeded" }));
  expect(container.textContent).toContain("已压缩");
  expect(container.textContent).not.toContain("已请求取消");

  await act(async () => { confirmCancel({ ok: true, status: 202, json: async () => ({ accept: true }) }); });
  expect(container.textContent).toContain("已请求取消");
  expect(container.textContent).toContain("已压缩");
  expect(container.textContent).not.toContain("压缩已取消");
  expect(fetch).toHaveBeenCalledTimes(2);
});
test("切换会话时迟到的压缩响应不污染当前页面和草稿", async () => {
  await sendFrame(connections[0], snapshot("a"));
  let release;
  fetch.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  await enter("/compact"); await submit();
  const id = JSON.parse(fetch.mock.calls[0][1].body).compactionId;
  await click(button("会话 2")); await sendFrame(connections[1], snapshot("b"));
  await enter("会话 B 草稿");
  await act(async () => { release({ status: 200, json: async () => ({ compactionId: id, commandId: "cmd", status: "succeeded" }) }); });
  expect(container.textContent).not.toContain("已压缩");
  expect(container.querySelector("textarea").value).toBe("会话 B 草稿");
  await click(button("会话 1")); await sendFrame(connections[2], snapshot("a"));
  expect(container.textContent).toContain("已压缩");
});
for (const [status, label] of [["no_safe_range", "没有可压缩范围"], ["cancelled", "压缩已取消"], ["failed", "压缩失败"]]) test(`压缩 HTTP 终态 ${status}`, async () => {
  await sendFrame(connections[0], snapshot("a"));
  fetch.mockImplementation(async (_url, options) => ({ status: 200, json: async () => ({ compactionId: JSON.parse(options.body).compactionId, commandId: "cmd", status }) }));
  await enter("/compact"); await submit();
  expect(container.textContent).toContain(label);
});
test("只用同 ID 的自有手动记录恢复未知请求", async () => {
  await sendFrame(connections[0], snapshot("a"));
  fetch.mockRejectedValue(new Error("lost"));
  await enter("/compact"); await submit();
  const id = JSON.parse(fetch.mock.calls[0][1].body).compactionId;
  await sendFrame(connections[0], record(0, "compaction/start", { compactionId: "other", turn: null }));
  await sendFrame(connections[0], record(1, "compaction/end", { compactionId: "other", turn: null, status: "succeeded" }));
  await sendFrame(connections[0], record(2, "compaction/start", { compactionId: id, turn: 1 }));
  await sendFrame(connections[0], record(3, "compaction/end", { compactionId: id, turn: 1, status: "succeeded" }));
  expect(container.textContent).toContain("压缩结果未知");
  await sendFrame(connections[0], record(4, "compaction/start", { compactionId: id, turn: null }));
  expect(container.textContent).toContain("压缩进行中");
  await sendFrame(connections[0], record(5, "compaction/end", { compactionId: id, turn: null, status: "cancelled", reason: "cancel" }));
  expect(container.textContent).toContain("压缩已取消");
  expect(fetch).toHaveBeenCalledTimes(1);
});
test("没有本地提交时仅展示自有独立维护记录", async () => {
  const frames = [record(0, "compaction/start", { compactionId: "old", turn: null }), record(1, "compaction/end", { compactionId: "old", turn: null, status: "succeeded" }), record(2, "compaction/start", { compactionId: "auto", turn: 1 }), record(3, "compaction/end", { compactionId: "auto", turn: 1, status: "succeeded" })];
  await sendFrame(connections[0], { ...snapshot("a", frames), inheritedEventCount: 2 });
  expect(container.textContent).not.toContain("已压缩");
  await sendFrame(connections[0], record(4, "compaction/start", { compactionId: "manual", turn: null }));
  expect(container.textContent).toContain("压缩进行中");
  await sendFrame(connections[0], record(5, "compaction/end", { compactionId: "manual", turn: null, status: "interrupted", reason: "lost" }));
  expect(container.textContent).toContain("压缩已中断");
});
test("重新同步快照用匹配记录恢复未知结果", async () => {
  await sendFrame(connections[0], snapshot("a"));
  fetch.mockRejectedValue(new Error("lost"));
  await enter("/compact"); await submit();
  const id = JSON.parse(fetch.mock.calls[0][1].body).compactionId;
  await click(button("会话 2")); await sendFrame(connections[1], snapshot("b"));
  await click(button("会话 1"));
  await sendFrame(connections[2], snapshot("a", [record(0, "compaction/start", { compactionId: id, turn: null }), record(1, "compaction/end", { compactionId: id, turn: null, status: "failed", reason: "private" })]));
  expect(container.textContent).toContain("压缩失败");
  expect(container.textContent).not.toContain("private");
  expect(fetch).toHaveBeenCalledTimes(1);
});
test("HTTP 回包丢失后，已观察到的压缩成功在重连及同步失败时保留", async () => {
  const original = userRecord("original");
  await sendFrame(connections[0], snapshot("a", [original]));
  fetch.mockRejectedValueOnce(new Error("lost"));
  await enter("/compact"); await submit();
  expect(container.textContent).toContain("压缩结果未知");
  const compactionId = JSON.parse(fetch.mock.calls[0][1].body).compactionId;
  const range = { start: 0, end: 0 };
  const frames = [
    record(1, "compaction/start", { compactionId, turn: null }),
    record(2, "compaction/summary", { compactionId, summary: "摘要", shadowedRange: range, shadowedSeqs: [0], route: { provider: "p", model: "m" } }),
    record(3, "user/message", { id: "summary", role: "user", source: { kind: "compact", compactionId }, content: [{ type: "text", text: "摘要" }] }, { surfaceOp: { op: "replace", ...range }, sourceEventSeqs: [0, 2] }),
    record(4, "compaction/end", { compactionId, turn: null, status: "succeeded" }),
  ];
  const records = [original, ...frames];
  const replay = new Session({ sessionId: "a", createdAt: 0 }, {
    seed: { kind: "restore", inheritedEventCount: 0, events: records.map(({ event }) => event) },
  });
  expect(replay.deriveMessages().map(({ id }) => id)).toEqual(["summary"]);
  for (const frame of frames) await sendFrame(connections[0], frame);
  expect(container.textContent).toContain("已压缩");

  vi.useFakeTimers();
  try {
    await act(async () => { connections[0].onerror(); });
    expect(container.textContent).toContain("正在同步");
    expect(container.textContent).toContain("已压缩");
    expect(container.textContent).not.toContain("压缩结果未知");
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  } finally { vi.useRealTimers(); }

  await sendFrame(connections[1], { type: "error", error: { code: "follow_sync_failed", message: "同步故障", details: {} } });
  expect(container.textContent).toContain("同步故障");
  expect(container.textContent).toContain("已压缩");
  await click(button("重新同步"));
  expect(container.textContent).toContain("已压缩");
  await sendFrame(connections[2], snapshot("a", records));
  expect(container.textContent).toContain("已连接");
  expect(container.textContent).toContain("已压缩");
  await click(button("会话 2"));
  await sendFrame(connections[3], snapshot("b"));
  expect(container.textContent).not.toContain("已压缩");
  expect(fetch).toHaveBeenCalledTimes(1);
});
test("未获得可信游标时不将快照中的旧结果当成本次提交", async () => {
  fetch.mockRejectedValue(new Error("lost"));
  await enter("/compact"); await submit();
  const id = JSON.parse(fetch.mock.calls[0][1].body).compactionId;
  await sendFrame(connections[0], snapshot("a", [record(0, "compaction/start", { compactionId: id, turn: null }), record(1, "compaction/end", { compactionId: id, turn: null, status: "succeeded" })]));
  expect(container.textContent).toContain("压缩结果未知");
  expect(container.textContent).not.toContain("已压缩");
});
test("较早的明确冲突不会被后续同 ID 事件覆盖", async () => {
  await sendFrame(connections[0], snapshot("a"));
  fetch.mockResolvedValue({ status: 409, json: async () => ({ code: "compaction_id_conflict" }) });
  await enter("/compact"); await submit();
  const id = JSON.parse(fetch.mock.calls[0][1].body).compactionId;
  await sendFrame(connections[0], record(0, "compaction/start", { compactionId: id, turn: null }));
  await sendFrame(connections[0], record(1, "compaction/end", { compactionId: id, turn: null, status: "succeeded" }));
  expect(container.textContent).toContain("标识已使用");
  expect(container.textContent).not.toContain("已压缩");
});
test("请求永久挂起且没有日志证据时超时保持未知", async () => {
  await sendFrame(connections[0], snapshot("a"));
  fetch.mockImplementation(() => new Promise(() => {}));
  vi.useFakeTimers();
  try {
    await enter("/compact");
    await act(async () => { container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(container.textContent).toContain("压缩结果未知");
    expect(container.textContent).not.toContain("压缩失败");
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
test("压缩事件和替换副本不改变原消息与工具卡", async () => {
  const id = "2dfe7336-a43e-4fcb-9530-1880d94588ce";
  const frames = [
    userRecord("original"),
    record(1, "assistant/message", { turn: 1, step: 1, message: { id: "m", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "text", text: "原始回答" }, { type: "tool-call", id: "x", name: "mock_read", arguments: "{}" }] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true }, { surfaceOp: "append" }),
    record(2, "tool/call", { turn: 1, step: 1, callId: "x", name: "mock_read", arguments: "{}" }),
    record(3, "tool/result", { turn: 1, step: 1, message: { id: "r", role: "user", source: { kind: "tool", callId: "x" }, content: [{ type: "tool-result", toolCallId: "x", isError: false, content: [{ type: "text", text: "原始结果" }] }] } }, { surfaceOp: "append", sourceEventSeqs: [2] }),
    record(4, "compaction/start", { compactionId: id, turn: null }),
    record(5, "compaction/summary", { compactionId: id, summary: "秘密摘要", shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], route: { provider: "p", model: "m" } }),
    record(6, "user/message", { id: "summary", role: "user", source: { kind: "compact", compactionId: id }, content: [{ type: "text", text: "秘密摘要" }] }, { surfaceOp: { op: "replace", start: 0, end: 0 }, sourceEventSeqs: [0, 5] }),
    record(7, "compaction/end", { compactionId: id, turn: null, status: "succeeded" }),
    record(8, "tool/result", { turn: 1, step: 1, message: { id: "r", role: "user", source: { kind: "tool", callId: "x" }, content: [{ type: "tool-result", toolCallId: "x", isError: false, content: [{ type: "text", text: "替换正文" }] }] } }, { surfaceOp: { op: "replace", start: 3, end: 3 }, sourceEventSeqs: [3] }),
  ];
  const replay = new Session({ sessionId: "a", createdAt: 0 }, {
    seed: { kind: "restore", inheritedEventCount: 0, events: frames.map(({ event }) => event) },
  });
  expect(replay.deriveMessages().map(({ id }) => id)).toEqual(["summary", "m", "r"]);
  const expectOriginalHistory = () => {
    expect(container.querySelector("article.user").textContent).toBe("你你好");
    expect(container.querySelectorAll("article.user")).toHaveLength(1);
    expect(container.querySelectorAll("article.assistant")).toHaveLength(1);
    expect(container.textContent).toContain("原始回答");
    expect(container.textContent).not.toContain("秘密摘要");
    expect(container.textContent).not.toContain("替换正文");
    expect(container.textContent).not.toContain("正在生成");
    expect(container.textContent.match(/mock_read/g)).toHaveLength(1);
  };
  await sendFrame(connections[0], snapshot("a", frames.slice(0, 4)));
  for (const frame of frames.slice(4)) await sendFrame(connections[0], frame);
  expectOriginalHistory();
  await click(button("会话 2"));
  await click(button("会话 1"));
  await sendFrame(connections[2], snapshot("a", frames));
  expectOriginalHistory();
});
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
  expect(container.querySelector('nav [aria-current="page"] small').textContent).toBe("a");
  expect([...container.querySelectorAll("nav button small")].some((item) => item.textContent === "c")).toBe(false);
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

test("嵌套 fork 中只有子会话自有事件接管同编号发送占位", async () => {
  const connection = connections[0];
  expect(connection.url).toBe("/api/sessions/a/follow");
  fetch.mockImplementation(() => new Promise(() => {}));
  await enter("子消息");
  await submit();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe("/api/sessions/a/messages");
  const { requestId } = JSON.parse(fetch.mock.calls[0][1].body);
  const user = (seq, turn, id, text) => record(seq, "user/message", {
    id, turn, requestId, role: "user", source: { kind: "user" }, content: [{ type: "text", text }],
  }, { surfaceOp: "append" });
  const users = () => [...container.querySelectorAll("article.user")].map((item) => item.textContent);
  expect(users()).toEqual(["你子消息正在发送"]);

  await sendFrame(connection, { ...snapshot("a", [
    record(0, "turn/start", { turn: 1 }),
    record(1, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    record(2, "session/end-seed", { inherited: true }),
    record(3, "turn/start", { turn: 2 }),
    record(4, "step/start", { turn: 2, step: 1 }),
    user(5, 2, "parent-user", "父消息"),
    record(6, "step/end", { turn: 2, step: 1 }),
    record(7, "turn/end", { turn: 2, reason: { kind: "completed" } }),
    record(8, "session/end-seed", { inherited: true }),
  ]), inheritedEventCount: 8 });
  expect(users()).toEqual(["你父消息", "你子消息正在发送"]);

  await sendFrame(connection, record(9, "turn/start", { turn: 3 }));
  await sendFrame(connection, record(10, "step/start", { turn: 3, step: 1 }));
  expect(users()).toEqual(["你父消息", "你子消息正在发送"]);
  await sendFrame(connection, user(11, 3, "child-user", "子消息"));
  expect(users()).toEqual(["你父消息", "你子消息"]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("同一步重连草稿保留此前失败记录", async () => {
  const records = [record(0, "turn/start", { turn: 1 }), record(1, "step/start", { turn: 1, step: 1 }),
    record(2, "assistant/attempt", { turn: 1, step: 1, outcome: "failed", reason: { code: "CONTEXT_WINDOW_EXCEEDED", message: "超限" }, stream: [], includeInModelContext: false })];
  const stream = { revision: 1, activeAttempt: { attemptId: "retry", turn: 1, step: 1, chunks: [{ type: "text", delta: "重试正文" }], nextIndex: 1 } };
  await sendFrame(connections[0], snapshot("a", records, stream));
  expect(container.textContent).toContain("助手尝试失败");
  expect(container.textContent).toContain("重试正文");
});

test("同一步失败后实时重试保留失败并交接新草稿", async () => {
  const records = [record(0, "turn/start", { turn: 1 }), record(1, "step/start", { turn: 1, step: 1 })];
  const stream = { revision: 1, activeAttempt: { attemptId: "first", turn: 1, step: 1, chunks: [], nextIndex: 0 } };
  await sendFrame(connections[0], snapshot("a", records, stream));
  const failed = record(2, "assistant/attempt", { turn: 1, step: 1, outcome: "failed", reason: { code: "CONTEXT_WINDOW_EXCEEDED", message: "超限" }, stream: [], includeInModelContext: false });
  await sendFrame(connections[0], failed);
  await sendFrame(connections[0], { type: "assistant-stream", frame: { type: "end", attemptId: "first", revision: 2, turn: 1, step: 1, index: 0, outcome: { kind: "committed", eventType: "assistant/attempt", seq: 2 } } });
  await sendFrame(connections[0], { type: "assistant-stream", frame: { type: "start", attemptId: "second", revision: 3, turn: 1, step: 1 } });
  await sendFrame(connections[0], { type: "assistant-stream", frame: { type: "chunk", attemptId: "second", revision: 4, index: 0, chunk: { type: "text", delta: "新正文" } } });
  expect(container.textContent.split("助手尝试失败")).toHaveLength(2);
  const node = container.querySelector("article.assistant");
  const message = record(3, "assistant/message", { turn: 1, step: 1, message: { id: "m", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "text", text: "新正文" }] }, finishReason: { kind: "stop" }, stream: [], includeInModelContext: true }, { surfaceOp: "append" });
  await sendFrame(connections[0], message);
  expect(container.textContent.split("新正文")).toHaveLength(2);
  await sendFrame(connections[0], { type: "assistant-stream", frame: { type: "end", attemptId: "second", revision: 5, turn: 1, step: 1, index: 1, outcome: { kind: "committed", eventType: "assistant/message", seq: 3 } } });
  expect(container.querySelector("article.assistant")).toBe(node);
  expect(container.textContent.split("助手尝试失败")).toHaveLength(2);
  expect(container.textContent.split("新正文")).toHaveLength(2);
});

test("只有受理事件的活动 Turn 快照保持忙碌并接收首步", async () => {
  const user = record(1, "user/message", { id: "u", role: "user", source: { kind: "user" }, turn: 1, requestId: "r", content: [{ type: "text", text: "等待" }] }, { surfaceOp: "append" });
  await sendFrame(connections[0], snapshot("a", [record(0, "turn/start", { turn: 1 }), user]));
  expect(container.textContent).toContain("正在处理"); expect(button("取消任务")).toBeTruthy();
  await sendFrame(connections[0], record(2, "step/start", { turn: 1, step: 1 }));
  await sendFrame(connections[0], { type: "assistant-stream", frame: { type: "start", attemptId: "a1", revision: 1, turn: 1, step: 1 } });
  await sendFrame(connections[0], { type: "assistant-stream", frame: { type: "chunk", attemptId: "a1", revision: 2, index: 0, chunk: { type: "text", delta: "开始" } } });
  expect(container.textContent.split("等待")).toHaveLength(2); expect(container.textContent).toContain("开始"); expect(connections).toHaveLength(1);
});

function sharedCompactionFixture() {
  const session = new Session({ sessionId: "a", createdAt: 0 });
  const frames = [];
  const add = input => { const event = session.append(input); frames.push({ type: "event", event }); return event; };
  add({ type: "turn/start", data: { turn: 1 } });
  const original = add({ type: "user/message", data: { id: "original", role: "user", source: { kind: "user" }, turn: 1, requestId: "r", content: [{ type: "text", text: "原文" }] }, surfaceOp: "append" });
  add({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  const start = (commandId, compactionId) => {
    add({ type: "command/run", data: { commandId, name: "compact", source: { kind: "user" } } });
    add({ type: "compaction/start", data: { compactionId, sourceCommandId: commandId, turn: null } });
  };
  const finish = (commandId, compactionId, summary, sourceSeq, done = true) => {
    const summaryEvent = add({ type: "compaction/summary", data: { compactionId, sourceCommandId: commandId, summary, shadowedRange: { start: sourceSeq, end: sourceSeq }, shadowedSeqs: [sourceSeq], route: { provider: "p", model: "m" } } });
    const checkpoint = add({ type: "user/message", data: { id: `checkpoint-${commandId}`, role: "user", source: { kind: "compact", compactionId }, sourceCommandId: commandId, content: [{ type: "text", text: summary }] }, surfaceOp: { op: "replace", start: sourceSeq, end: sourceSeq }, sourceEventSeqs: [sourceSeq, summaryEvent.seq] });
    add({ type: "compaction/end", data: { compactionId, sourceCommandId: commandId, turn: null, status: "succeeded" } });
    if (done) add({ type: "command/done", data: { commandId, kind: "success", sourceEventSeq: summaryEvent.seq } });
    return checkpoint.seq;
  };
  return { session, frames, add, start, finish, original: original.seq };
}
const sharedCards = page => [...page.querySelectorAll("article")].filter(card => card.textContent.includes("/compact"));

for (const lateResponse of [false, true]) test(`连续提交后旧 C1 ${lateResponse ? "HTTP 响应迟到" : "start 迟到"}不冒充 C2 活动`, async () => {
  const other = document.createElement("div"); document.body.append(other);
  const otherRoot = createRoot(other);
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ revision: 0, sessions: ["a", "b"].map((sessionId) => ({ sessionId, createdAt: 1, updatedAt: 1, running: false, blank: false })) }) });
  await act(async () => otherRoot.render(<App />));
  fetch.mockClear();
  try {
    for (const connection of connections.slice(0, 2)) await sendFrame(connection, snapshot("a"));
    let release;
    fetch.mockImplementationOnce((_url, options) => {
      const id = JSON.parse(options.body).compactionId;
      const response = { status: 200, json: async () => ({ compactionId: id, commandId: "c1", status: "succeeded" }) };
      return lateResponse ? new Promise(resolve => { release = () => resolve(response); }) : Promise.resolve(response);
    });
    if (lateResponse) vi.useFakeTimers();
    await enter("/compact");
    await act(async () => { container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    const id1 = JSON.parse(fetch.mock.calls[0][1].body).compactionId;
    if (lateResponse) { await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); vi.useRealTimers(); }
    else await flush();
    fetch.mockImplementationOnce(() => new Promise(() => {}));
    await enter("/compact");
    await act(async () => { container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    const id2 = JSON.parse(fetch.mock.calls[1][1].body).compactionId;
    const { frames, add, start } = sharedCompactionFixture();
    start("c1", id1);
    for (const frame of frames) for (const connection of connections.slice(0, 2)) await sendFrame(connection, frame);
    if (lateResponse) await act(async () => { release(); });
    expect(container.querySelector("header").textContent).toContain("正在提交压缩");
    expect(container.querySelector("header").textContent).not.toContain("压缩进行中");
    const before = frames.length;
    add({ type: "compaction/end", data: { compactionId: id1, sourceCommandId: "c1", turn: null, status: "succeeded" } });
    add({ type: "command/done", data: { commandId: "c1", kind: "success" } });
    start("c2", id2);
    for (const frame of frames.slice(before)) for (const connection of connections.slice(0, 2)) await sendFrame(connection, frame);
    for (const page of [container, other]) expect(page.querySelector("header").textContent).toContain("压缩进行中");
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); await act(async () => otherRoot.unmount()); other.remove(); }
});

test("连续多个已确认终态各自抑制迟到开始", async () => {
  await sendFrame(connections[0], snapshot("a"));
  fetch.mockImplementation(async (_url, options) => ({ status: 200, json: async () => ({ compactionId: JSON.parse(options.body).compactionId, commandId: "cmd", status: "succeeded" }) }));
  await enter("/compact"); await submit();
  await enter("/compact"); await submit();
  const [first, second] = fetch.mock.calls.map(([, options]) => JSON.parse(options.body).compactionId);
  fetch.mockImplementationOnce(() => new Promise(() => {}));
  await enter("/compact");
  await act(async () => { container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  const third = JSON.parse(fetch.mock.calls[2][1].body).compactionId;
  const { frames, add, start } = sharedCompactionFixture();
  start("c1", first);
  for (const frame of frames) await sendFrame(connections[0], frame);
  expect(container.querySelector("header").textContent).not.toContain("压缩进行中");
  let before = frames.length;
  add({ type: "compaction/end", data: { compactionId: first, sourceCommandId: "c1", turn: null, status: "succeeded" } });
  add({ type: "command/done", data: { commandId: "c1", kind: "success" } });
  start("c2", second);
  for (const frame of frames.slice(before)) await sendFrame(connections[0], frame);
  expect(container.querySelector("header").textContent).not.toContain("压缩进行中");
  before = frames.length;
  add({ type: "compaction/end", data: { compactionId: second, sourceCommandId: "c2", turn: null, status: "succeeded" } });
  add({ type: "command/done", data: { commandId: "c2", kind: "success" } });
  start("c3", third);
  for (const frame of frames.slice(before)) await sendFrame(connections[0], frame);
  expect(container.querySelector("header").textContent).toContain("压缩进行中");
  expect(fetch).toHaveBeenCalledTimes(3);
});

test("已确认压缩身份只影响所属会话", async () => {
  await sendFrame(connections[0], snapshot("a"));
  fetch.mockImplementation(async (_url, options) => ({ status: 200, json: async () => ({ compactionId: JSON.parse(options.body).compactionId, commandId: "cmd", status: "succeeded" }) }));
  await enter("/compact"); await submit();
  const id = JSON.parse(fetch.mock.calls[0][1].body).compactionId;
  await click(button("会话 2"));
  const { frames, start } = sharedCompactionFixture();
  start("other-session-command", id);
  await sendFrame(connections[1], snapshot("b", frames));
  expect(container.querySelector("header").textContent).toContain("压缩进行中");
});

test("HTTP 已确认的 C1 迟到 start 不显示活动，另一页 C2 开始仍显示", async () => {
  const other = document.createElement("div"); document.body.append(other);
  const otherRoot = createRoot(other);
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ revision: 0, sessions: ["a", "b"].map((sessionId) => ({ sessionId, createdAt: 1, updatedAt: 1, running: false, blank: false })) }) });
  await act(async () => otherRoot.render(<App />));
  fetch.mockClear();
  try {
    for (const connection of connections.slice(0, 2)) await sendFrame(connection, snapshot("a"));
    fetch.mockImplementationOnce(async (_url, options) => ({ status: 200, json: async () => ({ compactionId: JSON.parse(options.body).compactionId, commandId: "c1", status: "succeeded" }) }));
    await enter("/compact"); await submit();
    const id = JSON.parse(fetch.mock.calls[0][1].body).compactionId;
    const { frames, start, finish, original } = sharedCompactionFixture();
    start("c1", id);
    for (const frame of frames) for (const connection of connections.slice(0, 2)) await sendFrame(connection, frame);
    expect(container.querySelector("header").textContent).toContain("已压缩");
    expect(container.querySelector("header").textContent).not.toContain("压缩进行中");
    let before = frames.length;
    const checkpoint = finish("c1", id, "摘要一", original);
    for (const frame of frames.slice(before)) for (const connection of connections.slice(0, 2)) await sendFrame(connection, frame);
    expect(container.querySelector("header").textContent).not.toContain("压缩进行中");
    fetch.mockImplementationOnce(() => new Promise(() => {}));
    const textarea = other.querySelector("textarea");
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(textarea, "/compact"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { other.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    const id2 = JSON.parse(fetch.mock.calls[1][1].body).compactionId;
    before = frames.length;
    start("c2", id2);
    for (const frame of frames.slice(before)) for (const connection of connections.slice(0, 2)) await sendFrame(connection, frame);
    for (const page of [container, other]) expect(page.querySelector("header").textContent).toContain("压缩进行中");
    before = frames.length;
    finish("c2", id2, "摘要二", checkpoint);
    for (const frame of frames.slice(before)) for (const connection of connections.slice(0, 2)) await sendFrame(connection, frame);
    for (const page of [container, other]) expect(page.querySelector("header").textContent).not.toContain("压缩进行中");
  } finally { await act(async () => otherRoot.unmount()); other.remove(); }
});

test("本地 C1 已完成后另一页 C2 运行仍显示活动状态", async () => {
  const other = document.createElement("div"); document.body.append(other);
  const otherRoot = createRoot(other);
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ revision: 0, sessions: ["a", "b"].map((sessionId) => ({ sessionId, createdAt: 1, updatedAt: 1, running: false, blank: false })) }) });
  await act(async () => otherRoot.render(<App />));
  fetch.mockClear();
  try {
    for (const connection of connections.slice(0, 2)) await sendFrame(connection, snapshot("a"));
    fetch.mockImplementationOnce(async (_url, options) => ({ status: 200, json: async () => ({ compactionId: JSON.parse(options.body).compactionId, commandId: "c1", status: "succeeded" }) }));
    await enter("/compact"); await submit();
    const c1 = JSON.parse(fetch.mock.calls[0][1].body).compactionId;
    const { frames, start, finish, original } = sharedCompactionFixture();
    start("c1", c1);
    const checkpoint = finish("c1", c1, "摘要一", original);
    for (const frame of frames) for (const connection of connections.slice(0, 2)) await sendFrame(connection, frame);
    expect(container.textContent).toContain("已压缩");
    fetch.mockImplementationOnce(() => new Promise(() => {}));
    const textarea = other.querySelector("textarea");
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(textarea, "/compact"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { other.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    const c2 = JSON.parse(fetch.mock.calls[1][1].body).compactionId;
    let before = frames.length;
    start("c2", c2);
    for (const frame of frames.slice(before)) for (const connection of connections.slice(0, 2)) await sendFrame(connection, frame);
    for (const page of [container, other]) {
      expect(page.querySelector("header").textContent).toContain("压缩进行中");
      expect(sharedCards(page)[1].textContent).toContain("执行中");
    }
    before = frames.length;
    finish("c2", c2, "摘要二", checkpoint);
    for (const frame of frames.slice(before)) for (const connection of connections.slice(0, 2)) await sendFrame(connection, frame);
    for (const page of [container, other]) expect(page.querySelector("header").textContent).not.toContain("压缩进行中");
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { await act(async () => otherRoot.unmount()); other.remove(); }
});

for (const status of [400, 409]) test(`活动压缩期间保留本页 HTTP ${status} 拒绝和活动提示`, async () => {
  const other = document.createElement("div"); document.body.append(other);
  const otherRoot = createRoot(other);
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ revision: 0, sessions: ["a", "b"].map((sessionId) => ({ sessionId, createdAt: 1, updatedAt: 1, running: false, blank: false })) }) });
  await act(async () => otherRoot.render(<App />));
  fetch.mockClear();
  try {
    const id = "2dfe7336-a43e-4fcb-9530-1880d94588ce";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(id);
    const { frames, start } = sharedCompactionFixture();
    start("c1", id);
    for (const connection of connections.slice(0, 2)) await sendFrame(connection, snapshot("a", frames));
    fetch.mockResolvedValue({ status, json: async () => ({ commandId: status === 400 ? null : "busy", result: { kind: "error", text: "明确拒绝" } }) });
    await enter("/compact"); await submit();
    const header = container.querySelector("header").textContent;
    expect(header).toContain("明确拒绝");
    expect(header.split("压缩进行中")).toHaveLength(2);
    expect(other.querySelector("header").textContent.split("压缩进行中")).toHaveLength(2);
    expect(other.textContent).not.toContain("明确拒绝");
  } finally { vi.restoreAllMocks(); await act(async () => otherRoot.unmount()); other.remove(); }
});

test("两个独立页面按同一 Session 记录显示独立共享命令卡", async () => {
  const other = document.createElement("div"); document.body.append(other);
  const otherRoot = createRoot(other);
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ revision: 0, sessions: ["a", "b"].map((sessionId) => ({ sessionId, createdAt: 1, updatedAt: 1, running: false, blank: false })) }) });
  await act(async () => otherRoot.render(<App />));
  fetch.mockClear();
  try {
    const { session, frames, add, start, finish, original } = sharedCompactionFixture();
    start("c1", "cp1");
    add({ type: "command/run", data: { commandId: "c2", name: "compact", source: { kind: "user" } } });
    add({ type: "command/done", data: { commandId: "c2", kind: "error", text: "助手忙碌" } });
    for (const connection of connections.slice(0, 2)) await sendFrame(connection, snapshot("a", frames));
    for (const page of [container, other]) {
      const cards = sharedCards(page);
      expect(cards[0].textContent).toContain("执行中");
      expect(cards[1].textContent).toContain("助手忙碌");
    }
    const before = frames.length;
    finish("c1", "cp1", "摘要一", original);
    const replay = new Session({ sessionId: "a", createdAt: 0 }, { seed: { kind: "restore", inheritedEventCount: 0, events: session.snapshot().events } });
    expect(replay.snapshot().events).toEqual(session.snapshot().events);
    for (const frame of frames.slice(before)) for (const connection of connections.slice(0, 2)) await sendFrame(connection, frame);
    for (const page of [container, other]) {
      const cards = sharedCards(page);
      expect(cards).toHaveLength(2);
      expect(cards[0].textContent).toContain("摘要一");
      expect(cards[0].querySelector("details summary").textContent).toBe("查看摘要");
      expect(cards[1].textContent).toContain("助手忙碌");
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally { await act(async () => otherRoot.unmount()); other.remove(); }
});

for (const outcome of ["success", "no-range"]) test(`两页保留 C1 并在重连后重放 C2 ${outcome}`, async () => {
  const other = document.createElement("div"); document.body.append(other);
  const otherRoot = createRoot(other);
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ revision: 0, sessions: ["a", "b"].map((sessionId) => ({ sessionId, createdAt: 1, updatedAt: 1, running: false, blank: false })) }) });
  await act(async () => otherRoot.render(<App />));
  fetch.mockClear();
  try {
    const { session, frames, add, start, finish, original } = sharedCompactionFixture();
    start("c1", "cp1");
    const checkpoint = finish("c1", "cp1", "摘要一", original);
    if (outcome === "success") start("c2", "cp2");
    else add({ type: "command/run", data: { commandId: "c2", name: "compact", source: { kind: "user" } } });
    for (const connection of connections.slice(0, 2)) await sendFrame(connection, snapshot("a", frames));
    for (const page of [container, other]) {
      const cards = sharedCards(page);
      expect(cards).toHaveLength(2);
      expect(cards[0].textContent).toContain("摘要一");
      expect(cards[1].textContent).toContain("执行中");
    }
    const before = frames.length;
    if (outcome === "success") {
      finish("c2", "cp2", "摘要二", checkpoint);
    } else {
      add({ type: "command/done", data: { commandId: "c2", kind: "success", text: "No compactable history yet." } });
    }
    const replay = new Session({ sessionId: "a", createdAt: 0 }, { seed: { kind: "restore", inheritedEventCount: 0, events: session.snapshot().events } });
    expect(replay.snapshot().events).toEqual(session.snapshot().events);
    for (const frame of frames.slice(before)) for (const connection of connections.slice(0, 2)) await sendFrame(connection, frame);
    const verify = page => {
      const cards = sharedCards(page);
      expect(cards).toHaveLength(2);
      expect(cards[0].textContent).toContain("摘要一");
      expect(cards[1].textContent).toContain(outcome === "success" ? "摘要二" : "No compactable history yet.");
    };
    for (const page of [container, other]) verify(page);
    await act(async () => { connections[0].onerror(); connections[1].onerror(); });
    for (const page of [container, other]) verify(page);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(connections).toHaveLength(4);
    for (const connection of connections.slice(2)) await sendFrame(connection, snapshot("a", frames));
    for (const page of [container, other]) verify(page);
    expect(fetch).not.toHaveBeenCalled();
  } finally { await act(async () => otherRoot.unmount()); other.remove(); }
});

for (const [status, text] of [[400, "请求无效"], [413, "正文过大"], [415, "媒体类型无效"]]) test(`两页中仅发起页显示 HTTP ${status} 入口拒绝`, async () => {
  const other = document.createElement("div"); document.body.append(other);
  const otherRoot = createRoot(other);
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ revision: 0, sessions: ["a", "b"].map((sessionId) => ({ sessionId, createdAt: 1, updatedAt: 1, running: false, blank: false })) }) });
  await act(async () => otherRoot.render(<App />));
  fetch.mockClear();
  try {
    for (const connection of connections.slice(0, 2)) await sendFrame(connection, snapshot("a"));
    fetch.mockResolvedValue({ status, json: async () => ({ commandId: null, result: { kind: "error", text } }) });
    const textarea = other.querySelector("textarea");
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(textarea, "/compact"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { other.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); await flush();
    expect(other.textContent).toContain(text);
    expect(container.textContent).not.toContain(text);
    for (const page of [container, other]) expect(page.querySelectorAll("article")).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { await act(async () => otherRoot.unmount()); other.remove(); }
});

test("两页观察 C2 运行时 C1 迟到 done 不覆盖当前状态", async () => {
  const other = document.createElement("div"); document.body.append(other);
  const otherRoot = createRoot(other);
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ revision: 0, sessions: ["a", "b"].map((sessionId) => ({ sessionId, createdAt: 1, updatedAt: 1, running: false, blank: false })) }) });
  await act(async () => otherRoot.render(<App />));
  fetch.mockClear();
  try {
    for (const connection of connections.slice(0, 2)) await sendFrame(connection, snapshot("a"));
    const { frames, add, start, finish, original } = sharedCompactionFixture();
    start("c1", "cp1");
    finish("c1", "cp1", "摘要一", original, false);
    const summarySeq = frames.find(frame => frame.event.type === "compaction/summary").event.seq;
    start("c2", "cp2");
    add({ type: "command/done", data: { commandId: "c1", kind: "success", sourceEventSeq: summarySeq } });
    for (const frame of frames) for (const connection of connections.slice(0, 2)) await sendFrame(connection, frame);
    for (const page of [container, other]) {
      expect(page.textContent).toContain("压缩进行中");
      expect(page.textContent).not.toContain("压缩命令已完成");
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally { await act(async () => otherRoot.unmount()); other.remove(); }
});

test("两页即时结算共享卡且其他命令不结束本地等待", async () => {
  const other = document.createElement("div"); document.body.append(other);
  const otherRoot = createRoot(other);
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ revision: 0, sessions: ["a", "b"].map((sessionId) => ({ sessionId, createdAt: 1, updatedAt: 1, running: false, blank: false })) }) });
  await act(async () => otherRoot.render(<App />));
  fetch.mockClear();
  try {
    await sendFrame(connections[0], snapshot("a"));
    await sendFrame(connections[1], snapshot("a"));
    fetch.mockImplementation(() => new Promise(() => {}));
    await enter("/compact");
    await act(async () => container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    const id = JSON.parse(fetch.mock.calls[0][1].body).compactionId;
    const { frames, add, start, finish, original } = sharedCompactionFixture();
    add({ type: "command/run", data: { commandId: "other", name: "compact", source: { kind: "user" } } });
    add({ type: "command/done", data: { commandId: "other", kind: "error", text: "另一命令忙碌" } });
    const before = frames.length;
    start("mine", id);
    finish("mine", id, "即时摘要", original);
    for (const frame of frames.slice(0, before)) for (const connection of connections.slice(0, 2)) await sendFrame(connection, frame);
    expect(container.textContent).toContain("正在提交压缩");
    for (const frame of frames.slice(before)) for (const connection of connections.slice(0, 2)) await sendFrame(connection, frame);
    for (const page of [container, other]) {
      const cards = sharedCards(page);
      expect(cards).toHaveLength(2);
      expect(cards[0].textContent).toContain("另一命令忙碌");
      expect(cards[1].textContent).toContain("即时摘要");
      expect(cards[1].textContent).toContain("已完成");
    }
    expect(container.textContent).not.toContain("正在提交压缩");
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { await act(async () => otherRoot.unmount()); other.remove(); }
});

for (const status of ["succeeded", "failed", "cancelled", "run-only"]) test(`继承命令缺 done 显示 ${status} 的可靠事实`, async () => {
  const parent = new Session({ sessionId: "parent", createdAt: 0 });
  parent.append({ type: "turn/start", data: { turn: 1 } });
  const original = parent.append({ type: "user/message", data: { id: "original", role: "user", source: { kind: "user" }, turn: 1, requestId: "r", content: [{ type: "text", text: "原文" }] }, surfaceOp: "append" });
  parent.append({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  parent.append({ type: "command/run", data: { commandId: "old", name: "compact", source: { kind: "user" } } });
  if (status !== "run-only") {
    parent.append({ type: "compaction/start", data: { compactionId: "cp", sourceCommandId: "old", turn: null } });
    if (status === "succeeded") {
      const summary = parent.append({ type: "compaction/summary", data: { compactionId: "cp", sourceCommandId: "old", summary: "继承摘要", shadowedRange: { start: original.seq, end: original.seq }, shadowedSeqs: [original.seq], route: { provider: "p", model: "m" } } });
      parent.append({ type: "user/message", data: { id: "checkpoint", role: "user", source: { kind: "compact", compactionId: "cp" }, sourceCommandId: "old", content: [{ type: "text", text: "继承摘要" }] }, surfaceOp: { op: "replace", start: original.seq, end: original.seq }, sourceEventSeqs: [original.seq, summary.seq] });
    }
    parent.append({ type: "compaction/end", data: { compactionId: "cp", sourceCommandId: "old", turn: null, status, ...(status === "succeeded" ? {} : { reason: "stopped" }) } });
  }
  const child = new Session({ sessionId: "a", createdAt: 1, isSeeded: true, parentSession: "parent" }, { seed: { kind: "fork", events: parent.snapshot().events } });
  const frames = child.snapshot().events.map(event => ({ type: "event", event }));
  await sendFrame(connections[0], { ...snapshot("a", frames), inheritedEventCount: child.inheritedEventCount });
  const card = [...container.querySelectorAll("article")].find(node => node.textContent.includes("/compact"));
  expect(card.textContent).toContain({ succeeded: "已压缩", failed: "压缩失败", cancelled: "压缩已取消", "run-only": "结果未记录" }[status]);
  if (status === "succeeded") expect(card.textContent).toContain("继承摘要");
  expect(container.textContent).not.toContain("压缩进行中");
  expect(fetch).not.toHaveBeenCalled();
});

for (const kind of ["error", "success"]) test(`关联 start 后 command/done(${kind}) 即时结束本地等待`, async () => {
  await sendFrame(connections[0], snapshot("a"));
  fetch.mockImplementation(() => new Promise(() => {}));
  await enter("/compact");
  await act(async () => container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const id = JSON.parse(fetch.mock.calls[0][1].body).compactionId;
  await sendFrame(connections[0], record(0, "command/run", { commandId: "other", name: "compact", source: { kind: "user" } }));
  await sendFrame(connections[0], record(1, "command/done", { commandId: "other", kind: "success", text: "No compactable history yet." }));
  expect(container.textContent).toContain("正在提交压缩");
  await sendFrame(connections[0], record(2, "command/run", { commandId: "mine", name: "compact", source: { kind: "user" } }));
  await sendFrame(connections[0], record(3, "compaction/start", { compactionId: id, sourceCommandId: "mine", turn: null }));
  await sendFrame(connections[0], record(4, "command/done", { commandId: "mine", kind, text: kind === "error" ? "命令失败" : "命令完成" }));
  expect(container.textContent).not.toContain("正在提交压缩");
  expect(container.textContent).not.toContain("压缩进行中");
  expect(container.textContent).toContain(kind === "error" ? "压缩命令失败" : "压缩命令已完成");
  expect(container.textContent).not.toContain("已压缩");
});
