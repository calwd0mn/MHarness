# MHarness

本地 Agent Harness 原型。开发环境需要 Node.js 24 和 pnpm 10。

```sh
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:5173`，新建会话即可使用进程内模拟模型进行纯文本问答。页面支持会话切换、按会话取消、刷新恢复，以及发送结果未知时使用原编号重试。开发服务将 HTTP 和 SSE 的 `/api` 请求转发到 Fastify。

`pnpm typecheck` 检查全部工作区包的 TypeScript 类型。

## 工具执行与审批

`apps/server/src/tools/` 提供本地工具注册、参数准备、结构化结果归一化和 Session 结果追加入口。输入 Zod 定义同时导出模型可见 JSON Schema，准备失败区分未知工具、非法 JSON 与参数不符合约束；准备不会请求审批或执行正文。调用方执行已准备调用前须完成审批、持久化检查点与取消检查。

本地成功值通过输出契约校验后，从同份不可变参数和值派生模型内容及展示数据。普通异常只返回安全说明。Session 结果保存已派生内容、展示元数据和可用错误分类，省略原始业务值；重放不会重新渲染。`pnpm --filter @mharness/server test` 包含输入 JSON Schema 对照、结果失败及 SQLite 重开测试。

通过 `createModelTurnDriver` 的 `toolRegistry` 与 `approvalService`，或 `createEventSessionApp` 第四参数中的同名选项接入工具。完整 Assistant 消息通过检查点后，独立批次按模型声明顺序保存调度、校验参数、绑定操作并应用可信策略；允许或已批准的调用仍须通过正文前检查点及取消状态门。调用结果和当前 Step 关闭记录提交后才请求模型续答。默认启动仍使用纯文本模拟模型，不附带业务工具。

`apps/server/src/approval/` 拥有审批服务、答复 Schema 和 HTTP 路由。操作和审批请求提交后才交互，等待期间 Turn 保持活动，历史读取和取消可用，新编号仍返回 `409 agent_busy`。HTTP 和审批渠道共用唯一持久决定；`ApprovalService` 省略渠道表示等待 HTTP，显式传入 `null` 表示不可用。工具正文可接收取消信号；可靠协作退出的工具等待清理，其他工具停止等待后不声称执行端已停止或副作用已撤销。

批次保存成功结果的 `concludeTurn` 供后续 2.8 使用，当前驱动尚未消费结束意向。MCP、完整超时策略和前端审批交互仍按后续任务推进。

## Session 模块

- 浏览器契约入口为 `@mharness/session/contracts`，共享原始事件 Schema、持久历史封装及 prompt 契约。
- `@mharness/session/server` 供后端装配 Session、SQLite 存储与启动修复。核心事件和持久化接口分别位于 `packages/session/src/events.ts`、`packages/session/src/persistence.ts`。
- 已绑定写入器按会话以 200ms 固定窗口串行追加事件。`session.flush()` 会立即排空缓冲并确认持久前缀；历史查询只读取已提交记录。后台写入失败后保留原批次，在显式 flush 或关闭时按事务结果处理。

## 新版会话存储

开发服务器默认使用 `data/mharness-events.sqlite`。可通过 `MHARNESS_SESSION_DB_PATH` 指定其他新版事件库，相对路径从仓库根目录解析。

```powershell
$env:MHARNESS_SESSION_DB_PATH = 'data/mharness-events.sqlite'
pnpm dev
```

创建只提交空 header。历史读取返回已提交的原始事件前缀，follow 快照与增量读取在线 Session 已接受的事件。历史查询不会排空缓冲，实时回答可先于后台落盘显示。启动会修复未结束的 Turn，不自动续跑模型。

每个在线库由单个后端持有实例锁。实例和会话锁保存在数据库文件旁的 `<数据库文件名>.locks/` 目录，进程退出后会释放锁。锁文件保留供后继进程复用。

旧格式和未知版本的数据库会被拒绝。原有 `data/mharness.sqlite` 应保留，并通过运行对应旧版本回退。清除环境变量将使用默认新版路径。

## 会话接口

```powershell
$api = 'http://127.0.0.1:5173/api'
$session = Invoke-RestMethod -Method Post -Uri "$api/sessions"
$accepted = Invoke-RestMethod -Method Post -Uri "$api/sessions/$($session.sessionId)/messages" -ContentType 'application/json' -Body '{"requestId":"req-1","content":[{"type":"text","text":"你好"}]}'
$history = Invoke-RestMethod -Uri "$api/sessions/$($session.sessionId)"
$cancel = Invoke-RestMethod -Method Post -Uri "$api/sessions/$($session.sessionId)/cancel"
```

- 创建会话返回 `201` 和 `{"sessionId":"…"}`，创建时不调用模型。
- 提交首次受理和原编号重发均返回 `202 {"accepted":true}`，确认内存受理。相同编号沿用首次正文。修改正文或主动再发应生成新编号，忙碌时新编号返回 `409 {"code":"agent_busy"}`。
- 读取历史返回 `200`。空会话为 `{"sessionId":"…","inheritedEventCount":0,"cursor":-1,"records":[]}`，事件序号从 0 连续递增。
- `GET /api/sessions/:sessionId/follow` 使用 SSE。首帧是完整快照，后续交付原始事件及 Assistant 实时流。关闭连接或切换会话只停止观察，Turn 继续运行。同步故障会终止当前流并允许用户主动重试。
- 取消已加载会话返回 `202 {"accept":true}`，结果通过历史或 follow 确认。未加载会话返回 `404 {"code":"session/not-found"}`，取消请求不会加载 Agent。存储阻塞时新提交返回 `503`。
- 浏览器本地目录保存会话编号及选中项，刷新后重新通过 follow 安装快照。本地存储不可用时仅在当前页面保留目录。当前模型为模拟 Adapter，真实 Provider、MCP 接入、完整超时策略和压缩按 OpenSpec 的后续任务交付。

## 审批答复接口

从原始 `approval/asked` 取得审批 `id`，以其 `operationId` 关联 `tool/operation` 中绑定的工具、版本和参数。答复使用审批 `id`，不由客户端重新提交操作参数。

```powershell
$approvalId = '从 approval/asked 取得的 id'
Invoke-RestMethod -Method Post -Uri "$api/sessions/$($session.sessionId)/approvals/$approvalId/decision" -ContentType 'application/json' -Body '{"outcome":"allowed-once"}'
```

- 请求仅接受 `{ "outcome": "allowed-once" | "rejected" }`。
- 首次决定提交后及同决定重发返回 `200 { id, outcome }`；相反决定或已有 `cancelled`、`unavailable` 决定返回 `409` 和原决定。
- 对已有请求、无持久决定、但因工具结果或 Turn 终态关闭的审批返回 `409 { code: "approval_not_active" }`；审批不存在返回 `404`。
- 同意只允许进入执行前检查点；用户明确拒绝和取消会停止本批后续派发并保存配对结果。重启修复保留原审批请求且不重新执行工具。
- 审批检查点失败不会放行工具，并关闭对应 Agent 的存储准入；渠道失败单独处理，不冒充存储故障。接口兑现不表示浏览器已经收到后续事件。
