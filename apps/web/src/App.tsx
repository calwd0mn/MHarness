import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  createSessionResponseSchema,
  promptResponseSchema,
} from "@mharness/session/contracts";
import { localConfig } from "../../../config/local.ts";
import {
  FollowController,
  type FollowState,
} from "./session/follow-controller.ts";
import {
  confirmFromRecords,
  makeSubmission,
  type Submission,
} from "./session/submission.ts";
import {
  browserStorage,
  loadDirectory,
  saveDirectory,
} from "./session/directory.ts";
import { lastTurn, messages } from "./session/view.ts";

const api = localConfig.apiPrefix;
const sessionPath = (id: string) => `${api}/sessions/${encodeURIComponent(id)}`;
const initialState: FollowState = {
  sessionId: null,
  status: "idle",
  records: [],
  inheritedEventCount: 0,
  cursor: -1,
  revision: 0,
  settledNodeIds: {},
};

/** 渲染会话目录、实时视图和消息操作。 */
export function App() {
  const [initialDirectory] = useState(() => loadDirectory(browserStorage()));
  const [sessions, setSessions] = useState<string[]>(initialDirectory.sessions);
  const [selected, setSelected] = useState<string | null>(
    initialDirectory.selected,
  );
  const [state, setState] = useState<FollowState>(initialState);
  const [submissions, setSubmissions] = useState<Record<string, Submission>>(
    {},
  );
  const submissionsRef = useRef(submissions);
  submissionsRef.current = submissions;
  const [text, setText] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const controller = useRef<FollowController | null>(null);
  useEffect(() => {
    const instance = new FollowController({
      connect(id, callbacks) {
        const source = new EventSource(`${sessionPath(id)}/follow`);
        source.onmessage = (event) => {
          try {
            callbacks.frame(JSON.parse(event.data) as unknown);
          } catch {
            callbacks.error();
          }
        };
        source.onerror = () => callbacks.error();
        return { close: () => source.close() };
      },
      onState(next) {
        setState(next);
        if (next.sessionId)
          setSubmissions((previous) => {
            const item = previous[next.sessionId!];
            if (!item) return previous;
            const confirmed = confirmFromRecords(
              item,
              next.records,
              next.inheritedEventCount,
            );
            return confirmed.status === item.status
              ? previous
              : { ...previous, [next.sessionId!]: confirmed };
          });
      },
    });
    controller.current = instance;
    return () => {
      instance.dispose();
      controller.current = null;
    };
  }, []);
  useEffect(() => {
    controller.current?.select(selected);
    setNotice("");
  }, [selected]);
  useEffect(() => {
    saveDirectory(browserStorage(), { sessions, selected });
  }, [sessions, selected]);
  async function createSession() {
    setCreating(true);
    setNotice("");
    try {
      const response = await fetch(`${api}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error();
      const { sessionId } = createSessionResponseSchema.parse(
        await response.json(),
      );
      setSessions((items) => [...items, sessionId]);
      setSelected(sessionId);
    } catch {
      setNotice("创建会话失败，请重试。");
    } finally {
      setCreating(false);
    }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    const id = selected;
    const content = text.trim();
    if (!id || !content) return;
    const item = makeSubmission(submissionsRef.current[id], content, () =>
      crypto.randomUUID(),
    );
    setSubmissions((previous) => ({ ...previous, [id]: item }));
    setText("");
    setNotice("");
    try {
      const response = await fetch(`${sessionPath(id)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: item.requestId,
          content: [{ type: "text", text: content }],
        }),
      });
      if (response.status === 409) {
        setSubmissions((previous) =>
          previous[id]?.requestId === item.requestId &&
          previous[id].status !== "accepted"
            ? { ...previous, [id]: { ...item, status: "busy" } }
            : previous,
        );
        if (selectedRef.current === id) {
          setText((current) => current || content);
          setNotice("助手正在处理，请等待或取消当前任务。");
        }
        return;
      }
      if (!response.ok) throw new Error();
      promptResponseSchema.parse(await response.json());
      setSubmissions((previous) =>
        previous[id]?.requestId === item.requestId
          ? { ...previous, [id]: { ...item, status: "accepted" } }
          : previous,
      );
    } catch {
      setSubmissions((previous) =>
        previous[id]?.requestId === item.requestId &&
        previous[id].status !== "accepted"
          ? { ...previous, [id]: { ...item, status: "uncertain" } }
          : previous,
      );
    }
  }
  async function cancel() {
    const id = selected;
    if (!id) return;
    try {
      const response = await fetch(`${sessionPath(id)}/cancel`, {
        method: "POST",
      });
      if (!response.ok) throw new Error();
      if (selectedRef.current === id) setNotice("已请求取消。");
    } catch {
      if (selectedRef.current === id) setNotice("取消请求失败，请重试。");
    }
  }
  const submission = selected ? submissions[selected] : undefined;
  // HTTP 确认不代表对应事件已到达，只有事件出现后才能移除占位。
  const confirmedRecord =
    submission &&
    confirmFromRecords(
      { ...submission, status: "sending" },
      state.records,
      state.inheritedEventCount,
    ).status === "accepted";
  const visibleMessages = state.sessionId === selected ? messages(state) : [];
  return (
    <main className="shell">
      <aside>
        <h1>MHarness</h1>
        <button onClick={() => void createSession()} disabled={creating}>
          ＋ 新建会话
        </button>
        <nav aria-label="会话">
          {sessions.map((id, index) => (
            <button
              key={id}
              className={selected === id ? "selected" : ""}
              onClick={() => setSelected(id)}
            >
              会话 {index + 1}
              <small>{id}</small>
            </button>
          ))}
        </nav>
      </aside>
      <section className="conversation">
        <header>
          <div>
            <h2>
              {selected
                ? `会话 ${sessions.indexOf(selected) + 1}`
                : "开始一个会话"}
            </h2>
            <p>
              {selected
                ? state.status === "ready"
                  ? (lastTurn(state.records) ?? "已连接")
                  : state.status === "syncing"
                    ? "正在同步"
                    : "同步失败"
                : "创建会话后即可发送消息"}
            </p>
          </div>
          {selected && <button onClick={() => void cancel()}>取消任务</button>}
        </header>
        <div className="messages" aria-live="polite">
          {state.status === "failed" && (
            <p className="error">
              {state.error}{" "}
              <button onClick={() => controller.current?.retry()}>
                重新同步
              </button>
            </p>
          )}
          {state.agentError && (
            <p className="error">执行错误：{state.agentError}</p>
          )}
          {visibleMessages.map((message) => (
            <article
              key={message.key}
              className={message.role === "你" ? "user" : "assistant"}
            >
              <strong>{message.role}</strong>
              <p>{message.text}</p>
              {message.note && <small>{message.note}</small>}
            </article>
          ))}
          {submission && !confirmedRecord && (
            <article className="user">
              <strong>你</strong>
              <p>{submission.text}</p>
              <small>
                {submission.status === "busy"
                  ? "未受理，请等待后重试"
                  : submission.status === "uncertain"
                    ? "发送结果未知，可重试"
                    : submission.status === "accepted"
                      ? "已受理，等待同步"
                      : "正在发送"}
              </small>
              {(submission.status === "uncertain" ||
                submission.status === "busy") && (
                <button onClick={() => setText(submission.text)}>
                  重试此消息
                </button>
              )}
            </article>
          )}
          {notice && <p role="status">{notice}</p>}
        </div>
        <form onSubmit={(event) => void send(event)}>
          <label htmlFor="prompt">消息</label>
          <textarea
            id="prompt"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="输入消息…"
            disabled={!selected}
          />
          <button
            type="submit"
            disabled={
              !selected || !text.trim() || submission?.status === "sending"
            }
          >
            发送
          </button>
        </form>
      </section>
    </main>
  );
}
