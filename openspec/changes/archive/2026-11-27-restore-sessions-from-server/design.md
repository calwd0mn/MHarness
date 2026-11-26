# Design

## Context

Web 目前从 `mharness.session-directory.v1` 初始化侧栏与选中项。会话 follow 已经从原始事件快照恢复历史和活动草稿。事件会话应用可以通过 `SessionPersistence.list()` 枚举已提交的会话头，但它没有覆盖尚未提交的注册，也无法仅凭会话头推导首次 Turn 或用户活动时间。

## Goals / Non-Goals

**Goals**

- 让同一个后端实例上的窗口实时收敛到同一份目录，各窗口在打开期间独立选择，启动时读取同一站点最后保存的选择。
- 在保留提前广播的同时，让确认失败、断线和重启后的目录与后端事实一致。

**Non-Goals**

- 账号或工作区归属、混存数据库归类、删除、归档和手动排序。
- 浏览器草稿持久化、历史分页和聊天 follow 的游标续订。

## Decisions

### 以持久化清单建立目录基线

应用入口负责装配目录查询能力，接入持久化清单、在线注册表、创建临时项和 SSE 进度。目录查询是注册会话路由的必需依赖，缺少依赖在装配时拒绝，不创建空目录兜底。依赖已装配但持久化读取失败时，由当次 GET 返回错误。只有成功查询并合并后确实没有会话才返回空列表。

1. 每次 `GET /api/sessions` 调用 `SessionPersistence.list()`，读取已提交会话头、事件数、继承事件数及可用的 `SessionListMetadata` 检查点。清单读取失败时返回错误。查询不写 SQLite、不读取事件正文，也不加载 Agent。
2. 清单返回后，读取当前在线 Session、Agent 和创建流程仍持有的临时项。按 `sessionId` 合并，已提交清单决定哪些会话已保存。尚未见于清单的临时项仍纳入结果。列表查询不裁决其创建结果，也不因清单暂时缺项撤回它。
3. 核对同 ID 的在线 `Session.header` 与 `SessionPersistenceSnapshot.header`，再生成摘要。比较 `createdAt` 及普通或分支身份，`isSeeded` 缺省与 `false` 等价。两边都是分支时比较原始 `parentSession` 和 `inheritedEventCount`。事件总数和摘要展示值不参与身份比较。身份兼容时采用在线状态。冲突时记录服务端诊断，按已提交记录生成冷摘要，不混入冲突的在线状态。
4. 按下表生成每个 ID 的唯一摘要。已提交但未发布 Agent 的分支按冷会话列入。与当前运行状态同步合并并捕获快照已覆盖的 SSE 进度，避免迟到的清单覆盖较新在线变化。排好序后返回 `{ revision, sessions }`。

| 摘要字段 | 身份兼容的在线会话 | 冷会话 | 创建临时项 |
| --- | --- | --- | --- |
| `sessionId`、`createdAt` | 在线会话头 | 已提交会话头 | 创建流程记录的原 ID 和创建时间 |
| `blank` | 实时投影 | 有效检查点的值，无可用检查点时为 `false` | 新建空会话为 `true` |
| `updatedAt` | `createdAt` 与实时 `lastPromptAt` 的较大值 | `createdAt` 与有效检查点的 `lastPromptAt` 的较大值 | `createdAt` |
| `running` | 对应 Agent 的公开运行状态 | `false` | 尚无运行中的 Agent 时为 `false` |
| `parentSessionId` | 在线分支头中的合法父 ID | 已提交分支头中的合法父 ID | 普通空会话省略 |

`lastPromptAt` 为 `null` 或无可用检查点时，活动时间取 `createdAt`。`lastPromptAt` 留在投影内部。格式合法的父 ID 即使没有对应目录项也保留，格式不合法时只省略该可选字段。时间使用 Unix 毫秒。列表按 `updatedAt` 降序，同一时间按 ID 升序。

