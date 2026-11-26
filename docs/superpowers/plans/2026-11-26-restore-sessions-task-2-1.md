# 会话目录任务 2.1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development and superpowers:test-driven-development. 逐组运行回归测试并记录红灯原因与绿灯结果。

**目标**：让同一后端的窗口订阅目录实时变化，先收到就绪，然后按实例内版本接收变更。

**架构**：SessionDirectory 在已有同步更新点构造完整的共享帧，以同一分发顺序通知类型化业务回调及连接订阅。Fastify 的独立 SSE 路由使用现有共享帧契约，并管理连接缓冲和退订。

**技术栈**：TypeScript、Zod、Fastify、Node.js streams、Node.js test runner、pnpm。

## 基线与范围

- 使用已确认的 `openspec/changes/restore-sessions-from-server/{design.md,tasks.md,specs/execution-streaming/spec.md}` 与 `GLOSSARY.md`。任务 2.1 包含服务端的六种通知与就绪、共享帧序号和连接生命周期，以及 GET 的隔离行为。客户端快照合并属于 2.2。
- 复用分支 `feat/restore-sessions-from-server`。当前 HEAD `58911490fb29b7cf32a90b8177b10f02e1cf278b` 仅提交第一批，已验收的 1.3 仍有工作区文件，包括未跟踪文件。已用临时 Git 索引捕获 1.3 代码基线，树为 `e8aedc6b2012fbeabf20caf0d5f86d2498182107`，与上一轮通过评审的树一致。对应文件须包含 1.3 的实现和测试，评审时两路看同一份从该基线开始的 2.1 差异。保持既有暂存、Web 工作和 1.3 的结果。
- 使用 PowerShell 7、严格 TypeScript、中文 JSDoc。2.1 的回归用例在开发启动后先红，再写最小实现。

## A. 目录业务监听和版本

**修改** `apps/server/src/session/directory.ts`。**测试** `apps/server/src/session/directory.test.ts`、`apps/server/src/session/directory-live.test.ts`。

- [ ] 使用已有 SessionDirectory、AgentManager 和创建控制器夹具，订阅全部业务类型。注册一个待确认空 Session 后断言 added 携带完整摘要，重复注册不重复通知。确认持久化不推进版本。对另一个待确认条目重复撤回，断言仅一次 removed。用真实 Agent 驱动和门闩确认顺序为 running、updated、activity、error、idle，updated 的 seq 为已接受的首次 Turn，error 不改变版本。先跑 `pnpm --filter @mharness/server exec node --import tsx --test src/session/directory.test.ts src/session/directory-live.test.ts`，期待因缺业务订阅或新增/撤回帧失败。
- [ ] 在 SessionDirectory 声明 `SessionDirectoryListeners`、`SessionDirectoryEvent`、`SessionDirectoryListener<E>` 与 `SessionDirectorySubscription`，实现 `on<E>(type, listener): () => void`。业务回调使用设计表的参数次序。对外回调摘要提供只读值或独立快照，退订可重复调用。沿用已有 `onObservation` 消费完整帧的同步队列，在一个类型化分发边界解包业务参数。SSE 完整帧在变更点就捕获 revision，业务回调无需读取当前版本或自行分配。
- [ ] 在 `register` 安装摘要及临时状态、`remove` 实际移除之后，通过已有队列发出 added 和 removed，保留原来一次递增的位置。removed 仅由创建失败路径产生，HTTP 帧固定携带 `creation-failed`。保留 Agent 先于 turn/start 通知运行、错误与活动时序、无变化去重。新测试覆盖重复退订，对一个观察者异常或同步触发另一变更时，其他订阅仍按版本顺序收帧。上述定向命令全部通过。

## B. 独立目录 SSE

**新建** `apps/server/src/session/directory-events.ts`、`apps/server/src/session/directory-events.test.ts`、`apps/server/src/session/directory-events-acceptance.test.ts`。**修改** `apps/server/src/app.ts`。真实 HTTP 验收使用独立连接验证客户端取消和应用关停。

