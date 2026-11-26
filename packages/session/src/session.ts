import { isDeepStrictEqual } from "node:util";
import {
  sessionPositionSchema,
  snapshotSessionEvent,
  type SessionAppendInput,
  type SessionEvent,
} from "./events.ts";
import { indexSurfaceToolGroups, isCompleteSurfaceToolRange } from "./surface-tool-pairs.ts";
import { SessionToolCalls } from "./tool-calls.ts";

/** 独立于事件日志的元数据。分支记录直接父会话，创建时间使用 Unix 毫秒。 */
export type SessionHeader = Readonly<{
  sessionId: string;
  createdAt: number;
}> & (
  | { readonly isSeeded?: false; readonly parentSession?: never }
  | { readonly isSeeded: true; readonly parentSession: string }
);

/** 分支复制已选好的完整前缀，恢复接收持久化原始值并保留既有继承标记。 */
export type SessionSeed =
  | { readonly kind: "fork"; readonly events: readonly SessionEvent[] }
  | {
    readonly kind: "restore";
    readonly events: readonly unknown[];
    /** 当前会话自己继承的前缀长度，普通会话传零。 */
    readonly inheritedEventCount: number;
  };

/** 一次读取截点的事件及完整前缀游标，范围读取也保留该截点的游标。 */
export interface SessionSnapshot {
  readonly cursor: number;
  readonly events: readonly SessionEvent[];
}

/** 当前 surface 中的事件节点；顺序由读取结果决定，而非事件序号。 */
export type SurfaceNode = Extract<SessionEvent, { surfaceOp: unknown }>;
/** 从当前 surface 提取的不可变模型消息。 */
export type SessionMessage = Extract<SurfaceNode, { type: "user/message" }>["data"]
  | Extract<SurfaceNode, { type: "assistant/message" | "tool/result" }>["data"]["message"];

function messageOf(event: SurfaceNode): SessionMessage {
  return event.type === "user/message" ? event.data : event.data.message;
}

type ReportListenerError = (error: unknown) => void;

/** 暂存批次的持久化结论；待核对时调用方须先恢复存储准入。 */
export type StagedCommitResult =
  | { readonly status: "committed"; readonly events: readonly SessionEvent[] }
  | { readonly status: "rolled-back"; readonly error: unknown }
  | { readonly status: "pending-reconciliation"; readonly error: unknown };

/** 写入器对暂存批次的持久化结论。 */
export type StagedPersistenceResult =
  | { readonly status: "committed" }
  | { readonly status: "rolled-back"; readonly error: unknown }
  | { readonly status: "pending-reconciliation"; readonly error: unknown };

type UnionKeys<T> = T extends unknown ? keyof T : never;
type AppendedEvent<Input extends SessionAppendInput> = Extract<SessionEvent, { type: Input["type"] }>;

// TypeScript 的结构化赋值允许变量携带额外字段，需要按实参的键补做检查。
type UnexpectedAppendFields<Input> = Input extends { readonly type: infer Type; readonly data: infer Data }
  ? Extract<"seq", keyof Input> | Exclude<
    UnionKeys<Data>,
    UnionKeys<Extract<SessionAppendInput, { type: Type }>["data"]>
  >
  : never;

class Notifications<T> {
  readonly #listeners = new Set<(payload: T) => void>();

  constructor(private readonly reportError: ReportListenerError) {}

