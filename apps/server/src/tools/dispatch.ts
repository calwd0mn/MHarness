/** 单次派发的确认结果、正文拒绝、同步派发异常或取消结算。 */
export type DispatchOutcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "failed"; error: unknown }
  | { kind: "dispatch-error"; error: unknown }
  | { kind: "aborted"; code: "ABORTED" | "ABORTED_BEFORE_DISPATCH" };

/** 单次工具调用的取消与派发协调器；实例不能重复派发。 */
export class ToolDispatch<T> {
  private state: "pending" | "running" | "settled" = "pending";
  private readonly controller = new AbortController();
  private guarantee: "cooperative-exit" | "none" = "none";
  private readonly result: Promise<DispatchOutcome<T>>;
  private resolve!: (outcome: DispatchOutcome<T>) => void;
  private dispatched = false;

  constructor() {
    this.result = new Promise((resolve) => { this.resolve = resolve; });
  }

  private settle(outcome: DispatchOutcome<T>): void {
    if (this.state === "settled") return;
    this.state = "settled";
    this.resolve(outcome);
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
    if (this.guarantee === "none") this.settle({ kind: "aborted", code: "ABORTED" });
    this.controller.abort();
  }

  /**
   * 同步竞争派发资格并调用正文；调用前由调用方完成审批和持久化检查点。
   * @param body - 接收取消信号的正文；同步抛错与返回的 Promise 拒绝分别结算。
   * @param guarantee - cooperative-exit 在取消后等待正文退出；none 立即停止等待。
   * @returns 本次调用的唯一结算；已结算后迟到的正文结果不会覆盖它。
   * @throws 同一实例重复派发时抛出错误。
   */
  dispatch(body: (signal: AbortSignal) => Promise<T>, guarantee: "cooperative-exit" | "none"): Promise<DispatchOutcome<T>> {
    if (this.dispatched) throw new Error("工具调用不能重复派发");
    this.dispatched = true;
    if (this.state === "settled") return this.result;
    this.guarantee = guarantee;
    this.state = "running";
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
