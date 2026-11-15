import {
  sessionPositionSchema,
  snapshotSessionEvent,
  type SessionAppendInput,
  type SessionEvent,
} from "./events.ts";

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

type ReportListenerError = (error: unknown) => void;

type UnionKeys<T> = T extends unknown ? keyof T : never;

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
  readonly #notifications: { "session/event": Notifications<SessionEvent> };
  #appending = false;

  /** 此 Session 持有的独立元数据快照。 */
  readonly header: SessionHeader;

  /** 本会话继承的事件数量，也是分支第一条自有记录的位置。 */
  readonly inheritedEventCount: number;

  /**
   * 创建空 Session，或在发布前验证并安装一个日志前缀。
   * @param header - 独立于日志的会话身份和创建时间。
   * @param options - 可提供分支或恢复前缀，以及监听失败报告入口。缺省报告入口输出诊断。
   * @throws 元数据、重放事件或分支继承边界无效时抛出。
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

  /**
   * 接受一条记录并向当前监听器同步发布。
   * @param candidate - 载荷的字段须符合事件类别。调用方不得传入序号，省略时间时使用当前 Unix 毫秒。
   * @returns 已接受的不可变事件。
   * @throws 候选事件无效、尝试自行写入分支标记，或在当前追加中重入时抛出。
   */
  append<const Input extends SessionAppendInput>(
    candidate: Input & ([UnexpectedAppendFields<NoInfer<Input>>] extends [never] ? unknown : never),
  ): SessionEvent {
    if (this.#appending) throw new Error("会话事件追加不允许重入");
    this.#appending = true;
    try {
      const event = snapshotSessionEvent(candidate, this.seq, "append");
      if (event.type === "session/end-seed") throw new Error("继承标记只在准备分支时分配");
      this.#accept(event);
      this.#notifications["session/event"].emit(event);
      return event;
    } finally {
      this.#appending = false;
    }
  }

  #accept(event: SessionEvent): void {
    if (event.type === "tool/call") {
      const { turn, step, callId, name, arguments: rawArguments } = event.data;
      const assistant = this.#events.findLast((entry) =>
        entry.type === "assistant/message" && entry.data.turn === turn && entry.data.step === step);
      const block = assistant?.type === "assistant/message"
        ? assistant.data.message.content.find((part) => part.type === "tool-call" && part.id === callId)
        : undefined;
      if (block?.type !== "tool-call" || block.name !== name || block.arguments !== rawArguments) {
        throw new Error("工具调用与 Assistant 声明不一致");
      }
    }
    this.#events.push(event);
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