  on(listener: (payload: T) => void): () => void {
    const registration = (payload: T) => listener(payload);
    this.#listeners.add(registration);
    return () => { this.#listeners.delete(registration); };
  }

  emit(payload: T): void {
    for (const listener of [...this.#listeners]) {
      try {
        const result: unknown = listener(payload);
        if (result instanceof Promise) void result.catch((error: unknown) => this.#report(error));
      } catch (error) {
        this.#report(error);
      }
    }
  }

  #report(error: unknown): void {
    try {
      this.reportError(error);
    } catch (reportingError) {
      console.error("会话监听错误报告失败", reportingError);
    }
  }
}

function reportListenerError(error: unknown): void {
  console.error("会话监听器失败", error);
}

/** 在内存中接受和读取会话事件。事件接受可同步观察。 */
export class Session {
  readonly #events: SessionEvent[] = [];
  #toolCalls = new SessionToolCalls();
  readonly #notifications: { "session/event": Notifications<SessionEvent> };
  #checkpoint?: { readonly flush: (eventCount: number) => Promise<void>; readonly staged?: (events: readonly SessionEvent[], finish: (result: StagedPersistenceResult) => void, beforeSubmit?: () => void) => Promise<StagedPersistenceResult>; readonly enqueue?: (events: readonly SessionEvent[], atomic: boolean) => void };
  #appending = false;
  #staged = false;
  #surface: SurfaceNode[] = [];
  #messages: SessionMessage[] | undefined = [];
  #replaceGeneration = 0;
  #listBlank = true;
  #lastPromptAt: number | null = null;

  /** 此 Session 持有的独立元数据快照。 */
  readonly header: SessionHeader;

  /** 本会话继承的事件数量，也是分支第一条自有记录的位置。 */
  readonly inheritedEventCount: number;

  /**
   * 创建空 Session，或在发布前验证并安装一个日志前缀。
   * @param header - 独立于日志的会话身份和创建时间。
   * @param options - 可提供分支或恢复前缀，以及监听失败报告入口。缺省报告入口输出诊断。
   * @throws 元数据、重放事件、孤立修剪标记或分支继承边界无效时抛出。
   */
  constructor(header: SessionHeader, options: { seed?: SessionSeed; reportError?: ReportListenerError } = {}) {
    const { sessionId, createdAt } = header;
    sessionPositionSchema.parse(createdAt);
    if (typeof sessionId !== "string" || !sessionId ||
      (header.isSeeded === true && (typeof header.parentSession !== "string" || !header.parentSession))) {
      throw new TypeError("会话标识和分支的父会话标识必须存在");
    }
    const { seed, reportError = reportListenerError } = options;
    this.header = Object.freeze(header.isSeeded === true
      ? { sessionId, createdAt, isSeeded: true, parentSession: header.parentSession }
      : { sessionId, createdAt, ...(header.isSeeded === false ? { isSeeded: false as const } : {}) });
    this.#notifications = { "session/event": new Notifications<SessionEvent>(reportError) };
    this.inheritedEventCount = seed?.kind === "fork" ? seed.events.length : seed?.inheritedEventCount ?? 0;
    sessionPositionSchema.parse(this.inheritedEventCount);
    if (seed?.kind === "fork" && header.isSeeded !== true) {
      throw new TypeError("分支前缀需要分支元数据");
    }

    for (const raw of seed?.events ?? []) {
      this.#accept(snapshotSessionEvent(raw, this.seq, "replay"));
    }
    this.#assertPruneComplete();
    if (seed?.kind === "fork") {
      this.#accept(snapshotSessionEvent({
        type: "session/end-seed", time: createdAt, data: { inherited: true },
      }, this.seq, "append"));
    }
    const marker = this.#events.findLast((event) => event.type === "session/end-seed");
    const expectedMarker = header.isSeeded === true ? this.inheritedEventCount : undefined;
    if (marker?.seq !== expectedMarker || (expectedMarker === undefined && this.inheritedEventCount !== 0)) {
      throw new RangeError("会话继承标记与继承计数不符");
    }
  }

  /** 已接受的事件数，也是下一次追加分配的位置。 */
  get seq(): number {
    return this.#events.length;
  }

  /** @returns 已接受事件的目录投影；活动时间仅包含真实用户消息。 */
  get listMetadata(): Readonly<{ blank: boolean; lastPromptAt: number | null }> {
    return { blank: this.#listBlank, lastPromptAt: this.#lastPromptAt };
  }

  /**
   * 接受一条记录并向当前监听器同步发布。
   * @param candidate - 载荷的字段须符合事件类别。调用方不得传入序号，省略时间时使用当前 Unix 毫秒。
   * @returns 已接受的不可变事件，与日志和通知共享同一快照。单一事件类别可直接读取该类别的载荷，联合输入返回对应类别的联合。
   * @throws 事件载荷或日志关联无效、压缩终态 ID 已存在、尝试普通追加修剪标记或自行写入分支标记，或在当前追加中重入时抛出。
   */
  append<const Input extends SessionAppendInput>(
    candidate: Input & ([UnexpectedAppendFields<NoInfer<Input>>] extends [never] ? unknown : never),
  ): AppendedEvent<Input> {
    if (this.#appending || this.#staged) throw new Error("会话事件追加不允许重入或与暂存竞争");
    this.#appending = true;
    try {
      const event = snapshotSessionEvent(candidate, this.seq, "append");
      if (event.type === "session/end-seed") throw new Error("继承标记只在准备分支时分配");
      if (event.type === "compaction/prune") throw new Error("修剪标记必须在暂存批次中提交");
      if (event.type === "compaction/end" && this.#events.some((entry) => entry.type === "compaction/end" && entry.data.compactionId === event.data.compactionId)) {
        throw new Error("压缩终态标识已存在");
      }
      this.#accept(event);
      this.#checkpoint?.enqueue?.([event], false);
      this.#notifications["session/event"].emit(event);
      // 快照沿用输入的事件类别，经过共享 Schema 校验后可以按该类别收窄。
      return event as AppendedEvent<Input>;
    } finally {
      this.#appending = false;
    }
  }

  /** 当前是否由暂存批次占用写入位置。 */
  get stagedOccupied(): boolean { return this.#staged; }

  /**
   * 同步校验并接受整个批次，在发布第一条通知前交给绑定的写入器，保留整批落盘边界。
   * @param build - 用首序号同步构建连续候选，可引用同批中较早的记录。
   * @returns 已接受的不可变批次。需要持久化确认时由调用方等待 `flush()`。
   * @throws 空批次、记录或关联无效、修剪标记、追加重入或暂存占用时抛出。
   */
  appendBatch(build: (firstSeq: number) => readonly SessionAppendInput[]): readonly SessionEvent[] {
    if (this.#appending || this.#staged) throw new Error("会话写入已被占用");
    this.#appending = true;
    try {
      const { draft, events } = this.#prepareBatch(build, false);
      this.#installBatch(draft, events);
      this.#checkpoint?.enqueue?.(events, true);
      for (const event of events) this.#notifications["session/event"].emit(event);
      return events;
    } finally {
      this.#appending = false;
    }
  }

  /**
   * 同步构建并校验完整候选，再等待持久化结论；待核对时保留占用直到检查点处理。
   * @param build - 接收批次首序号并返回候选；不得在其中执行异步工作。
   * @param options - 可选的同步提交前检查与暂存侧异常通知；检查在普通检查点后、暂存端口调用前执行，抛错不视为存储故障。通知仅针对进入暂存交接后的其他抛错，须同步且不抛错。
   * @returns 已提交事件、确认回滚的原因或待核对原因。
   * @throws 未绑定暂存写入器、写入竞争、构建、校验（包括前缀或批次中重复的压缩终态 ID）、提交前检查或暂存侧抛错时以原值拒绝。
   */
  async commitStaged(build: (firstSeq: number) => readonly SessionAppendInput[], options?: { readonly beforeSubmit?: () => void; readonly onPersistenceError?: (error: unknown) => void }): Promise<StagedCommitResult> {
    if (this.#appending || this.#staged) throw new Error("会话写入已被占用");
    const staged = this.#checkpoint?.staged;
    if (!staged) throw new Error("会话未绑定暂存写入器");
    this.#staged = true;
    try {
      const { draft, events } = this.#prepareBatch(build, true);
      const finish = (result: StagedPersistenceResult) => {
        if (result.status === "pending-reconciliation") return;
        if (result.status === "committed") {
          this.#installBatch(draft, events);
          for (const event of events) this.#notifications["session/event"].emit(event);
        }
        this.#staged = false;
      };
      let guardFailed = false;
      const beforeSubmit = options?.beforeSubmit && (() => {
        try { options.beforeSubmit!(); } catch (error) { guardFailed = true; throw error; }
      });
      let result: StagedPersistenceResult;
      try { result = await staged(events, finish, beforeSubmit); }
      catch (error) {
        if (!guardFailed) {
          try { options?.onPersistenceError?.(error); } finally { throw error; }
        }
        throw error;
      }
      return result.status === "committed" ? { status: "committed", events } : result;
    } catch (error) {
      this.#staged = false;
      throw error;
    }
  }

  #prepareBatch(build: (firstSeq: number) => readonly SessionAppendInput[], allowPrune: boolean) {
    const draft = new Session({ sessionId: this.header.sessionId, createdAt: this.header.createdAt });
    for (const event of this.#events) draft.#events.push(event);
    draft.#toolCalls = this.#toolCalls.clone();
    draft.#surface = this.#surface.slice();
    draft.#messages = this.#messages?.slice();
    draft.#replaceGeneration = this.#replaceGeneration;
    draft.#listBlank = this.#listBlank;
    draft.#lastPromptAt = this.#lastPromptAt;
    const candidates = build(this.seq);
    if (!Array.isArray(candidates as unknown) || candidates.length === 0) throw new Error("写入批次不能为空");
    let endIds: Set<string> | undefined;
    for (const candidate of candidates) {
      const event = snapshotSessionEvent(candidate, draft.seq, "append");
      if (event.type === "session/end-seed") throw new Error("继承标记只在准备分支时分配");
      if (!allowPrune && event.type === "compaction/prune") throw new Error("修剪标记必须在暂存批次中提交");
      if (event.type === "compaction/end") {
        endIds ??= new Set(this.#events.flatMap((entry) => entry.type === "compaction/end" ? [entry.data.compactionId] : []));
        if (endIds.has(event.data.compactionId)) throw new Error("压缩终态标识已存在");
        endIds.add(event.data.compactionId);
      }
      draft.#accept(event);
    }
    draft.#assertPruneComplete();
    return { draft, events: Object.freeze(draft.#events.slice(this.seq)) };
  }

  #installBatch(draft: Session, events: readonly SessionEvent[]): void {
    for (const event of events) this.#events.push(event);
    this.#toolCalls = draft.#toolCalls;
    this.#surface = draft.#surface;
    this.#messages = draft.#messages;
    this.#replaceGeneration = draft.#replaceGeneration;
    this.#listBlank = draft.#listBlank;
    this.#lastPromptAt = draft.#lastPromptAt;
  }

  #accept(event: SessionEvent): void {
    const previous = this.#events.at(-1);
    if (previous?.type === "compaction/prune" && (event.type !== "tool/result" || event.surfaceOp === "append"
      || event.surfaceOp.start !== previous.data.shadowedSeq || event.surfaceOp.end !== previous.data.shadowedSeq
      || !event.sourceEventSeqs.includes(previous.data.shadowedSeq))) throw new Error("修剪标记必须紧邻对应工具替换");
    if (event.type === "compaction/prune" && !this.#surface.some((node) => node.type === "tool/result" && node.seq === event.data.shadowedSeq)) {
      throw new Error("修剪目标不是当前工具结果");
    }
    if (event.type === "command/run") {
      if (this.#events.some((entry) => entry.type === "command/run" && entry.data.commandId === event.data.commandId)) {
        throw new Error("命令标识已存在");
      }
    } else if (event.type === "command/done") {
      const run = this.#events.find((entry) => entry.type === "command/run" && entry.data.commandId === event.data.commandId);
      if (!run || this.#events.some((entry) => entry.type === "command/done" && entry.data.commandId === event.data.commandId)) {
        throw new Error("命令运行记录缺失或已结算");
      }
      if (event.data.kind === "success" && event.data.sourceEventSeq !== undefined) {
        const source = this.#events[event.data.sourceEventSeq];
        if (!source || source.type !== "compaction/summary" || source.data.sourceCommandId !== event.data.commandId || source.seq <= run.seq || source.seq >= event.seq) {
          throw new Error("命令结果来源无效");
        }
      }
    }
    const recordToolCall = this.#toolCalls.prepare(event);
    if ("surfaceOp" in event) this.#acceptSurface(event);
    recordToolCall?.();
    this.#events.push(event);
    if (event.type === "turn/start") this.#listBlank = false;
    if (event.type === "user/message" && event.data.source.kind === "user") this.#lastPromptAt = Math.max(this.#lastPromptAt ?? 0, event.time);
  }

  #assertPruneComplete(): void {
    if (this.#events.at(-1)?.type === "compaction/prune") throw new Error("修剪标记缺少对应工具替换");
  }

  #acceptSurface(event: SurfaceNode): void {
    const sources = "sourceEventSeqs" in event ? event.sourceEventSeqs : undefined;
    if (sources && (new Set(sources).size !== sources.length || sources.some((seq) => seq >= event.seq))) {
      throw new Error("surface 来源无效");
    }
    if (event.surfaceOp === "append") {
      this.#surface.push(event);
      this.#messages?.push(messageOf(event));
      return;
    }
    const { start, end } = event.surfaceOp;
    const from = this.#surface.findIndex((entry) => entry.seq === start);
    const to = this.#surface.findIndex((entry) => entry.seq === end);
    if (from < 0 || to < from || !sources || this.#surface.slice(from, to + 1).some((entry) => !sources.includes(entry.seq))) {
      throw new Error("surface 替换范围或来源无效");
    }
    const selected = this.#surface.slice(from, to + 1);
    if (event.type === "tool/result") {
      const original = selected[0];
      if (selected.length !== 1 || original?.type !== "tool/result") throw new Error("工具结果替换范围无效");
      const normalize = (value: typeof event.data) => ({ ...value, message: { ...value.message,
        content: [{ ...value.message.content[0], content: [] }] } });
      if (!isDeepStrictEqual(normalize(event.data), normalize(original.data))) {
        throw new Error("工具结果替换只能改变模型内容");
      }
    } else if (!isCompleteSurfaceToolRange(indexSurfaceToolGroups(this.#surface), from, to + 1)) {
      throw new Error("surface 替换拆散工具配对");
    }
    this.#surface.splice(from, to - from + 1, event);
    this.#messages = undefined;
    this.#replaceGeneration++;
  }

  /** 已接受的 surface 替换次数，重放时按日志恢复。 */
  get replaceGeneration(): number { return this.#replaceGeneration; }

  /**
   * 获取当前 surface 的独立数组快照，节点沿用不可变日志事件引用。
   * @returns 按 surface 顺序排列的节点，不随之后的追加或替换改变。
   */
  deriveSurfaceNodes(): readonly SurfaceNode[] {
    return this.#surface.slice();
  }

  /**
   * 按当前 surface 顺序返回模型消息的独立数组。
   * @returns 数组由调用方拥有；其中消息节点与不可变日志共享。
   */
  deriveMessages(): SessionMessage[] {
    this.#messages ??= this.#surface.map(messageOf);
    return this.#messages.slice();
  }

  /**
   * 从当前已接受前缀取得独立的范围快照。
   * @param start - 包含的起始位置，默认从零开始。
   * @param end - 排除的结束位置，默认读取到当前末尾。
   * @returns 所选事件及完整前缀的末尾游标，空日志游标为 -1。
   * @throws 位置不是安全整数，或范围不在当前前缀内时抛出 RangeError。
   */
  snapshot(start = 0, end = this.seq): SessionSnapshot {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end > this.seq) {
      throw new RangeError("会话事件范围未被当前日志覆盖");
    }
    return { cursor: this.seq - 1, events: this.#events.slice(start, end) };
  }

  /**
   * 订阅此 Session 之后接受的事件，按本次派发开始时的注册顺序同步调用。
   * 监听失败单独报告，其余监听器继续接收。异步返回不会延迟追加完成。
   * @param type - 通知类别。
   * @param listener - 同步接收已接受事件的监听器。
   * @returns 解除本次订阅的函数。
   */
  on(type: "session/event", listener: (event: SessionEvent) => void): () => void {
    return this.#notifications[type].on(listener);
  }

  /**
   * 绑定此 Session 的持久化检查点，调用方须在接收新事件前完成绑定。
   * @param checkpoint - 负责确认调用时传入的事件数已提交。
   * @param staged - 可选的暂存提交能力；结果确认或后续核对后须同步调用 finish，待核对时保留该回调。提供提交前检查时，须在普通检查点后、调用持久化端口前同步执行，中间不得等待，也不得将检查异常报告为存储故障。
   * @param enqueue - 已接受事件须在此同步完整入队，不得抛错；atomic 为 true 时须保留原批次边界。
   * @returns 解除本次绑定的函数。
   * @throws 已有绑定时抛出。
   */
  bindCheckpoint(checkpoint: (eventCount: number) => Promise<void>, staged?: (events: readonly SessionEvent[], finish: (result: StagedPersistenceResult) => void, beforeSubmit?: () => void) => Promise<StagedPersistenceResult>, enqueue?: (events: readonly SessionEvent[], atomic: boolean) => void): () => void {
    if (this.#checkpoint) throw new Error("会话已绑定持久化检查点");
    const binding = { flush: checkpoint, staged, enqueue };
    this.#checkpoint = binding;
    return () => {
      if (this.#checkpoint === binding) this.#checkpoint = undefined;
    };
  }

  /**
   * 确认调用开始时已接受的事件全部提交。
   * @returns 检查点覆盖目标前缀后兑现。
   * @throws 未绑定、排空失败或持久前缀未达到目标时拒绝。
   */
  async flush(): Promise<void> {
    if (!this.#checkpoint) throw new Error("会话未绑定持久化检查点");
    await this.#checkpoint.flush(this.seq);
  }
}

/** 管理已发布的内存 Session。准备阶段由调用方持有实例并完成初始装配。 */
export class SessionStore {
  readonly #prepared = new WeakSet<Session>();
  readonly #sessions = new Map<string, Session>();
  readonly #notifications: { "session/created": Notifications<Session> };

  /**
   * 创建空的内存索引。
   * @param reportError - Session 与发布监听器共用的错误报告入口，默认输出诊断。
   */
  constructor(private readonly reportError = reportListenerError) {
    this.#notifications = { "session/created": new Notifications<Session>(reportError) };
  }

  /**
   * 准备只对当前调用方可见的 Session。
   * @param header - Session 的元数据。
   * @param seed - 待安装的分支或恢复前缀，省略时准备空会话。
   * @returns 可完成装配后交回本 Store 发布的实例。
   * @throws 元数据、事件或继承边界无效时抛出。
   */
  prepare(header: SessionHeader, seed?: SessionSeed): Session {
    const session = new Session(header, { seed, reportError: this.reportError });
    this.#prepared.add(session);
    return session;
  }

  /**
   * 注册准备好的 Session，再向监听器发布；监听器可立即读取初始快照。
   * @param session - 此 Store 准备的实例。
   * @throws 实例不属于此次准备流程，或同 ID 已发布时抛出。
   */
  publish(session: Session): void {
    const { sessionId } = session.header;
    if (this.#sessions.has(sessionId)) throw new Error("会话 ID 已发布");
    if (!this.#prepared.delete(session)) throw new Error("会话未经此 Store 准备");
    this.#sessions.set(sessionId, session);
    this.#notifications["session/created"].emit(session);
  }

  /**
   * 释放已退出生命周期的发布实例，原有订阅继续接收之后的发布。
   * @param session - 实际退出的实例；同 ID 的其他实例不受影响。
   */
  release(session: Session): void {
    const { sessionId } = session.header;
    if (this.#sessions.get(sessionId) === session) this.#sessions.delete(sessionId);
  }

  /**
   * 查询已发布的会话。
   * @param sessionId - 会话标识。
   * @returns 对应的内存实例，未发布时返回 undefined。
   */
  get(sessionId: string): Session | undefined {
    return this.#sessions.get(sessionId);
  }

  /**
   * 订阅后续发布的会话；派发期间已存在的监听器依注册顺序收到通知。
   * @param type - 通知类别。
   * @param listener - 接收可立即查询的已发布会话。
   * @returns 解除本次订阅的函数。
   */
  on(type: "session/created", listener: (session: Session) => void): () => void {
    return this.#notifications[type].on(listener);
  }
}
