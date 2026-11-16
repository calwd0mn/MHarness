import type { SessionEvent } from "./events.ts";
import type { SessionHandle } from "./persistence.ts";
import type { Session } from "./session.ts";

const writeWindowMs = 200;

type WriterPort = Pick<SessionHandle, "append" | "flush" | "read">;

/** 把会话新接受的事件按固定窗口串行提交。绑定前的初始前缀由调用方提交。 */
export class SessionWriter {
  readonly #unbind: () => void;
  readonly #unsubscribe: () => void;
  readonly #batches: SessionEvent[][] = [];
  #pending: SessionEvent[] = [];
  #timer?: ReturnType<typeof setTimeout>;
  #tail = Promise.resolve();
  #closing?: Promise<void>;
  #backgroundQueued = false;
  #paused = false;

  /**
   * 订阅一个会话并绑定其检查点，已有前缀不进入缓冲。
   * @param session - 已建立初始持久前缀并准备接收新事件的会话。
   * @param port - 同一会话的写入端口，端口的资源仍由调用方管理。
   * @param reportError - 后台排空失败时的告警入口，默认输出诊断。
   * @throws 会话已绑定检查点时抛出。
   */
  constructor(
    private readonly session: Session,
    private readonly port: WriterPort,
    private readonly reportError: (error: unknown) => void = (error) => console.error("会话后台写入失败", error),
  ) {
    this.#unbind = session.bindCheckpoint((eventCount) => this.flush(eventCount));
    this.#unsubscribe = session.on("session/event", (event) => {
      this.#pending.push(event);
      this.#startWindow();
    });
  }

  /**
   * 立即排空待写记录并执行持久性屏障。先处理已保留的失败批次，再处理后续事件。
   * @param eventCount - 要确认的已接受事件数，默认使用调用开始时的会话前缀。
   * @returns 屏障成功且已提交前缀覆盖目标后兑现。
   * @throws 已开始关闭、写入失败或已提交范围不足时拒绝。
   */
  async flush(eventCount = this.session.seq): Promise<void> {
    if (this.#closing) throw new Error("会话写入器已开始关闭");
    this.#sealWindow();
    await this.#serialize(() => this.#checkpoint(eventCount));
  }

  /**
   * 停止订阅并最后排空一次，重复关闭共享本次结果。
   * @returns 已接收的尾部完成持久化后兑现。写入失败时拒绝，调用方仍须释放底层句柄。
   */
  close(): Promise<void> {
    if (!this.#closing) {
      this.#unsubscribe();
      this.#unbind();
      this.#sealWindow();
      const target = this.session.seq;
      this.#closing = this.#serialize(() => this.#checkpoint(target));
    }
    return this.#closing;
  }

  #startWindow(): void {
    if (this.#timer !== undefined || this.#paused || this.#closing || !this.#pending.length) return;
    this.#timer = setTimeout(() => {
      this.#sealWindow();
      this.#scheduleBackground();
    }, writeWindowMs);
  }

  #sealWindow(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#pending.length) {
      this.#batches.push(this.#pending);
      this.#pending = [];
    }
  }

  #scheduleBackground(): void {
    if (this.#backgroundQueued) return;
    this.#backgroundQueued = true;
    void this.#serialize(async () => {
      this.#backgroundQueued = false;
      if (this.#paused || this.#closing) return;
      try {
        await this.#drainLive();
      } catch (error) {
        this.#pause();
        try {
          this.reportError(error);
        } catch (reportingError) {
          console.error("会话后台写入告警失败", reportingError);
        }
      }
    });
  }

  #serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }

  async #drainLive(): Promise<void> {
    for (let batch = this.#batches[0]; batch; batch = this.#batches[0]) {
      await this.port.append(batch);
      this.#batches.shift();
    }
  }

  async #checkpoint(eventCount: number): Promise<void> {
    try {
      await this.#drainLive();
      await this.port.flush();
      // 空范围也要求起点已提交，检测未入队或绑定前漏写的前缀。
      await this.port.read(eventCount, 0);
    } catch (error) {
      this.#pause();
      throw error;
    }
    this.#paused = false;
    this.#startWindow();
  }

  #pause(): void {
    this.#paused = true;
    this.#sealWindow();
  }
}
