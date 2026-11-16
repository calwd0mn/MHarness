import type { ButtonHTMLAttributes } from "react";
import styles from "./Button.module.css";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean };

/** 渲染标准按钮；忙碌期间禁用操作并向辅助技术公开状态。
 * @param props - 原生按钮属性；busy 为真时保留按钮尺寸并显示处理中。
 * @returns 可用于表单和普通操作的按钮。
 */
export function Button({ busy = false, disabled, children, className, ...props }: ButtonProps) {
  return <button {...props} className={[styles.button, className].filter(Boolean).join(" ")} disabled={disabled || busy} aria-busy={busy || undefined}><span className={busy ? styles.labelBusy : undefined}>{children}</span>{busy && <span className={styles.busy}>处理中</span>}</button>;
}
