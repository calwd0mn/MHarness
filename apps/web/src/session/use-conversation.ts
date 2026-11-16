import { useApprovals } from "./use-approvals.ts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  createSessionResponseSchema,
  promptResponseSchema,
} from "@mharness/session/contracts";
import { localConfig } from "../../../../config/local.ts";
import {
  FollowController,
  type FollowState,
} from "./follow-controller.ts";
import {
  confirmFromRecords,
  makeSubmission,
  type Submission,
} from "./submission.ts";
import {
  browserStorage,
  loadDirectory,
  saveDirectory,
} from "./directory.ts";
import { lastTurn, messages } from "./view.ts";


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

/** 管理选中会话、订阅、草稿及异步动作，卸载时释放订阅。
 * @returns 当前页面状态和动作；草稿只在页面存活期间按会话保存，切换只释放订阅。
 */
export function useConversation() {
  const approvals = useApprovals();
  const [initialDirectory] = useState(() => loadDirectory(browserStorage()));
  const [sessions, setSessions] = useState<string[]>(initialDirectory.sessions);
  const [selected, setSelectedState] = useState<string | null>(
    initialDirectory.selected,
  );
  const selectionRevision = useRef(0);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function setSelected(id: string | null) {
    selectionRevision.current++;
    setSelectedState(id);
  }
  const [state, setState] = useState<FollowState>(initialState);
  const [submissions, setSubmissions] = useState<Record<string, Submission>>(
    {},
  );
  const submissionsRef = useRef(submissions);
  submissionsRef.current = submissions;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftRevisions = useRef<Record<string, number>>({});
  const text = selected ? (drafts[selected] ?? "") : "";
  function setText(value: string | ((current: string) => string)) {
    if (!selected) return;
    draftRevisions.current[selected] = (draftRevisions.current[selected] ?? 0) + 1;
    setDrafts((previous) => ({ ...previous, [selected]: typeof value === "function" ? value(previous[selected] ?? "") : value }));
  }
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
        if (next.sessionId) approvals.observe(next.sessionId, next.records);
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
    const revision = selectionRevision.current;
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
      if (!mounted.current) return;
      setSessions((items) => [...items, sessionId]);
      if (selectionRevision.current === revision) setSelectedState(sessionId);
    } catch {
      if (mounted.current && selectionRevision.current === revision) setNotice("创建会话失败，请重试。");
    } finally {
      if (mounted.current) setCreating(false);
    }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    const id = selected;
    const content = text;
    if (!id || !content.trim()) return;
    const item = makeSubmission(submissionsRef.current[id], content, () =>
      crypto.randomUUID(),
    );
    setSubmissions((previous) => ({ ...previous, [id]: item }));
    const draftRevision = draftRevisions.current[id] ?? 0;
    setDrafts((previous) => ({ ...previous, [id]: "" }));
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
        if ((draftRevisions.current[id] ?? 0) === draftRevision && submissionsRef.current[id]?.requestId === item.requestId && submissionsRef.current[id]?.status !== "accepted")
          setDrafts((previous) => ({ ...previous, [id]: content }));
        if (selectedRef.current === id) {
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
  return { approvals, sessions, selected, setSelected, state, submissions, text, setText, notice, creating, controller, createSession, send, cancel, submission, confirmedRecord, visibleMessages };
}


