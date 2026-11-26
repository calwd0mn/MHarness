import { useApprovals } from "./use-approvals.ts";
import { useCompaction } from "./use-compaction.ts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  createSessionResponseSchema,
  promptResponseSchema,
  rawSessionHistorySchema,
  sessionCreationPendingSchema,
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
import { compareDirectoryEntries, DirectoryController, type DirectoryEntry, type DirectoryState } from "./directory-controller.ts";


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

/**
 * 管理会话目录、选中会话及草稿。目录同步失败时保留已展示目录和恢复提示，卸载时释放两条订阅。
 * @returns 页面状态和动作。目录重试独立于选中会话的 follow，草稿在页面存活期间按会话保存。
 */
export function useConversation() {
  const approvals = useApprovals();
  const [initialDirectory] = useState(() => loadDirectory(browserStorage()));
  const [directory, setDirectory] = useState<{ entries: DirectoryEntry[]; selected: string | null; protectedIds: Record<string, number> }>({ entries: [], selected: null, protectedIds: {} });
  const directoryRef = useRef(directory);
  const hint = useRef(initialDirectory.selected);
  const initialized = useRef(false);
  const creationSequence = useRef(0);
  const removedIds = useRef(new Set<string>());
  const creationInFlight = useRef(false);
  const [directoryFailed, setDirectoryFailed] = useState(false);
  const directoryController = useRef<DirectoryController | null>(null);
  function updateDirectory(next: typeof directory) { directoryRef.current = next; setDirectory(next); }
  const selected = directory.selected;
  const sessions = directory.entries.filter((entry) => !entry.blank || entry.sessionId === selected || Object.hasOwn(directory.protectedIds, entry.sessionId)).map((entry) => entry.sessionId);
  const selectionRevision = useRef(0);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function setSelected(id: string | null) {
    const current = directoryRef.current;
    if (id !== null && !current.entries.some((entry) => entry.sessionId === id)) return;
    selectionRevision.current++;
    hint.current = id;
    updateDirectory({ ...current, selected: id });
    saveDirectory(browserStorage(), { sessions: current.entries.map((entry) => entry.sessionId), selected: id });
  }
  const [state, setState] = useState<FollowState>(initialState);
  const compaction = useCompaction(selected, state, sessionPath);
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
  const [pendingCreationChecks, setPendingCreationChecks] = useState<{ id: string; sequence: number }[]>([]);
  const pendingCreations = pendingCreationChecks.map(({ id }) => id);
  function forgetPendingCreation(id: string) {
    setPendingCreationChecks((items) => items.filter((item) => item.id !== id));
  }
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
    const instance = new DirectoryController({
      connect(callbacks) {
        const source = new EventSource(`${api}/session-directory/events`);
        source.onmessage = (event) => { try { callbacks.frame(JSON.parse(event.data) as unknown); } catch { callbacks.error(); } };
        source.onerror = () => callbacks.error();
        return { close: () => source.close() };
      },
      async read(signal) {
        const response = await fetch(`${api}/sessions`, { cache: "no-store", signal });
        if (!response.ok) throw new Error("目录读取失败");
        return response.json() as Promise<unknown>;
      },
      onSnapshotStart: () => creationSequence.current,
      onFailure: () => setDirectoryFailed(true),
      onCoveredRemoval(id) {
        if (creationInFlight.current) removedIds.current.add(id);
        forgetPendingCreation(id);
      },
      onState(next: DirectoryState) {
        const current = directoryRef.current;
        const protectedIds = { ...current.protectedIds };
        const listedIds = new Set(next.sessions.map((entry) => entry.sessionId));
        const withdrawnIds = new Set(next.removed);
        for (const id of next.removed) { if (creationInFlight.current) removedIds.current.add(id); delete protectedIds[id]; }
        for (const entry of next.sessions) { removedIds.current.delete(entry.sessionId); delete protectedIds[entry.sessionId]; }
        if (next.snapshotToken !== undefined) {
          for (const [id, sequence] of Object.entries(protectedIds)) if (sequence <= next.snapshotToken) delete protectedIds[id];
        }
        const entries = [...next.sessions];
        for (const entry of current.entries) if (Object.hasOwn(protectedIds, entry.sessionId) && !entries.some((item) => item.sessionId === entry.sessionId)) entries.push(entry);
        entries.sort(compareDirectoryEntries);
        const desired = initialized.current ? current.selected : (current.selected ?? hint.current);
        const selected = desired && entries.some((entry) => entry.sessionId === desired) ? desired : null;
        if (desired && !selected && loadDirectory(browserStorage()).selected === desired) saveDirectory(browserStorage(), { sessions: [], selected: null });
        initialized.current = true;
        updateDirectory({ entries, selected, protectedIds });
        const readStartedAt = next.snapshotToken;
        setPendingCreationChecks((items) => items.filter(({ id, sequence }) =>
          !withdrawnIds.has(id) && (readStartedAt === undefined || sequence > readStartedAt || listedIds.has(id)),
        ));
        setDirectoryFailed(false);
      },
    });
    directoryController.current = instance; instance.start();
    return () => { instance.dispose(); directoryController.current = null; };
  }, []);

  function confirmCreation(sessionId: string, revision: number) {
    forgetPendingCreation(sessionId);
    const current = directoryRef.current;
    const exists = current.entries.some((entry) => entry.sessionId === sessionId);
    const now = Date.now();
    const entries = exists ? current.entries : [
      ...current.entries,
      { sessionId, createdAt: now, updatedAt: now, blank: true, running: false },
    ].sort(compareDirectoryEntries);
    const protectedIds = exists ? current.protectedIds : { ...current.protectedIds, [sessionId]: ++creationSequence.current };
    const selected = selectionRevision.current === revision ? sessionId : current.selected;
    updateDirectory({ entries, selected, protectedIds });
    if (selectionRevision.current === revision) { hint.current = sessionId; saveDirectory(browserStorage(), { sessions: entries.map((entry) => entry.sessionId), selected }); }
  }

  async function createSession() {
    if (creating) return;
    const revision = selectionRevision.current;
    setCreating(true);
    creationInFlight.current = true;
    removedIds.current.clear();
    setNotice("");
    try {
      const response = await fetch(`${api}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (response.status === 503) {
        const result = sessionCreationPendingSchema.parse(await response.json());
        if (mounted.current && !removedIds.current.has(result.sessionId)) {
          const pending = { id: result.sessionId, sequence: ++creationSequence.current };
          setPendingCreationChecks((items) => [...items, pending]);
        }
        return;
      }
      if (!response.ok) throw new Error();
      const { sessionId } = createSessionResponseSchema.parse(
        await response.json(),
      );
      if (!mounted.current) return;
      confirmCreation(sessionId, revision);
    } catch {
      if (mounted.current && selectionRevision.current === revision) setNotice("创建会话失败，请重试。");
    } finally {
      creationInFlight.current = false;
      removedIds.current.clear();
      if (mounted.current) setCreating(false);
    }
  }

  async function retryCreationCheck(sessionId: string) {
    if (creating || !pendingCreations.includes(sessionId)) return;
    const revision = selectionRevision.current;
    setCreating(true);
    setNotice("");
    try {
      const response = await fetch(sessionPath(sessionId), { cache: "no-store" });
      if (!mounted.current) return;
      if (response.status === 404 && (await response.json())?.code === "session_not_found") {
        if (!mounted.current) return;
        forgetPendingCreation(sessionId);
        setNotice("创建会话失败，请重试。");
        return;
      }
      if (!response.ok) throw new Error();
      const history = rawSessionHistorySchema.parse(await response.json());
      if (history.sessionId !== sessionId) throw new Error();
      if (mounted.current) confirmCreation(sessionId, revision);
    } catch {
      if (mounted.current) setNotice("暂时无法确认会话是否已保存，请重试核实。");
    } finally {
      if (mounted.current) setCreating(false);
    }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    const id = selected;
    const content = text;
    if (!id || !content.trim()) return;
    if (content.trim() === "/compact") {
      if (compaction.submit(id)) {
        setDrafts((previous) => ({ ...previous, [id]: "" }));
        setNotice("");
      }
      return;
    }
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
  return { approvals, sessions, selected, directoryFailed, retryDirectory: () => directoryController.current?.retry(), setSelected, state, submissions, text, setText, notice, creating, controller, createSession, pendingCreations, retryCreationCheck, send, cancel, submission, confirmedRecord, visibleMessages, compaction };
}