GET 生成完整响应，可补齐分支或纠正任何已有摘要。GET 不派发目录 SSE，也不推进 `revision`。例如有效检查点可把查询结果的 `blank` 从 `false` 改为 `true`，并可纠正 `updatedAt`。发起查询的窗口采用新基线，其他窗口在各自下一次获取快照时看到这类纠正。

已提交但未发布 Agent 的分支由下一次列表 GET 补齐。没有新 GET 时，后端不为补录该分支单独扫描存储或推送通知。正常的会话注册、状态变更和创建撤回仍走实时通知，已经登记的创建核实任务独立运行。

### 保存会话目录元数据检查点

`SessionListMetadata` 同时有在线投影和 SQLite 检查点。本批仅保存会话目录元数据，通用的已注册投影检查点留作后续设计。

```ts
interface SessionListMetadata {
  readonly blank: boolean;
  readonly lastPromptAt: number | null;
}
```

新普通会话的投影从 `{ blank: true, lastPromptAt: null }` 开始。在线投影消费 Session 已接受的事件，`turn/start` 将 `blank` 置为 `false`，此后折叠继续保持 `false`。只有 `source.kind === "user"` 的 `user/message` 会推进 `lastPromptAt`，取旧值和事件时间中的较大值。分支的初始投影包含其继承前缀。对外活动时间取 `createdAt` 与 `lastPromptAt` 的较大值，后者为 `null` 时取 `createdAt`。

保存由已提交事件驱动，所有已提交事件都计入数量。默认累计 200 条事件或距第一条尚未纳入检查点的已提交事件满 5 秒时触发保存，后续事件沿用该计时器。创建提交、已提交的 `turn/end` 和会话释放时也触发保存。新空会话首次提交时保存初始投影及 `eventCount: 0`。每份检查点同时记录投影值和它对应的已提交 `eventCount`。保存只使用该前缀的事件，不复制可能已经包含未提交尾部的在线投影。写入检查点本身不改变目录版本。

启动重建和列表 GET 的冷会话摘要都以已提交会话元数据及其可用检查点为输入，不逐会话读取事件正文。检查点须对应当前会话，且覆盖与已提交 `eventCount` 相同的前缀。冷分支还须能验证检查点覆盖该子会话的继承边界。检查点缺失、无效、落后或无法验证时，使用 `blank: false` 和 `updatedAt: createdAt`，让会话保持可见并暂按创建时间参与排序。该默认值也适用于旧库中未保存检查点的空会话。未加载 Agent 的会话为 `running: false`。已有的执行中断恢复仍可按自身约定读取日志。

检查点的数值须在安全整数范围内，零事件检查点的 `lastPromptAt` 必须为 `null`。SQLite 域内合法但应用无法解码的检查点数值须在解码前隔离，只对该会话采用冷摘要默认值。

### 用注册、日志和 Agent 状态驱动目录通知

| SSE 通知 | 来源与内容 |
| --- | --- |
| `api-session/added` | 会话注册进入实例目录，发送完整摘要。注册可早于会话头提交 |
| `api-session/updated` | 首条 `turn/start` 追加到 Session 内存日志并获得 `seq` 时，将 `blank` 从 true 改为 false，发送 `{ sessionId, blank: false, seq }`。这一更新可以早于 SQLite 提交 |
| `api-session/status` | 对外 Agent 状态变化时发送 `{ sessionId, running }`。进入 running 可早于 `turn/start`。维护阶段映射为 false，退出运行的 false 在收尾完成、运行循环退出后广播 |
| `api-session/activity` | 接受真实用户的 `user/message` 后发送 `{ sessionId, updatedAt }`。只有消息时间更新时才推进目录时间 |
| `api-session/removed` | 确认尚未提交会话的首次创建失败后，以 `{ sessionId, reason: "creation-failed" }` 撤回注册 |
| `api-session/error` | 发送会话 ID 和可公开展示的错误文本，供已存在的前端会话对象记录 `lastAgentError` |

### 目录数据类型与业务监听器

