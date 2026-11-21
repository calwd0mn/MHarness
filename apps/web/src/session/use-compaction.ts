import { useEffect, useRef, useState } from "react";
import { compactErrorSchema, compactRejectionSchema, compactResponseSchema } from "@mharness/session/contracts";
import type { FollowState } from "./follow-controller.ts";

type Status = "pending" | "unknown" | "running" | "succeeded" | "completed" | "command_error" | "no_safe_range" | "cancelled" | "failed" | "interrupted" | "busy" | "conflict" | "unavailable" | "invalid" | "not_found";
type Submission = { token: object; id: string; cursor: number | null; status: Status; observedTerminal?: boolean; rejectionText?: string; timer?: ReturnType<typeof setTimeout> };

const labels: Record<Status, string> = {
  pending: "正在提交压缩", unknown: "压缩结果未知", running: "压缩进行中", succeeded: "已压缩",
  completed: "压缩命令已完成", command_error: "压缩命令失败",
  no_safe_range: "没有可压缩范围", cancelled: "压缩已取消", failed: "压缩失败", interrupted: "压缩已中断",
  busy: "压缩未受理：助手忙碌", conflict: "压缩未受理：标识已使用", unavailable: "压缩功能暂不可用",
  invalid: "压缩请求无效", not_found: "会话不存在",
};

function observed(state: FollowState, id?: string, after = -1): { status: Status; compactionId: string } | undefined {
  const starts = new Map<string, number>();
  let currentCommand: string | undefined;
  let currentCompaction: string | undefined;
  let latest: Status | undefined;
  for (const { event } of state.records) {
    if (event.seq < state.inheritedEventCount || event.seq <= after) continue;
    if (event.type === "compaction/start" && event.data.turn === null && (!id || event.data.compactionId === id)) {
      starts.set(event.data.compactionId, event.seq);
      currentCompaction = event.data.compactionId;
      currentCommand = event.data.sourceCommandId;
      latest = "running";
    } else if (event.type === "compaction/end" && event.data.turn === null && event.data.compactionId === currentCompaction && starts.has(event.data.compactionId)) {
      latest = event.data.status;
      starts.delete(event.data.compactionId);
    } else if (event.type === "command/done" && event.data.commandId === currentCommand && latest === "running") {
      latest = event.data.kind === "success" ? "completed" : "command_error";
    }
  }
  // 断线期间仍可确认已收到的终态，但未闭合的开始记录无法证明维护仍在运行。
  if (latest === "running" && state.status !== "ready") return undefined;
  return latest && currentCompaction !== undefined ? { status: latest, compactionId: currentCompaction } : undefined;
}

/**
 * 管理各会话手动压缩提交并按压缩与命令关联观察状态；已确认结算的本地任务不会因迟到开始记录显示为活动，HTTP 终态身份保留至该控制器卸载。观察超时只结束本地等待，不取消或重发远端任务。
 * @param selected - 当前选中的会话；空值时不显示维护状态。
 * @param state - follow 已安装窗口；重连或同步失败期间仍可用当前会话保留的终态恢复结果，新提交仅在就绪时记录起点。
 * @param path - 生成会话 HTTP 路径。
 * @returns 提交动作、本页提交状态和独立的共享活动状态标签；提交返回 false 表示已有本地请求正在等待。
 */
export function useCompaction(selected: string | null, state: FollowState, path: (id: string) => string) {
  const items = useRef<Record<string, Submission>>({});
  const httpTerminals = useRef(new Map<string, Set<string>>());
  const [revision, setRevision] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; for (const item of Object.values(items.current)) clearTimeout(item.timer); }; }, []);
  function update(sessionId: string, token: object, status: Status) {
    const item = items.current[sessionId];
    if (!mounted.current || !item || item.token !== token) return;
    if (item.observedTerminal && (status === "unknown" || status === "succeeded" || status === "no_safe_range" || status === "cancelled" || status === "failed")) return;
    if (status === "unknown" && item.status !== "pending" && item.status !== "unknown") return;
    item.status = status;
    if (status !== "pending") { clearTimeout(item.timer); item.timer = undefined; }
    setRevision((value) => value + 1);
  }
  function submit(sessionId: string): boolean {
    const previous = items.current[sessionId];
    if (previous?.status === "pending") return false;
    if (previous) clearTimeout(previous.timer);
    const item: Submission = {
      token: {}, id: crypto.randomUUID(),
      cursor: state.sessionId === sessionId && state.status === "ready" ? state.cursor : null,
      status: "pending",
    };
    items.current[sessionId] = item;
    item.timer = setTimeout(() => update(sessionId, item.token, "unknown"), 5000);
    setRevision((value) => value + 1);
    void (async () => {
      try {
        const response = await fetch(`${path(sessionId)}/compact`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ compactionId: item.id }),
        });
        const value: unknown = await response.json();
        if (response.status === 200) {
          const parsed = compactResponseSchema.safeParse(value);
          if (parsed.success && parsed.data.compactionId === item.id) {
            if (mounted.current) {
              const terminalIds = httpTerminals.current.get(sessionId) ?? new Set<string>();
              terminalIds.add(item.id);
              httpTerminals.current.set(sessionId, terminalIds);
              setRevision((revision) => revision + 1);
            }
            update(sessionId, item.token, parsed.data.status);
          } else update(sessionId, item.token, "unknown");
          return;
        }
        if (response.status === 400 || response.status === 413 || response.status === 415) {
          const rejection = compactRejectionSchema.safeParse(value);
          if (rejection.success && rejection.data.commandId === null) {
            item.rejectionText = rejection.data.result.text;
            update(sessionId, item.token, "invalid");
            return;
          }
        }
        if (response.status === 409) {
          const rejection = compactRejectionSchema.safeParse(value);
          if (rejection.success && rejection.data.commandId !== null) {
            item.rejectionText = rejection.data.result.text;
            update(sessionId, item.token, "busy");
            return;
          }
        }
        const parsed = compactErrorSchema.safeParse(value);
        const code = parsed.success ? parsed.data.code : undefined;
        const status: Status = response.status === 404 && code === "session/not-found" ? "not_found"
            : response.status === 409 && code === "compaction_id_conflict" ? "conflict"
                : response.status === 503 && code === "compaction_unavailable" ? "unavailable" : "unknown";
        update(sessionId, item.token, status);
      } catch { update(sessionId, item.token, "unknown"); }
    })();
    return true;
  }
  const item = selected ? items.current[selected] : undefined;
  const visibleState = selected !== null && state.sessionId === selected ? state : undefined;
  const evidence = item && item.cursor !== null && visibleState ? observed(visibleState, item.id, item.cursor)?.status : undefined;
  useEffect(() => {
    if (selected && item && evidence && evidence !== "running" && (item.status === "pending" || item.status === "unknown")) {
      update(selected, item.token, evidence);
      item.observedTerminal = true;
    }
  }, [selected, item, evidence]);
  const activity = visibleState ? observed(visibleState) : undefined;
  const status = item ? ((item.status === "unknown" || item.status === "pending") && evidence ? evidence : item.status) : activity?.status;
  const settledActivity = activity && selected && (httpTerminals.current.get(selected)?.has(activity.compactionId)
    || (item?.id === activity.compactionId && item.observedTerminal));
  void revision;
  return { submit, label: status ? ((status === "invalid" || status === "busy") && item?.rejectionText ? item.rejectionText : labels[status]) : undefined,
    activityLabel: activity?.status === "running" && status !== "running" && !settledActivity ? labels.running : undefined };
}
