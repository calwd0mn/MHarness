import { Button } from "../../components/ui/Button.tsx";
import { isValidElement, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
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
  return <div className={styles.code}><Button type="button" onClick={() => void copy()}>复制</Button><span role="status">{feedback}</span><pre>{children}</pre></div>;
}

const components: Components = {
  a: ({ href, children }) => href ? <a href={href}>{children}</a> : <>{children}</>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  img: ({ alt }) => <>{alt}</>,
};

/** 将助手正文解析为安全 Markdown，并为代码块提供复制反馈。
 * @param props - text 为助手正文；原始 HTML 不执行，仅允许 HTTP(S)、mailto 和页内链接。
 * @returns 可阅读的 Markdown 内容及代码复制操作。
 */
export function AssistantMarkdown({ text }: { text: string }) {
  return <div className={styles.markdown}><Markdown skipHtml urlTransform={(url) => safeLink(url) ? url : ""} components={components}>{text}</Markdown></div>;
}
