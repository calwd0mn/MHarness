import type { ButtonHTMLAttributes } from "react";
import styles from "./Button.module.css";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean };

/** 渲染标准按钮；忙碌期间禁用操作并向辅助技术公开状态。 */
export function Button({ busy = false, disabled, children, className, ...props }: ButtonProps) {
  return <button {...props} className={[styles.button, className].filter(Boolean).join(" ")} disabled={disabled || busy} aria-busy={busy || undefined}>{children}{busy && "（处理中）"}</button>;
}
