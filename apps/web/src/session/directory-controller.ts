import { sessionDirectoryFrameSchema, sessionDirectorySnapshotSchema, type SessionDirectoryMutation, type SessionSummary } from "@mharness/session/contracts";

/** 目录摘要及仅在本页收到的执行错误。 */
export type DirectoryEntry = SessionSummary & { lastAgentError?: string };
/** 已连续合并的目录及本次合并中有效撤回的标识。 */
export interface DirectoryState {
  revision: number;
  sessions: DirectoryEntry[];
  /** 本次确认缺失的先前可见项或收到撤回的项，供调用方对账。 */
  removed: string[];
  /** 本次有效撤回，不包含仅由快照缺项推断的条目。 */
  withdrawn?: string[];
  /** 仅安装快照时携带读取开始时的调用方令牌。 */
  snapshotToken?: number;
  /** 错误帧只更新错误信息，不确认目录成员关系。 */
  errorOnly?: boolean;
}
interface Options {
  /** 建立订阅；关闭订阅不得取消后端运行。 */
  connect(callbacks: { frame(value: unknown): void; error(): void }): { close(): void };
  /** 读取完整快照，signal 仅取消当前代次的读取。 */
  read(signal: AbortSignal): Promise<unknown>;
  /** 收到完整合并结果；读取中保留上一次结果。 */
  onState(state: DirectoryState): void;
  /** 目录进度已覆盖迟到的撤回且该会话仍缺失时，通知调用方对账本地创建条目。 */
  onCoveredRemoval?(sessionId: string): void;
  /** 读取失败后调用，等待调用方主动重试。 */
  onFailure?(): void;
  /** 快照读取开始时捕获调用方对账令牌。 */
  onSnapshotStart?(): number;
  /** 安排断线或缺号重连，并返回取消函数。 */
  schedule?(callback: () => void): () => void;
}
interface Generation {
  abort: AbortController;
  connection?: { close(): void };
  ready: boolean;
  installed: boolean;
  buffer: SessionDirectoryMutation[];

  token?: number;
}

function apply(state: DirectoryState, frames: readonly SessionDirectoryMutation[]): DirectoryState | null {
  const entries = new Map(state.sessions.map((item) => [item.sessionId, item]));
  const removed = new Set(state.removed);
  const withdrawn = new Set(state.withdrawn);
  let revision = state.revision;
  for (const frame of frames) {
    if (frame.revision <= revision) continue;
    if (frame.revision !== revision + 1) return null;
    revision = frame.revision;
    if (frame.type === "api-session/added") {
      const previous = entries.get(frame.summary.sessionId);
      entries.set(frame.summary.sessionId, previous?.lastAgentError !== undefined
        ? { ...frame.summary, lastAgentError: previous.lastAgentError }
        : frame.summary);
    } else if (frame.type === "api-session/removed") {
      entries.delete(frame.sessionId);
      removed.add(frame.sessionId);
      withdrawn.add(frame.sessionId);
    } else {
      const entry = entries.get(frame.sessionId);
      if (!entry) continue;
      if (frame.type === "api-session/updated") entries.set(frame.sessionId, { ...entry, blank: false });
      else if (frame.type === "api-session/status") entries.set(frame.sessionId, { ...entry, running: frame.running });
      else entries.set(frame.sessionId, { ...entry, updatedAt: Math.max(entry.updatedAt, frame.updatedAt) });
    }
  }
  return {
    ...state,
    revision,
    sessions: [...entries.values()].sort(compareDirectoryEntries),
    removed: [...removed].filter((id) => !entries.has(id)),
    withdrawn: [...withdrawn].filter((id) => !entries.has(id)),
  };
}

/**
 * 按活动时间降序比较目录项，并以会话 ID 的字典序消除并列。
 * @param a - 当前比较的第一项。
 * @param b - 当前比较的第二项。
 * @returns 第一项应排在第二项之前时返回负数，之后时返回正数，同序时返回零。
 */
export function compareDirectoryEntries(a: DirectoryEntry, b: DirectoryEntry): number {
  return b.updatedAt - a.updatedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);
}

