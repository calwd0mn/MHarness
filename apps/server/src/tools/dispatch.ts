/** 超时仅表示等待截止，不证明执行端停止或副作用撤销。 */
export type DispatchOutcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "failed"; error: unknown }
  | { kind: "dispatch-error"; error: unknown }
  | { kind: "aborted"; code: "ABORTED" | "ABORTED_BEFORE_DISPATCH" }
  | { kind: "timeout"; code: "TOOL_TIMEOUT" };

/** 取消信号携带此原因时，调用方不得观察迟到的工具值。 */
export const STOP_OBSERVING_TOOL_RESULT = Symbol("stop-observing-tool-result");

type LegacyDispatchOutcome<T> = Exclude<DispatchOutcome<T>, { kind: "timeout" }>;
type Guarantee = "cooperative-exit" | "none";
/** 派发使用的可信执行位置、退出保证与等待时间。 */
export interface DispatchPolicy {
  readonly executionBoundary: "local" | "remote";
  readonly cancellationGuarantee: Guarantee;
  /** 从派发正文开始计算的等待时间，单位为毫秒，必须大于 0 且不超过 2_147_483_647。 */
  readonly timeoutMs: number;
}

/** 单次工具调用的取消与派发协调器；实例不能重复派发。 */
export class ToolDispatch<T> {
  private state: "pending" | "running" | "settled" = "pending";
  private readonly controller = new AbortController();
  private waitForExit = false;
  private timedOut = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly result: Promise<DispatchOutcome<T>>;
  private resolve!: (outcome: DispatchOutcome<T>) => void;
  private dispatched = false;

  constructor() {
    this.result = new Promise((resolve) => { this.resolve = resolve; });
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private settle(outcome: DispatchOutcome<T>): void {
    if (this.state === "settled") return;
    this.clearTimer();
    this.state = "settled";
    this.resolve(this.timedOut ? { kind: "timeout", code: "TOOL_TIMEOUT" } : outcome);
  }

  /**
   * 请求取消；派发前阻止正文，派发后向正文发送信号。
   * 不保证没有协作退出能力的正文已停止或没有副作用。
   */
  cancel(): void {
    if (this.state === "settled") return;
    if (this.state === "pending") {
      this.settle({ kind: "aborted", code: "ABORTED_BEFORE_DISPATCH" });
      return;
    }
    this.clearTimer();
    if (!this.waitForExit) this.settle({ kind: "aborted", code: "ABORTED" });
    this.controller.abort(this.waitForExit ? undefined : STOP_OBSERVING_TOOL_RESULT);
  }

  /**
   * 同步竞争派发资格并调用正文；调用前由调用方完成审批和持久化检查点。
   * 完整策略从派发开始计时，仅本地协作退出在取消或超时后等待正文和清理；远程调用停止等待。
   * 超时取得结算资格后，清理期间的结果不会改变超时结局；超时不证明执行端停止或副作用撤销。旧字符串参数不启用超时。
   * @param body - 接收取消信号的正文；同步抛错与返回的 Promise 拒绝分别结算。
   * @param policy - 可信执行策略，或兼容旧调用的取消退出保证。
   * @returns 本次调用的唯一结算；已结算后迟到的正文结果不会覆盖它。
   * @throws 同一实例重复派发，或完整策略的超时无效时抛出错误。
   */
  dispatch(body: (signal: AbortSignal) => Promise<T>, policy: Guarantee): Promise<LegacyDispatchOutcome<T>>;
  dispatch(body: (signal: AbortSignal) => Promise<T>, policy: DispatchPolicy): Promise<DispatchOutcome<T>>;
  dispatch(body: (signal: AbortSignal) => Promise<T>, policy: Guarantee | DispatchPolicy): Promise<DispatchOutcome<T>> {
    if (this.dispatched) throw new Error("工具调用不能重复派发");
    if (typeof policy !== "string" && (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs <= 0 || policy.timeoutMs > 2_147_483_647)) throw new Error("timeoutMs 必须大于 0 且不超过 2_147_483_647 毫秒");
    this.dispatched = true;
    if (this.state === "settled") return this.result;
    this.waitForExit = typeof policy === "string" ? policy === "cooperative-exit" : policy.executionBoundary === "local" && policy.cancellationGuarantee === "cooperative-exit";
    this.state = "running";
    if (typeof policy !== "string") {
      this.timer = setTimeout(() => {
        this.timedOut = true;
        if (!this.waitForExit) this.settle({ kind: "timeout", code: "TOOL_TIMEOUT" });
        this.controller.abort(STOP_OBSERVING_TOOL_RESULT);
      }, policy.timeoutMs);
    }
    try {
      Promise.resolve(body(this.controller.signal)).then(
        (value) => this.settle({ kind: "completed", value }),
        (error: unknown) => this.settle({ kind: "failed", error }),
      );
    } catch (error) {
      this.settle({ kind: "dispatch-error", error });
    }
    return this.result;
  }
}
