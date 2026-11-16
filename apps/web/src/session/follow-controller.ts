/** follow 订阅的本地同步状态；generation 与日志 cursor、实时 revision 相互独立。 */
import {
  followFrameSchema,
  type FollowFrame,
  type AssistantChunk,
  type RawSessionEventFrame,
} from "@mharness/session/contracts";

type Snapshot = Extract<FollowFrame, { type: "snapshot" }>;
type Stream = Extract<FollowFrame, { type: "assistant-stream" }>["frame"];
type Draft = {
  attemptId: string;
  turn: number;
  step: number;
  chunks: AssistantChunk[];
  nextIndex: number;
  nodeId: string;
};
type Settlement = {
  draft: Draft;
  outcome?: Extract<Stream, { type: "end" }>["outcome"];
  event?: RawSessionEventFrame;
};
/** 页面可读取的窗口；同步失败时保留最后一次有效窗口。 */
export interface FollowState {
  sessionId: string | null;
  status: "idle" | "syncing" | "ready" | "failed";
  records: readonly RawSessionEventFrame[];
  inheritedEventCount: number;
  /** 原始事件末尾序号；空窗口为 -1。 */
  cursor: number;
  /** Assistant 实时流的基线，与事件游标无关。 */
  revision: number;
  draft?: Draft;
  settledNodeIds: Readonly<Record<number, string>>;
  error?: string;
  /** 当前 Turn 的即时执行错误；新 Turn 开始时清除。 */
  agentError?: string;
}
/** 连接只交付业务帧；心跳注释应由传输层忽略。 */
export interface FollowCallbacks {
  frame(value: unknown): void;
  error(): void;
  close(): void;
}
/** 自动恢复的退避序列、单次等待上限和最大重连次数。 */
export interface FollowRetryPolicy {
  /** 非空退避序列，单位为毫秒；每项为 0 至 2147483647 的整数，次数超过序列长度时沿用最后一项。 */
  delaysMs: readonly [number, ...number[]];
  /** 单次退避上限，单位为毫秒，取值为 0 至 2147483647 的整数。 */
  maxDelayMs: number;
  /** 完整快照安装成功前允许的最大重连次数，须为非负安全整数。 */
  maxAttempts: number;
}
const defaultRetry: FollowRetryPolicy = {
  delaysMs: [250, 500, 1000, 2000],
  maxDelayMs: 2000,
  maxAttempts: 4,
};
/** 调用方负责连接 SSE 并在 close 时仅释放该连接。 */
export interface FollowOptions {
  /** 创建一个连接；返回的 close 只释放该连接，不取消远端执行。 */
  connect(sessionId: string, callbacks: FollowCallbacks): { close(): void };
  /** 状态每次提交后同步调用；快照构建期间不会交付部分窗口。 */
  onState(state: FollowState): void;
  /** 可异步构建视图；抛错将保留旧窗口并进入恢复。 */
  buildSnapshot?(snapshot: Snapshot): Promise<void>;
  /** 恢复等待毫秒序列，每项为 0 至 2147483647 的整数；空数组禁止自动重连，且优先于 retry。 */
  retryDelays?: readonly number[];
  /** 自动重连策略；省略时最多重连四次，单次等待不超过两秒。 */
  retry?: FollowRetryPolicy;
}

