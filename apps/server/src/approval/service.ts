import { randomUUID } from "node:crypto";
import type { Session } from "@mharness/session/server";
import type { ApprovalOutcome, ApprovalReply } from "./contracts.ts";
type SessionEvent = ReturnType<Session["snapshot"]>["events"][number];
type Operation = Extract<SessionEvent, { type: "tool/operation" }>;
type Asked = Extract<SessionEvent, { type: "approval/asked" }>;
type Decided = Extract<SessionEvent, { type: "approval/decided" }>;
/** 渠道返回 null 表示不可用；拒绝时审批请求失败。信号由服务持有，在决定或失败后中止，不保证渠道已经退出。 */
export type ApprovalChannel = (asked: Asked, operation: Operation, signal: AbortSignal) => Promise<ApprovalReply> | null;
/** HTTP 答复状态与已确认决定。 */
export type ApprovalResponse = { status: 200 | 409; body: { id: string; outcome: ApprovalOutcome } } | { status: 409; body: { code: "approval_not_active" } } | { status: 404; body: { code: "approval_not_found" } };
type Pending = { session: Session; asked: Asked; ready: Promise<void>; done: Promise<ApprovalOutcome>; resolve: (outcome: ApprovalOutcome) => void; reject: (error: unknown) => void; queue: Promise<void> };
/** 审批持久化检查点失败；cause 保留存储层原错误，渠道失败不会包装为此类型。 */
export class ApprovalCheckpointError extends Error {
  /** @param cause - 检查点拒绝的原始原因。 */
  constructor(cause: unknown) { super("审批持久化检查点失败", { cause }); this.name = "ApprovalCheckpointError"; }
}
async function flush(session: Session): Promise<void> {
  try { await session.flush(); } catch (error) { throw new ApprovalCheckpointError(error); }
}
class ApprovalNotActive extends Error {}
function operationClosed(events: readonly SessionEvent[], operation: Operation): boolean {
  return events.some((e) => (e.type === "turn/end" && e.data.turn === operation.data.turn) ||
    (e.type === "tool/result" && e.data.turn === operation.data.turn && e.data.step === operation.data.step && e.data.message.source.callId === operation.data.callId));
}
function closed(events: readonly SessionEvent[], asked: Asked): boolean {
  const operation = events.find((e): e is Operation => e.type === "tool/operation" && e.data.operationId === asked.data.operationId);
  return !operation || operationClosed(events, operation);
}
/** 持有在线审批等待，所有答复共用唯一决定和持久化检查点。 */
export class ApprovalService {
  readonly #pending = new Map<string, Pending>();
  /** @param channel - 交互渠道；省略时等待 HTTP，null 表示没有渠道。 */
  constructor(private readonly channel?: ApprovalChannel | null) {}
  #key(sessionId: string, id: string): string { return JSON.stringify([sessionId, id]); }
  /**
   * 请求操作审批；重复请求共用等待，决定通过检查点后才返回。
   * @param session - 已绑定检查点的在线会话。
   * @param operation - 此会话已接受的操作，绑定其版本和参数。
   * @param reason - 展示给审批方的原因。
   * @param signal - 首次请求持有的 Turn 信号，取消时尝试保存 cancelled；重传沿用首次信号。
   * @returns 已持久化的决定；只有 allowed-once 可进入执行前检查点。
   * @throws 检查点失败以 ApprovalCheckpointError 拒绝；渠道失败保留原错误。
   */
  request(session: Session, operation: Operation, reason: string, signal: AbortSignal): Promise<ApprovalOutcome> {
    const events = session.snapshot().events;
    if (!events.includes(operation)) return Promise.reject(new Error("操作不属于会话"));
    if (operationClosed(events, operation)) return Promise.reject(new Error("审批已关闭"));
    const existing = events.find((e): e is Asked => e.type === "approval/asked" && e.data.operationId === operation.data.operationId);
    const asked = existing ?? session.append({ type: "approval/asked", data: { id: randomUUID(), operationId: operation.data.operationId, toolName: operation.data.toolName, reason, callId: operation.data.callId } });
    const key = this.#key(session.header.sessionId, asked.data.id);
    const previous = this.#pending.get(key);
    if (previous) return previous.done;
    const decision = events.find((e): e is Decided => e.type === "approval/decided" && e.data.id === asked.data.id);
    if (decision) return flush(session).then(() => decision.data.outcome);
    let resolve!: (outcome: ApprovalOutcome) => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<ApprovalOutcome>((yes, no) => { resolve = yes; reject = no; });
    const pending: Pending = { session, asked, ready: flush(session), done, resolve, reject, queue: Promise.resolve() };
    this.#pending.set(key, pending);
    const channelController = new AbortController();
    const abort = () => { void this.#settle(pending, "cancelled").catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending.ready.then(() => {
      if (signal.aborted || !this.#pending.has(key)) return;
      if (this.channel === null) return this.#settle(pending, "unavailable");
      if (this.channel) {
        const reply = this.channel(asked, operation, channelController.signal);
        if (reply === null) return this.#settle(pending, "unavailable");
        return reply.then((outcome) => { if (this.#pending.get(key) === pending) return this.#settle(pending, outcome); });
      }
    }).catch((error: unknown) => reject(error));
    void done.finally(() => { channelController.abort(); signal.removeEventListener("abort", abort); if (this.#pending.get(key) === pending) this.#pending.delete(key); }).catch(() => {});
    return done;
  }
  #settle(pending: Pending, outcome: ApprovalOutcome): Promise<ApprovalOutcome> {
    const task = pending.queue.then(async () => {
      await pending.ready;
      const events = pending.session.snapshot().events;
      let decided = events.find((e): e is Decided => e.type === "approval/decided" && e.data.id === pending.asked.data.id);
      if (!decided && closed(events, pending.asked)) throw new ApprovalNotActive();
      if (!decided) decided = pending.session.append({ type: "approval/decided", data: { id: pending.asked.data.id, outcome } });
      await flush(pending.session);
      pending.resolve(decided.data.outcome);
      return decided.data.outcome;
    });
    pending.queue = task.then(() => {}, () => {});
    void task.catch((error: unknown) => pending.reject(error));
    return task;
  }
  /**
   * 提交在线答复或查询历史决定，不加载旧审批。
   * @param sessionId - 会话标识。
   * @param id - 审批标识。
   * @param outcome - 客户端决定。
   * @param events - 在线快照或已提交历史。
   * @param session - 已加载会话；未加载时省略。
   * @returns 持久决定、冲突、已关闭或不存在的响应。
   * @throws 决定检查点失败时以 ApprovalCheckpointError 拒绝。
   */
  async respond(sessionId: string, id: string, outcome: ApprovalReply, events: readonly SessionEvent[], session?: Session): Promise<ApprovalResponse> {
    const asked = events.find((e): e is Asked => e.type === "approval/asked" && e.data.id === id);
    if (!asked) return { status: 404, body: { code: "approval_not_found" } };
    const pending = this.#pending.get(this.#key(sessionId, id));
    const decided = events.find((e): e is Decided => e.type === "approval/decided" && e.data.id === id);
    if (!decided && closed(events, asked)) return { status: 409, body: { code: "approval_not_active" } };
    let result: ApprovalOutcome;
    if (pending) {
      try { result = await this.#settle(pending, outcome); }
      catch (error) { if (error instanceof ApprovalNotActive) return { status: 409, body: { code: "approval_not_active" } }; throw error; }
    }
    else if (decided) { if (session) await flush(session); result = decided.data.outcome; }
    else return { status: 409, body: { code: "approval_not_active" } };
    return { status: result === outcome ? 200 : 409, body: { id, outcome: result } };
  }
}