```ts
type SessionId = string;
type DirectoryRevision = number;

type SessionSummary = Readonly<{
  sessionId: SessionId;
  createdAt: number;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  parentSessionId?: SessionId;
}>;

type SessionDirectorySnapshot = Readonly<{
  revision: DirectoryRevision;
  sessions: readonly SessionSummary[];
}>;

type SessionDirectoryListeners = {
  "api-session/added": (summary: SessionSummary) => void;
  "api-session/removed": (sessionId: SessionId) => void;
  "api-session/updated": (sessionId: SessionId, blank: false, seq: number) => void;
  "api-session/status": (sessionId: SessionId, running: boolean) => void;
  "api-session/activity": (sessionId: SessionId, updatedAt: number) => void;
  "api-session/error": (sessionId: SessionId, message: string) => void;
};

type SessionDirectoryEvent = keyof SessionDirectoryListeners;
type SessionDirectoryListener<E extends SessionDirectoryEvent> = SessionDirectoryListeners[E];

type SessionDirectorySubscription = {
  on<E extends SessionDirectoryEvent>(type: E, listener: SessionDirectoryListener<E>): () => void;
};
```

`SessionId` 沿用现有会话标识校验。时间为非负安全整数表示的 Unix 毫秒，`seq` 为来源会话内的非负安全整数。监听器同步接收只读业务值或其快照，返回值由发布方忽略。`on` 返回可重复调用的退订函数。撤回回调只传会话 ID，首版 SSE 撤回帧始终携带 `reason: "creation-failed"`。

### 目录版本与 SSE 数据

`DirectoryRevision` 是非负安全整数。目录 SSE 进度在当前进程内从 `0` 开始。后端主动发布目录变更时，在同一同步步骤更新实时状态、把进度加一并生成对应的帧。若同一输入产生多条变更帧，每帧各占一个连续序号。查询、检查点保存、相同值的重复通知及未改变摘要的持久化确认不推进进度，会话日志的 `seq` 独立推进。

在 `SessionDirectoryMutation` 中，`revision` 是该变更帧的序号。在 `SessionDirectorySnapshot` 中，`revision: N` 表示该完整快照已体现或覆盖截至 `N` 的实时变更。服务端在持久化清单返回后合并当前进程状态，并在同一同步步骤取得摘要和其覆盖的进度。只有实际覆盖到的进度才能写入快照。两次 GET 可以返回相同的 `revision` 和不同的摘要，客户端仍安装新快照。

```ts
type SessionDirectoryMutation =
  | { type: "api-session/added"; revision: DirectoryRevision; summary: SessionSummary }
  | { type: "api-session/removed"; revision: DirectoryRevision; sessionId: SessionId; reason: "creation-failed" }
  | { type: "api-session/updated"; revision: DirectoryRevision; sessionId: SessionId; blank: false; seq: number }
  | { type: "api-session/status"; revision: DirectoryRevision; sessionId: SessionId; running: boolean }
  | { type: "api-session/activity"; revision: DirectoryRevision; sessionId: SessionId; updatedAt: number };

type SessionDirectoryFrame =
  | SessionDirectoryMutation
  | { type: "api-session/ready" }
  | { type: "api-session/error"; sessionId: SessionId; message: string };
```

SSE 使用默认消息帧，`data` 为上述 JSON 对象。发布方在目录更新点捕获该变更的确切版本，业务回调只接收表中的领域参数。就绪帧仅发送给新连接。错误帧用于告知运行错误，与就绪帧均无 `revision`，无需参与目录重放。

通知本身为进程内派生数据。SQLite 保存会话头、原始日志和会话目录元数据检查点。确认头未提交且创建失败后撤回临时条目，提交结果待核对时以实际提交结果决定。重启后无已提交头的会话不进入目录，其余条目按检查点规则重建。释放已保存会话的 Agent 保留历史条目，其他 `removed` 原因待对应功能定义。

### 以会话头的提交结果决定创建响应