- [ ] 先写 HTTP 验收，调用 `GET /api/session-directory/events` 并解析默认 SSE 消息，首帧必须恰为 `{"type":"api-session/ready"}`。建立两个订阅后，用公开 HTTP 路由创建、发 prompt、阻塞和放开收尾、再创建、注入确认失败。断言每个连接得到相同的连续变更序号，错误与就绪均没有 revision。SQLite 首次创建注入可复用 `routes-acceptance.test.ts` 的可控存储模式。额外测试在注册监听时同步触发一条变更时仍先读到 ready。运行 `pnpm --filter @mharness/server exec node --import tsx --test src/session/directory-events.test.ts`，预期旧版返回 404 或缺帧。
- [ ] 在应用装配处注册显式目录 SSE 路径，连接开始才读取当前 SessionDirectory，避免捕获启动恢复前的实例。订阅完整帧后先产出 ready，捕获与 ready 交错的帧依序入队。按现有 `follow.ts` 的 async generator、`Readable.from` 和 AbortSignal 模式处理网络断开与 app `preClose`，在 `finally` 退订。发送 `text/event-stream; charset=utf-8` 与 `Cache-Control: no-cache`，沿用 SSE 心跳注释惯例。采用已有 follow 的有界缓冲思路，慢连接溢出时关闭该连接供重连，避免发出协议外错误或影响其余连接。取消/关闭测试等待生产订阅释放，无需固定延迟。
- [ ] 挂着两个目录订阅，在真实库直接提交一个未发布 Agent 的分支。验证订阅建立与闲置期间无存储清单调用、无分支补录。窗口 A 的列表 GET 能补齐分支、校正旧冷摘要且版本不变，随后用正常注册的标记帧检查两个连接在该标记前均没有收到补录帧；检查 B 自己查询后才看到校正。对 `list/open` 设置可核对的调用计数，使用门闩或标记避免脆弱的无消息等待。
- [ ] 复用 `packages/session/src/api/directory.ts` 的 `sessionDirectoryFrameSchema` 和 contracts 导出，在 SSE 序列化边界校验。观察与关闭路径不加载 Agent、不打开事件正文、不触发重扫。运行 B 的定向命令及 `pnpm --filter @mharness/server exec node --import tsx --test src/session/routes-acceptance.test.ts src/session/directory.test.ts src/session/directory-live.test.ts`，预期全部通过。

## C. 总体验证

计划评审补充的验收条件：

- 用可控时钟让 prompt 的时间严格晚于创建时间，避免同一毫秒无法触发 activity。保持一条 SSE 打开并等待 `app.close()` 完成，另测客户端取消其中一条连接后，另一条仍收到标记帧。等待可控心跳后检查 `list/open` 调用数。
- 评审候选用临时索引显式纳入新文件，基线与结果用 tree-to-tree 差异比较。任务文档只允许出现 2.1 的勾选，已有 1.3 勾选作为基线核对。

- [ ] 独立运行 `pnpm typecheck`、`pnpm --filter @mharness/server test`、`pnpm --filter @mharness/web test` 和 `openspec validate restore-sessions-from-server --strict`。记录结果，核对新增或变更声明的中文 JSDoc。
- [x] 冻结仅包含 2.1 的评审差异。MHarness 项目评审和 Codex 原生评审分别检查同一候选的就绪时序、版本、快照隔离、退订与关闭。通过后勾选 2.1，保留其他未开始任务。

候选 `cdbede495f28a344d30d794c99183be17e4844c8` 的服务端 719 项、Web 178 项、类型检查及 OpenSpec 严格校验均通过。两路评审发现缓冲溢出后的连接与订阅泄留，项目评审以实际 HTTP 暂停读取复现。原测试主动拉取下一帧，须补上客户端始终暂停时服务端仍主动关闭并退订的回归。Codex 原生评审另指出摘要隔离的断言放在监听函数里，可能被分发器捕获，须移到回调外验证。

最终候选 `34158423e04a8413bd977754b7e94a7f8c917b76` 补齐真实暂停连接的红绿回归，并将摘要隔离断言移出回调。反向验证模拟只退订而不关闭套接字时，测试按时失败并自行清理。服务端 720 项、Web 178 项、类型检查、OpenSpec 严格校验和两路独立复审均通过。