/** 串行消费 follow 帧并隔离失效订阅，释放时不会取消远端 Turn。 */
export class FollowController {
  private generation = 0;
  private connection?: { close(): void };
  private timer?: ReturnType<typeof setTimeout>;
  private queue: Promise<void> = Promise.resolve();
  private attempts = 0;
  private first = true;
  private pending?: Settlement;
  private turn?: number;
  private step?: number;
  private state: FollowState = {
    sessionId: null,
    status: "idle",
    records: [],
    inheritedEventCount: 0,
    cursor: -1,
    revision: 0,
    settledNodeIds: {},
  };
  private readonly options: FollowOptions;
  private readonly retryPolicy: FollowRetryPolicy;
  private readonly retryDelays?: readonly number[];
  /**
   * 创建订阅控制器并固定恢复配置；后续修改传入配置不会影响该实例。
   * @param options - 连接、状态通知及可选恢复策略。
   * @throws 恢复次数或定时值超出允许范围时抛出 RangeError。
   */
  constructor(options: FollowOptions) {
    this.options = options;
    const policy = options.retry ?? defaultRetry;
    const validDelay = (value: number): boolean =>
      Number.isInteger(value) && value >= 0 && value <= 2147483647;
    if (
      !Array.isArray(policy.delaysMs) ||
      policy.delaysMs.length === 0 ||
      !Array.from(policy.delaysMs).every(validDelay) ||
      !validDelay(policy.maxDelayMs) ||
      !Number.isSafeInteger(policy.maxAttempts) ||
      policy.maxAttempts < 0 ||
      (options.retryDelays !== undefined &&
        (!Array.isArray(options.retryDelays) || !Array.from(options.retryDelays).every(validDelay)))
    )
      throw new RangeError("恢复配置无效");
    this.retryPolicy = { ...policy, delaysMs: [policy.delaysMs[0], ...policy.delaysMs.slice(1)] };
    this.retryDelays = options.retryDelays?.slice();
  }
  /** 切换选中会话；null 释放订阅。 */
  select(sessionId: string | null): void {
    this.invalidate();
    this.attempts = 0;
    this.pending = undefined;
    this.state = {
      sessionId,
      status: sessionId ? "syncing" : "idle",
      records: [],
      inheritedEventCount: 0,
      cursor: -1,
      revision: 0,
      settledNodeIds: {},
    };
    this.emit();
    if (sessionId) this.open(sessionId);
  }
  /** 用户主动重试，重新分配恢复预算。 */
  retry(): void {
    const id = this.state.sessionId;
    if (!id) return;
    this.invalidate();
    this.attempts = 0;
    this.state = { ...this.state, status: "syncing", error: undefined };
    this.emit();
    this.open(id);
  }
  /** 释放连接和待执行的重连计时器。 */
  dispose(): void {
    this.invalidate();
    this.state = { ...this.state, sessionId: null, status: "idle" };
  }
  private emit(): void {
    this.options.onState(this.state);
  }
  private valid(generation: number, id: string): boolean {
    return this.generation === generation && this.state.sessionId === id;
  }
  private invalidate(): void {
    this.generation++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const old = this.connection;
    this.connection = undefined;
    old?.close();
  }
  private open(id: string): void {
    const generation = ++this.generation;
    this.first = true;
    this.queue = Promise.resolve();
    const callbacks: FollowCallbacks = {
      frame: (value) => {
        if (!this.valid(generation, id)) return;
        this.queue = this.queue.then(async () => {
          if (!this.valid(generation, id)) return;
          const before = this.state;
          const pending = this.pending ? { ...this.pending } : undefined;
          const turn = this.turn;
          const step = this.step;
          try {
            await this.consume(value, generation, id);
          } catch {
            if (this.valid(generation, id)) {
              this.state = before;
              this.pending = pending;
              this.turn = turn;
              this.step = step;
              this.recover();
            }
          }
        });
      },
      error: () => {
        if (this.valid(generation, id))
          this.queue = this.queue.then(() => {
            if (this.valid(generation, id)) this.recover();
          });
      },
      close: () => {
        if (this.valid(generation, id))
          this.queue = this.queue.then(() => {
            if (this.valid(generation, id)) this.recover();
          });
      },
    };
    try {
      const connection = this.options.connect(id, callbacks);
      if (this.valid(generation, id)) this.connection = connection;
      else connection.close();
    } catch {
      if (this.valid(generation, id)) this.recover();
    }
  }
  private recover(): void {
    const id = this.state.sessionId;
    if (!id) return;
    this.invalidate();
    const policy = this.retryPolicy;
    const delays = this.retryDelays;
    const maxAttempts = delays ? delays.length : policy.maxAttempts;
    if (this.attempts >= maxAttempts) {
      this.state = {
        ...this.state,
        status: "failed",
        error: "同步失败，请重试",
      };
      this.emit();
      return;
    }
    const delay = delays
      ? delays[this.attempts]
      : Math.min(policy.delaysMs[Math.min(this.attempts, policy.delaysMs.length - 1)], policy.maxDelayMs);
    this.attempts++;
    this.state = { ...this.state, status: "syncing", error: undefined };
    this.emit();
    const generation = this.generation;
    this.timer = setTimeout(() => {
      if (this.valid(generation, id)) this.open(id);
    }, delay);
  }
  private async consume(
    value: unknown,
    generation: number,
    id: string,
  ): Promise<void> {
    const frame = followFrameSchema.parse(value);
    if (frame.type === "error") {
      this.invalidate();
      this.state = {
        ...this.state,
        status: "failed",
        error: frame.error.message,
      };
      this.emit();
      return;
    }
    if (this.first) {
      if (frame.type !== "snapshot") throw new Error("首帧不是快照");
      const { records, cursor, inheritedEventCount, assistantStream } = frame;
      if (
        frame.sessionId !== id ||
        cursor !== records.length - 1 ||
        inheritedEventCount > records.length ||
        records.some((r, i) => r.event.seq !== i)
      )
        throw new Error("快照前缀无效");
      let turn: number | undefined;
      let step: number | undefined;
      for (const { event } of records) {
        if (event.type === "turn/start") {
          turn = event.data.turn;
          step = undefined;
        } else if (event.type === "step/start") {
          turn = event.data.turn;
          step = event.data.step;
        } else if (event.type === "step/end") step = undefined;
        else if (event.type === "turn/end") {
          turn = undefined;
          step = undefined;
        }
      }
      const active = assistantStream.activeAttempt;
      if (
        active &&
        (active.nextIndex !== active.chunks.length ||
          active.turn !== turn ||
          active.step !== step ||
          assistantStream.revision === 0)
      )
        throw new Error("快照草稿无效");
      this.validateChunks(active?.chunks ?? []);
      await this.options.buildSnapshot?.(frame);
      if (!this.valid(generation, id)) return;
      this.turn = turn;
      this.step = step;
      this.pending = undefined;
      this.first = false;
      this.attempts = 0;
      this.state = {
        sessionId: id,
        status: "ready",
        records,
        cursor,
        inheritedEventCount,
        revision: assistantStream.revision,
        draft: active ? { ...active, nodeId: active.attemptId } : undefined,
        settledNodeIds: {},
      };
      this.emit();
      return;
    }
    if (frame.type === "snapshot") throw new Error("重复快照");
    if (frame.type === "agent/error") {
      this.state = { ...this.state, agentError: frame.message };
      this.emit();
      return;
    }
    if (frame.type === "event") {
      const event = frame.event;
      if (event.seq <= this.state.cursor) return;
      if (event.seq !== this.state.cursor + 1) throw new Error("事件缺号");
      if (
        this.pending?.outcome?.kind === "committed" &&
        event.seq >= this.pending.outcome.seq &&
        (event.seq !== this.pending.outcome.seq ||
          event.type !== this.pending.outcome.eventType ||
          (event.type !== "assistant/message" && event.type !== "assistant/attempt") ||
          event.data.turn !== this.pending.draft.turn ||
          event.data.step !== this.pending.draft.step)
      )
        throw new Error("结算引用不匹配");
      if (event.type === "turn/end" && (this.pending || this.state.draft))
        throw new Error("结算不完整");
      if (event.type === "turn/start") {
        this.turn = event.data.turn;
        this.step = undefined;
      } else if (event.type === "step/start") {
        this.turn = event.data.turn;
        this.step = event.data.step;
      } else if (event.type === "step/end") this.step = undefined;
      else if (event.type === "turn/end") {
        this.turn = undefined;
        this.step = undefined;
      }
      this.state = {
        ...this.state,
        cursor: event.seq,
        records: [...this.state.records, frame],
        agentError:
          event.type === "turn/start" ? undefined : this.state.agentError,
      };
      if (
        (event.type === "assistant/message" ||
          event.type === "assistant/attempt") &&
        this.state.draft
      ) {
        if (event.data.turn !== this.state.draft.turn || event.data.step !== this.state.draft.step || this.pending?.event)
          throw new Error("结算范围或数量无效");
        this.pending ??= { draft: this.state.draft };
        this.pending.event = frame;
        this.settle();
      }
      this.emit();
      return;
    }
    const stream = frame.frame;
    if (stream.revision !== this.state.revision + 1)
      throw new Error("实时版本缺号");
    let draft = this.state.draft;
    if (stream.type === "start") {
      if (
        draft ||
        this.pending ||
        stream.turn !== this.turn ||
        stream.step !== this.step
      )
        throw new Error("实时范围无效");
      draft = {
        attemptId: stream.attemptId,
        turn: stream.turn,
        step: stream.step,
        chunks: [],
        nextIndex: 0,
        nodeId: stream.attemptId,
      };
    } else {
      if (
        this.pending?.outcome ||
        !draft ||
        draft.attemptId !== stream.attemptId ||
        stream.index !== draft.nextIndex
      )
        throw new Error("实时分片无效");
      if (stream.type === "chunk") {
        draft = {
          ...draft,
          chunks: [...draft.chunks, stream.chunk],
          nextIndex: draft.nextIndex + 1,
        };
        this.validateChunks(draft.chunks);
      } else {
        if (stream.turn !== draft.turn || stream.step !== draft.step)
          throw new Error("结算范围无效");
        if (stream.outcome.kind === "abandoned") {
          if (this.pending?.event) throw new Error("结算冲突");
          this.pending = undefined;
          draft = undefined;
        } else {
          this.pending ??= { draft };
          this.pending.outcome = stream.outcome;
        }
      }
    }
    this.state = { ...this.state, revision: stream.revision, draft };
    this.settle();
    this.emit();
  }
  private settle(): void {
    const pending = this.pending;
    if (!pending?.event || !pending.outcome) return;
    const event = pending.event.event;
    const outcome = pending.outcome;
    if (
      outcome.kind !== "committed" ||
      event.seq !== outcome.seq ||
      event.type !== outcome.eventType ||
      (event.type !== "assistant/message" &&
        event.type !== "assistant/attempt") ||
      event.data.turn !== pending.draft.turn ||
      event.data.step !== pending.draft.step
    )
      throw new Error("结算引用不匹配");
    this.state = {
      ...this.state,
      draft: undefined,
      settledNodeIds: {
        ...this.state.settledNodeIds,
        [event.seq]: pending.draft.nodeId,
      },
    };
    this.pending = undefined;
  }
  private validateChunks(chunks: readonly AssistantChunk[]): void {
    const tools = new Map<number, { callId: string; name: string }>();
    for (const chunk of chunks) {
      if (chunk.type !== "tool-call-delta") continue;
      const previous = tools.get(chunk.toolIndex);
      if (!previous) {
        if (!chunk.callId || !chunk.name) throw new Error("工具首片缺少标识");
        tools.set(chunk.toolIndex, { callId: chunk.callId, name: chunk.name });
      } else if (
        (chunk.callId && chunk.callId !== previous.callId) ||
        (chunk.name && chunk.name !== previous.name)
      )
        throw new Error("工具标识变化");
    }
  }
}