| 提交结果 | POST 响应和目录处理 |
| --- | --- |
| `flush()` 明确成功，或在响应前核实到属于本次创建的已提交会话头 | 返回 `201 Created` 和 `{ sessionId }`，确认同一目录项已保存。`flush()` 明确成功后跳过核实，后续 `close()` 错误单独记录。 |
| 响应前确认创建失败且会话头未提交 | 返回 `500` 和 `{ code: "session_creation_failed" }`。若已注册临时项，先移除再发布 `api-session/removed`。 |
| 响应时仍无法确定提交结果 | 返回 `503` 和 `{ code: "session_creation_unknown", sessionId }`，保留临时项，由后端继续核实。 |

创建流程遇到未知提交结果时，将原 `sessionId` 对应的临时项标记为待核实，并使用准备阶段已登记的 `attemptId` 启动核实。核实读取使用新的 SQLite 读事务。读到属于本次创建的已提交会话头即可确认保存。读不到头时，只有写入方已经确认原事务结束且未提交，才允许撤回。事务仍可能提交或读取暂时失败时，继续保留临时项。

每个 `(sessionId, attemptId)` 同时最多运行一个核实任务。读取前和应用结果前都检查目录项仍待核实且 `attemptId` 匹配。确认保存复用原摘要，不推进目录版本。确认未提交时先移除临时项，再发布一次带 `reason: "creation-failed"` 的撤回通知。

普通创建由 SessionCommandController 管理。控制器在准备写入前登记每个会话 ID 的当前尝试，保存不可变的预期会话头；尝试对象的身份用作目录创建的 attemptId，与 Agent 的流式 Attempt 无关。同一次意图共享写入 Promise，503 后仍保留本次尝试并独立核实。身份冲突不合并。只有确认未提交、撤回已应用且写入权已释放时，才让同 ID 的新尝试获得该位置。路由继续接受空对象并由服务端分配会话 ID，不加载 Agent。

存储层为首次创建提供与原事务绑定的核实能力。它独立于已关闭写句柄的读写能力，只清理原事务，使用新的 SQLite 只读快照确认提交。应用开始关停时先封住核实调度，再清理定时器，使后台迟到结果失效。正在核实的资源按存储生命周期释放。

后端从 250 ms 起安排延迟重试，逐步退避到几秒，短期重试耗尽后转为低频。确认提交、确认未提交或尝试被替换时停止重试。核实独立于客户端连接。应用关闭时清理定时器，待核实状态和定时器仅存在于进程内，重启后从 SQLite 已提交的会话头及可用目录检查点重建目录。

`GET /api/sessions/:sessionId` 始终只读。它返回读取时看到的历史或缺失结果，其响应不确认保存、不撤回目录项。Web 在收到 `503` 后保留原 ID，通过目录通知和重连后的快照同步条目，目录中存在该 ID 本身不代表已确认保存。

### 先订阅，后读快照，再按版本合并

目录 SSE 采用独立入口 `GET /api/session-directory/events`。服务端先注册监听器，将 `api-session/ready` 排为首个业务帧，随后按顺序发送该订阅捕获的通知。Web 每次启动或重连使用新的连接代次，收到就绪帧后发起 GET。在安装本代次快照前，Web 保留已展示的目录，按接收顺序缓存本代次的目录变更。已展示目录的版本只属于旧代次。

以本代次 GET 快照的 `revision` 为基线，按接收顺序重放比快照更新的变更。重放和实时应用时，忽略低于或等于当前版本的变更，下一条有效变更的版本必须等于当前版本加一。重放成功后一次性发布合并结果，再以该结果核对选择。安装完成后的变更实时应用。发现版本缺口、断线或服务端无法维持连续交付时，重新订阅并取全量快照。切换代次或请求失效时丢弃旧回调。重启后的快照版本可以低于旧代次。例如，旧目录版本为 20，新代次先收到版本 1 的通知，再收到版本 0 的快照，最终安装版本 1。目录连接随页面存在，不随选中会话切换。

