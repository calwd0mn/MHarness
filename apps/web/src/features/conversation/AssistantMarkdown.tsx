import { isValidElement, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import styles from "./AssistantMarkdown.module.css";

function safeLink(url: string): boolean {
  return /^(https?:\/\/|mailto:|#)/i.test(url);
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [feedback, setFeedback] = useState("");
  const code = isValidElement<{ children?: ReactNode }>(children) && typeof children.props.children === "string" ? children.props.children : "";
  async function copy() {
    try { await navigator.clipboard.writeText(code); setFeedback("已复制"); }
    catch { setFeedback("复制失败"); }
  }
  return <div className={styles.code}><button type="button" onClick={() => void copy()}>复制</button><span role="status">{feedback}</span><pre>{children}</pre></div>;
}

/** 将助手正文解析为安全 Markdown，并为代码块提供复制反馈。 */
export function AssistantMarkdown({ text }: { text: string }) {
  return <div className={styles.markdown}><Markdown skipHtml urlTransform={(url) => safeLink(url) ? url : ""} components={{
    a: ({ href, children }) => href ? <a href={href}>{children}</a> : <>{children}</>,
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    img: ({ alt }) => <>{alt}</>,
  }}>{text}</Markdown></div>;
}
