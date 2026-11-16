// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";

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