同一站点三个标签页各自保持目录和聊天订阅时，HTTP/1.1 的六条浏览器连接可能全部被长流占用。默认 Web 开发入口使用 Vite 的本地 HTTPS 和 HTTP/2。浏览器在同一连接上多路复用 SSE 和普通 API 请求，Vite 沿用同源 `/api` 代理并向本地 Fastify 流式转发。开发证书由 Vite 插件生成并缓存在依赖目录中。HTTP 和 HTTPS 分别持有浏览器选中提示，已保存会话仍由同一后端提供。

### 恢复选中项和保留本页操作

同一浏览器、同一站点的窗口使用共享 `localStorage` 键 `mharness.sessions.current` 保存 JSON 格式的 `SessionSelection`。各窗口在内存中独立维护当前选择，其他窗口写入共享键时，本页仍保持当前选择。每次启动或刷新读取共享键作为恢复提示，成功合并目录后再验证提示。目录读取失败时保留提示与已有目录并允许重试。侧栏从全量副本中过滤未选中的空会话。

若窗口 B 新建并选中空会话 Y，窗口 A 在查看其他会话期间继续隐藏 Y。A 刷新时，若共享键仍指向 Y 且 Y 在合并后的目录中，A 恢复选中并显示 Y。若共享键为空或指向其他会话，A 刷新后仍隐藏 Y。

```ts
interface SessionSelection {
  sessionId?: SessionId;
  subagentAddress?: SubagentAddress;
}

export type SubagentAddress =
  & {
    readonly parentSessionId: SessionId;
    readonly childSessionId: SessionId;
  }
  & (
    | { readonly mode: "one-shot" }
    | { readonly mode: "continuable" }
  );
```

`sessionId` 表示侧栏所选的顶层会话。若使用 `subagentAddress`，其 `parentSessionId` 与顶层 `sessionId` 一致。当前版本仅预留该字段，选择恢复及 follow 均按顶层 `sessionId` 执行，当前页面产生的选择值为 `{ sessionId }` 或 `{}`。

`projectList()` 以当前目录确认选择。确认会话在目录中且选择发生变化时立即写入共享键，follow 随后加载。选择以 `sessionId` 及地址字段值比较，目录刷新、消息或 `running` 变更导致的对象重建不会重复写入。主动清除选择，或目录更新使 `projectList()` 确认当前选择变为空时，写入 `{}`。等待首次目录结果的空状态无需写入，从共享键成功恢复同一选择也无需回写。

新键缺失时，首次升级可从旧键读取合法的 `selected`。新键中的 `{}` 表示已清除选择，优先于旧键。启动期间若目录确认旧提示失效，只在共享键仍对应本次读取的提示时写入 `{}`，保留其他窗口在等待期间保存的新选择。

本页在 POST 创建成功后立即显示新会话，并在用户期间未主动改选时自动选中。目录摘要尚未到达时，`projectList()` 可以用 POST 已确认的新建条目确认该选择，收到目录摘要后按 ID 合并。用 POST 的结果保护创建后的本地条目和选择，直到包含该会话的版本或在 POST 成功后开始的 GET 完成对账。用户选择后的会话打开故障保留选中并允许重试。聊天继续使用单会话 follow 的快照和重连逻辑。

## Risks / Trade-offs

- 提前发布空会话会产生暂态目录条目。确认创建失败时带原因撤回，进程中断后由重连列表收敛。
- 首版发送全量目录。摘要只含侧栏需要的元数据，重连使用快照代替持久化的目录通知回放。
- 开发和生产共用同一 SQLite 文件时会得到同一目录。部署使用独立的 `MHARNESS_SESSION_DB_PATH`。

## Migration Plan

先部署目录 GET 与 SSE，再部署消费它们的 Web。既有 SQLite 会话没有可用检查点时使用冷目录默认值，升级不为目录回填而扫描既有日志。升级时从旧键迁移选中提示并清理旧目录键。Web 回退后，旧侧栏会从浏览器重新积累目录。
