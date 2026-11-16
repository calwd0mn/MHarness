import { AssistantMarkdown } from "./AssistantMarkdown.tsx";
import { Button } from "../../components/ui/Button.tsx";
import { lastTurn } from "../../session/view.ts";
import type { useConversation } from "../../session/use-conversation.ts";


/** 显示会话目录和创建入口。 */
export function SessionNavigation({ sessions, selected, setSelected, creating, createSession }: Pick<ReturnType<typeof useConversation>, "sessions" | "selected" | "setSelected" | "creating" | "createSession">) {
  return (
    <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
          <h1>MHarness</h1>
        </div>
        <button
          className="new-session"
          onClick={() => void createSession()}
          disabled={creating}
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 3v10M3 8h10"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          新建会话
        </button>
        <div className="session-directory">
          <h2 className="section-label">会话</h2>
          <nav className="session-list" aria-label="会话">
            {sessions.map((id, index) => (
              <button
                key={id}
                className={selected === id ? "selected" : ""}
                aria-current={selected === id ? "page" : undefined}
                onClick={() => setSelected(id)}
              >
                会话 {index + 1}
                <small>{id}</small>
              </button>
            ))}
          </nav>
          {sessions.length === 0 && <p className="directory-empty">还没有会话</p>}
        </div>
      </aside>
  );
}

/** 显示所选会话和运行状态。 */
export function ConversationHeader({ selected, sessions, state, cancel }: Pick<ReturnType<typeof useConversation>, "selected" | "sessions" | "state" | "cancel">) {
  return (
    <header className="conversation-header">
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
          {selected && <Button onClick={() => void cancel()}>取消任务</Button>}
        </header>
  );
}

/** 显示当前会话消息与同步反馈。 */
export function MessageStream({ visibleMessages, submission, state, selected, confirmedRecord, notice, controller, setText }: Pick<ReturnType<typeof useConversation>, "visibleMessages" | "submission" | "state" | "selected" | "confirmedRecord" | "notice" | "controller" | "setText">) {
  return (
    <div className="messages" aria-live="polite">
          {visibleMessages.length === 0 &&
            !submission &&
            !state.agentError &&
            (!selected ||
              (state.sessionId === selected && state.status === "ready")) && (
              <div className="empty-state">
                <h3>{selected ? "发送第一条消息" : "开始一个会话"}</h3>
                <p>
                  {selected
                    ? "在下方输入内容，开始本次对话。"
                    : "点击「新建会话」，开始与助手对话。"}
                </p>
              </div>
            )}
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
              {message.reasoning && <details><summary>推理</summary><p>{message.reasoning}</p></details>}
              {message.role === "助手" ? <AssistantMarkdown text={message.text} /> : <p>{message.text}</p>}
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
                <Button onClick={() => setText(submission.text)}>
                  重试此消息
                </Button>
              )}
            </article>
          )}
          {notice && <p role="status">{notice}</p>}
        </div>
  );
}

/** 显示当前会话的受控输入区。 */
export function Composer({ text, setText, selected, submission, send }: Pick<ReturnType<typeof useConversation>, "text" | "setText" | "selected" | "submission" | "send">) {
  return (
    <form className="composer" onSubmit={(event) => void send(event)}>
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
  );
}


