import type { SessionEvent } from "./events.ts";
import type { SessionHeader } from "./session.ts";

/** 只读访问不争夺写入权；写访问持有会话生命周期内唯一的写入权。 */
export type SessionAccess = "read" | "write";

/** 准备新会话写句柄时使用的继承信息和取消信号。 */
export interface SessionPersistenceCreateOptions {
  /** 当前会话继承的事件数，省略时为 0；不包含子会话自己的 seed 标记。 */
  readonly inheritedEventCount?: number;
  /** 取消取得写句柄的过程，不取消取得句柄后的写入或关闭。 */
  readonly signal?: AbortSignal;
}

/** 创建准备失败但写入权尚待释放，调用方须保留核实函数直至得到终态。 */
export class SessionCreationCleanupError extends Error {
  /** @param cause - 创建准备阶段的原始错误。 @param verify - 锁释放后返回 failed，未确认释放时返回 unknown。 */
  constructor(cause: unknown, readonly verify: () => Promise<"failed" | "unknown">) {
    super("会话创建准备失败，写入权清理待确认", { cause });
  }
}

/** 一次查询中已提交的会话元数据，不包含尚在准备的 header。 */
export interface SessionPersistenceSnapshot {
  readonly header: SessionHeader;
  /** 当前会话自身继承的事件数。 */
  readonly inheritedEventCount: number;
  /** 已提交事件总数，包含继承事件和 seed 标记。 */
  readonly eventCount: number;
  /** 对应已提交前缀的目录检查点；缺失或无效时不可用于恢复摘要。 */
  readonly listMetadata?: SessionListMetadata;
}

/** 绑定会话及其已提交事件前缀的目录检查点。 */
export interface SessionListMetadata {
  readonly blank: boolean;
  readonly lastPromptAt: number | null;
  readonly eventCount: number;
  readonly inheritedEventCount: number;
}

/** 绑定单个会话的持久化访问；持有者负责关闭句柄。 */
export interface SessionHandle {
  readonly id: string;
  readonly header: SessionHeader;
  readonly access: SessionAccess;
  readonly inheritedEventCount: number;

  /**
   * 核实本句柄首次创建的原写事务已经终止，并在仍属本次尝试时重试清理。
   * 关闭开始前返回 false；关闭开始后等待关闭结束再核实。关闭后仍可调用，无法确认时返回 false，不影响后续事务。
   * @returns 原事务确定结束时为 true。
   */
  confirmCreationEnded?(): Promise<boolean>;

  /**
   * 取得首次创建的独立核实能力；关闭句柄或存储后仍可调用。
   * @returns 返回异步核实函数：只有身份匹配才为 committed，原事务结束且写入权释放才为 failed，无法确认时为 unknown。
   */
  creationVerifier?(): () => Promise<"committed" | "failed" | "unknown">;

  /**
   * 读取同一截点的已提交前缀，不排空待写缓冲。
   * @param offset - 起始位置，默认为 0；必须是非负安全整数且不超过该截点的事件数。
   * @param length - 读取数量，省略时读到截点末尾；必须是非负安全整数且完整区间已提交。
   * @returns 指定范围内的已提交事件；末尾位置配合零长度返回空数组。
   * @throws 参数无效、范围未覆盖、记录无效或句柄已关闭时拒绝。
   */
  read(offset?: number, length?: number): Promise<readonly SessionEvent[]>;

  /**
   * 原子提交连续事件批次；首次非空批次同时提交准备中的 header 和继承数。
   * 确认整批回滚且仍持有写入权时可重试原批次。结果不确定时实现须先确认事务终止并核对已提交记录；
   * 无法可靠核对或出现部分匹配、冲突时保持写入阻塞。
   * @param events - 从当前已提交前缀末尾连续排列的完整批次。初始空会话应通过 flush 提交。
   * @returns 整批提交得到确认后兑现。
   * @throws 只读、已关闭、批次无效、绑定写入器已有待核对批次或提交及核对失败时拒绝。
   */
  append(events: readonly SessionEvent[]): Promise<void>;

  /**
   * 执行持久性屏障；对准备中的普通空会话显式调用时提交空 header。分支通过首次非空批次提交。
   * 绑定写入器的普通批次待核对时，经写入器确认该批次，其他缓冲交由会话检查点。
   * 暂存结果待核对时经同一写入器处理；暂存占位尚未进入核对时拒绝。
   * @returns 屏障成功后兑现，不保证操作系统已将数据刷至物理介质。
   * @throws 只读、已关闭、暂存占位尚未进入核对、分支尚未提交首批或持久化失败时拒绝。
   */
  flush(): Promise<void>;

  /**
   * 关闭句柄并释放其资源；已发布的写句柄先处理待写事件，准备中的句柄只释放资源和写入权。
   * 关闭不可取消且幂等；处理失败时仍尝试释放写入权并报告错误，关闭后其他操作均拒绝。
   * @returns 资源和写入权释放后兑现；释放失败时拒绝。
   */
  close(): Promise<void>;
}

/** 会话持久化服务；实现负责写入所有权、已提交视图及提交结果核对。 */
export abstract class SessionPersistence {
  /**
   * 校验标识并取得写入权，准备 header 和继承数；普通查询在首次提交前不可见。
   * @param header - 新会话元数据。
   * @param options - 继承数与取得写句柄期间的取消信号。
   * @returns 由调用方负责关闭的写句柄。
   * @throws 标识无效、所有权冲突或取得句柄被取消时拒绝；冲突须可与其他错误区分。准备失败且释放未确认时以 SessionCreationCleanupError 提供核实能力。
   */
  abstract create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle>;

  /**
   * 打开已提交会话；写访问取得唯一写入权，已有写入者时仍允许只读打开。
   * @param sessionId - 会话标识。
   * @param access - 所需访问模式。
   * @returns 未找到已提交会话时为 undefined，否则为由调用方关闭的句柄。
   * @throws 标识无效时拒绝，写入权冲突时以可区分的错误拒绝。
   */
  abstract open(sessionId: string, access: SessionAccess): Promise<SessionHandle | undefined>;

  /**
   * 查询一个会话的已提交元数据和事件总数，无需读取事件正文。
   * @param sessionId - 会话标识。
   * @returns 已提交元数据；不存在或尚在准备时为 undefined。
   * @throws 标识无效时拒绝。
   */
  abstract stat(sessionId: string): Promise<SessionPersistenceSnapshot | undefined>;

  /** @returns 所有已提交会话的元数据，不包含尚在准备的会话。 */
  abstract list(): Promise<readonly SessionPersistenceSnapshot[]>;

  /**
   * 捕获调用时的活跃写入器，逐个排空并执行持久性屏障，不提交准备中的句柄。
   * 单个写入器失败后继续处理其余写入器，最终以 AggregateError 汇总失败；每项保留会话标识和原错误。
   * @returns 所有选定写入器成功完成后兑现。
   */
  abstract flush(): Promise<void>;
}
