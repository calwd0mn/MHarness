import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./theme.css";
import "./style.css";

const frame = (seq: number, type: string, data: object, extra: object = {}) => ({ type: "event", event: { seq, time: seq + 1, type, data, ...extra } });
const records = [
  frame(0, "turn/start", { turn: 1 }),
  frame(1, "step/start", { turn: 1, step: 1 }),
  frame(2, "user/message", { id: "u", role: "user", source: { kind: "user" }, turn: 1, requestId: "r", content: [{ type: "text", text: "请解释这段长内容并执行示例工具。" }] }, { surfaceOp: "append" }),
  frame(3, "assistant/message", { turn: 1, step: 1, message: { id: "m", role: "assistant", source: { provider: "fixture", model: "fixture" }, content: [{ type: "reasoning", text: "这是隔离夹具的推理内容。" }, { type: "text", text: `# 会话阅读体验\n\n${"这是一段用于检查换行与滚动的长文本。".repeat(40)}\n\n\`\`\`ts\nconst example = "fixture";\n\`\`\`` }, { type: "tool-call", id: "call", name: "示例工具", arguments: '{"query":"这是很长的工具参数"}' }] }, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true }, { surfaceOp: "append" }),
  frame(4, "tool/call", { turn: 1, step: 1, callId: "call", name: "示例工具", arguments: '{"query":"这是很长的工具参数"}' }),
  frame(5, "tool/operation", { turn: 1, step: 1, callId: "call", operationId: "op", toolName: "示例工具", toolVersion: "1.0", validatedArgs: { query: "隔离夹具" } }),
  frame(6, "approval/asked", { id: "approval", operationId: "op", toolName: "示例工具", reason: "隔离审批示例" }),
];
const mode = new URLSearchParams(location.search).get("theme");
if (mode === "light" || mode === "dark") {
  const light = { "--mh-workspace": "#fff", "--mh-sidebar": "#f9fafb", "--mh-surface": "#fff", "--mh-surface-muted": "#f5f6f7", "--mh-text": "#0f1115", "--mh-text-secondary": "#61666b", "--mh-text-muted": "#727780", "--mh-line": "rgb(0 0 0 / 8%)", "--mh-stroke": "rgb(0 0 0 / 14%)", "--mh-hover": "rgb(38 49 72 / 6%)", "--mh-active": "rgb(38 49 72 / 10%)", "--mh-primary": "#0f1115", "--mh-primary-hover": "#43454a", "--mh-on-primary": "#fff", "--mh-focus": "#4176e6", "--mh-error": "#b42318", "--mh-error-surface": "#fff4f2", "--mh-selection": "#e4edfd" };
  const dark = { "--mh-workspace": "#232324", "--mh-sidebar": "#1b1b1c", "--mh-surface": "#2c2c2e", "--mh-surface-muted": "#353638", "--mh-text": "#f9fafb", "--mh-text-secondary": "#cfd3d6", "--mh-text-muted": "#adb2b8", "--mh-line": "rgb(255 255 255 / 8%)", "--mh-stroke": "rgb(255 255 255 / 16%)", "--mh-hover": "rgb(255 255 255 / 8%)", "--mh-active": "rgb(255 255 255 / 14%)", "--mh-primary": "#f9fafb", "--mh-primary-hover": "#ebeef2", "--mh-on-primary": "#0f1115", "--mh-focus": "#83aaff", "--mh-error": "#ffaaa2", "--mh-error-surface": "#3a2424", "--mh-selection": "#34415b" };
  document.documentElement.style.colorScheme = mode;
  for (const [name, value] of Object.entries(mode === "light" ? light : dark)) document.documentElement.style.setProperty(name, value);
}
localStorage.setItem("mharness.session-directory.v1", JSON.stringify({ sessions: ["fixture"], selected: "fixture" }));
class FixtureSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    const id = decodeURIComponent(url.split("/").at(-2) ?? "fixture");
    const windowRecords = id === "fixture" ? records : [];
    queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "snapshot", sessionId: id, inheritedEventCount: 0, cursor: windowRecords.length - 1, records: windowRecords, assistantStream: { revision: 0 } }) })));
  }
  close() {}
}
Object.defineProperty(window, "EventSource", { value: FixtureSource, configurable: true });
let created = 0;
window.fetch = async (input, init) => {
  const url = String(input);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as { outcome?: string } : {};
  const payload = url.endsWith("/sessions") ? { sessionId: `fixture-${++created}` } : url.includes("/decision") ? { id: "approval", outcome: body.outcome } : { accepted: true };
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
};
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