/** 维护独立目录订阅，只有快照及其连续后续变更合并后才发布。 */
export class DirectoryController {
  private generation: Generation | undefined;
  private state: DirectoryState | undefined;
  private cancelTimer: (() => void) | undefined;
  private started = false;
  private disposed = false;
  private readonly options: Options;
  /**
   * 创建独立于聊天 follow 的目录控制器；首次订阅由调用方启动。
   * @param options - SSE 与 GET 适配器、结果回调及可选重连调度。
   */
  constructor(options: Options) { this.options = options; }
  /** 建立目录订阅，等待 ready 后才读取快照；重复调用不会建立第二条连接。 */
  start(): void {
    if (!this.started) this.retry();
  }
  /** 关闭当前代次并立即新建订阅，保留已发布目录。 */
  retry(): void {
    if (this.disposed) return;
    this.started = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.invalidate();
    this.open();
  }
  /** 关闭订阅、取消读取及待执行的重连。 */
  dispose(): void { this.disposed = true; this.cancelTimer?.(); this.cancelTimer = undefined; this.invalidate(); }
  private invalidate(): void { const old = this.generation; this.generation = undefined; old?.abort.abort(); old?.connection?.close(); }
  private reconnect(): void {
    this.invalidate();
    if (this.disposed || this.cancelTimer) return;
    const schedule = this.options.schedule ?? ((callback: () => void) => { const id = setTimeout(callback, 250); return () => clearTimeout(id); });
    this.cancelTimer = schedule(() => { this.cancelTimer = undefined; if (!this.disposed) this.open(); });
  }
  private open(): void {
    const generation: Generation = { abort: new AbortController(), ready: false, installed: false, buffer: [] };
    this.generation = generation;
    generation.connection = this.options.connect({ frame: (value) => this.frame(generation, value), error: () => { if (this.generation === generation) this.reconnect(); } });
  }
  private frame(generation: Generation, value: unknown): void {
    if (this.generation !== generation) return;
    const parsed = sessionDirectoryFrameSchema.safeParse(value);
    if (!parsed.success) { this.reconnect(); return; }
    const frame = parsed.data;
    if (frame.type === "api-session/ready") {
      if (generation.ready) { this.reconnect(); return; }
      generation.ready = true; generation.token = this.options.onSnapshotStart?.();
      void this.read(generation); return;
    }
    if (!generation.ready) { this.reconnect(); return; }
    if (frame.type === "api-session/error") {

      if (!this.state?.sessions.some((entry) => entry.sessionId === frame.sessionId)) return;
      this.state = { ...this.state, removed: [], withdrawn: [], snapshotToken: undefined, errorOnly: true, sessions: this.state.sessions.map((entry) => entry.sessionId === frame.sessionId ? { ...entry, lastAgentError: frame.message } : entry) };
      this.options.onState(this.state); return;
    }
    if (!generation.installed) { generation.buffer.push(frame); return; }
    if (!this.state) return;
    if (frame.revision <= this.state.revision) {
      if (frame.type === "api-session/removed" && !this.state.sessions.some((entry) => entry.sessionId === frame.sessionId)) {
        this.options.onCoveredRemoval?.(frame.sessionId);
      }
      return;
    }
    const next = apply({ ...this.state, removed: [], withdrawn: [], snapshotToken: undefined, errorOnly: false }, [frame]);
    if (!next) { this.reconnect(); return; }
    if (next.revision !== this.state.revision) { this.state = next; this.options.onState(next); }
  }
  private async read(generation: Generation): Promise<void> {
    try {
      const snapshot = sessionDirectorySnapshotSchema.parse(await this.options.read(generation.abort.signal));
      if (this.generation !== generation) return;
      const previous = new Map(this.state?.sessions.map((entry) => [entry.sessionId, entry]));
      const removed = [...previous.keys()];
      const withdrawn: string[] = [];
      for (const frame of generation.buffer) {
        // 快照已经吸收这些撤回；保留 ID 供待核实创建对账。
        if (frame.type === "api-session/removed" && frame.revision <= snapshot.revision) { removed.push(frame.sessionId); withdrawn.push(frame.sessionId); }
      }
      const candidate = apply({
        revision: snapshot.revision,
        sessions: snapshot.sessions.map((entry) => {
          const error = previous.get(entry.sessionId)?.lastAgentError;
          return error === undefined ? entry : { ...entry, lastAgentError: error };
        }),
        removed,
        withdrawn,
        snapshotToken: generation.token,
      }, generation.buffer);
      if (!candidate) { this.reconnect(); return; }
      generation.installed = true; generation.buffer = []; this.state = candidate; this.options.onState(candidate);
    } catch {
      if (this.generation !== generation) return;
      this.invalidate(); this.options.onFailure?.();
    }
  }
}
