# MHarness

本地 Agent Harness 原型。开发环境需要 Node.js 24 和 pnpm 10。

```sh
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:5173`，新建会话即可使用进程内模拟模型进行纯文本问答。页面支持会话切换、按会话取消、刷新恢复，以及发送结果未知时使用原编号重试。开发服务将 HTTP 和 SSE 的 `/api` 请求转发到 Fastify。

`pnpm typecheck` 检查全部工作区包的 TypeScript 类型。

## DeepSeek 最小验证

默认仍使用 Mock。要手动验证 DeepSeek，在 PowerShell 7 中配置凭据、临时数据库与低输出上限，然后启动后端：

```powershell
$env:MHARNESS_MODEL_PROVIDER = 'deepseek'
$env:DEEPSEEK_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'DeepSeek API key' -AsSecureString)).Password
$env:MHARNESS_MODEL_MAX_TOKENS = '64'
$env:MHARNESS_SESSION_DB_PATH = Join-Path $env:TEMP ("mharness-deepseek-" + [guid]::NewGuid() + '.sqlite')
pnpm --filter @mharness/server dev
```

在另一个 PowerShell 7 窗口提交一次纯文本并查询历史：

```powershell
$api = 'http://127.0.0.1:3000/api'
$session = Invoke-RestMethod -Method Post -Uri "$api/sessions" -ContentType 'application/json' -Body '{}'
$body = @{ requestId = [guid]::NewGuid().ToString(); content = @(@{ type = 'text'; text = '请用一句话打招呼。' }) } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri "$api/sessions/$($session.sessionId)/messages" -ContentType 'application/json' -Body $body
Invoke-RestMethod -Uri "$api/sessions/$($session.sessionId)" | ConvertTo-Json -Depth 30
```

受理返回后可能需要稍后重新查询历史。预期看到 `request/header` 中的 `deepseek-v4-pro`、Assistant 正式回答及 `turn/end` 的 `completed`；`max-tokens` 表示输出上限截断。真实请求会使用相应 Provider 账户。自动测试使用受控传输，不访问外部账户；本次实现未执行真实密钥验证。

可选配置 `MHARNESS_MODEL_REASONING_EFFORT` 为 `none`、`low`、`high` 或 `max`，以及 `MHARNESS_MODEL_TEMPERATURE`、`MHARNESS_MODEL_STOP`（JSON 字符串数组）。推理模式不接受显式温度。退出后端后，在原窗口清除模型配置和凭据即可恢复 Mock：

```powershell
Remove-Item Env:MHARNESS_MODEL_PROVIDER, Env:DEEPSEEK_API_KEY, Env:MHARNESS_MODEL_MAX_TOKENS, Env:MHARNESS_SESSION_DB_PATH -ErrorAction SilentlyContinue
Remove-Item Env:MHARNESS_MODEL_REASONING_EFFORT, Env:MHARNESS_MODEL_TEMPERATURE, Env:MHARNESS_MODEL_STOP -ErrorAction SilentlyContinue
pnpm --filter @mharness/server dev
```

## 工具执行与审批

`apps/server/src/tools/` 提供本地工具注册、参数准备、结构化结果归一化和 Session 结果追加入口。输入 Zod 定义同时导出模型可见 JSON Schema，准备失败区分未知工具、非法 JSON 与参数不符合约束；准备不会请求审批或执行正文。调用方执行已准备调用前须完成审批、持久化检查点与取消检查。

本地成功值通过输出契约校验后，从同份不可变参数和值派生模型内容及展示数据。普通异常只返回安全说明。Session 结果保存已派生内容、展示元数据和可用错误分类，省略原始业务值；重放不会重新渲染。`pnpm --filter @mharness/server test` 包含输入 JSON Schema 对照、结果失败及 SQLite 重开测试。

通过 `createModelTurnDriver` 的 `toolRegistry` 与 `approvalService`，或 `createEventSessionApp` 第四参数中的同名选项接入工具。完整 Assistant 消息通过检查点后，独立批次按模型声明顺序保存调度、校验参数、绑定操作并应用可信策略；允许或已批准的调用仍须通过正文前检查点及取消状态门。调用结果和当前 Step 关闭记录提交后才请求模型续答。默认启动仍使用纯文本模拟模型，不附带业务工具。

`apps/server/src/approval/` 拥有审批服务和 HTTP 路由，答复 Schema 由 `@mharness/session/contracts` 共享给前后端。操作和审批请求提交后才交互，等待期间 Turn 保持活动，历史读取和取消可用，新编号仍返回 `409 agent_busy`。HTTP 和审批渠道共用唯一持久决定；`ApprovalService` 省略渠道表示等待 HTTP，显式传入 `null` 表示不可用。工具正文可接收取消信号；可靠协作退出的工具等待清理，其他工具停止等待后不声称执行端已停止或副作用已撤销。

成功结果携带 `concludeTurn` 时，本批剩余调用仍按序结算；明确业务错误不撤销该意向。批次完成后 Turn 以 `completed` 结束，不生成下一 Step 或额外总结。用户拒绝、取消、派发异常及超时中止优先，同一 Agent 可继续处理后续 Turn。

工具默认等待超时为 30 秒，可信注册可覆盖，取值须大于 0 且不超过 2_147_483_647 毫秒。执行计时从实际派发开始，审批及检查点等待不消耗该时间。本地且保证协作退出的工具在超时或取消后等待正文与清理退出，期间 Turn 保持活动；退出保证违约可能导致长期等待。远程或无退出保证的调用传播取消后停止等待，不声称执行端已经停止或副作用已撤销。

工具超时保存配对的 `TOOL_TIMEOUT`。只读超时按 Turn 跨 Step 累计，默认前两次可继续，第三次以 `READ_ONLY_TIMEOUT_BUDGET_EXHAUSTED` 结束。副作用或未知能力工具超时且结果未确认时，以 `TOOL_TIMEOUT` 结束本轮，剩余调用保存未执行结局，不请求模型续答。已派发取消但结果未确认保存 `ABORTED`。幂等与查询能力不会触发重试或核实；迟到响应或拒绝不改写已结算结果、不恢复本轮。默认值集中于 `config/local.ts`，模型最大步数仍为 8。

前端工具卡片在折叠时显示原始参数摘要，展开可核对工具版本、已校验参数、结果和展示元数据。审批支持单次允许与拒绝，刷新可恢复待审批项，已有决定按服务端结果收敛，关联结果或 Turn 终态关闭交互。`pnpm --filter @mharness/web test` 包含真实 HTTP/SSE、Agent 与临时 SQLite 驱动 App 的审批和工具状态联调，使用模拟 Provider 和本地测试工具，不访问用户数据库或外部副作用工具。

模拟 MCP 已可按下方说明显式启用，模拟写入支持持久幂等。迟到结果入账与核实、恢复执行仍按后续任务推进。

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
$session = Invoke-RestMethod -Method Post -Uri "$api/sessions" -ContentType 'application/json' -Body '{}'
$accepted = Invoke-RestMethod -Method Post -Uri "$api/sessions/$($session.sessionId)/messages" -ContentType 'application/json' -Body '{"requestId":"req-1","content":[{"type":"text","text":"你好"}]}'
$history = Invoke-RestMethod -Uri "$api/sessions/$($session.sessionId)"
$cancel = Invoke-RestMethod -Method Post -Uri "$api/sessions/$($session.sessionId)/cancel"
```

- 创建会话返回 `201` 和 `{"sessionId":"…"}`，创建时不调用模型。
- 提交首次受理和原编号重发均返回 `202 {"accepted":true}`，确认内存受理。相同编号沿用首次正文。修改正文或主动再发应生成新编号，忙碌时新编号返回 `409 {"code":"agent_busy"}`。
- 读取历史返回 `200`。空会话为 `{"sessionId":"…","inheritedEventCount":0,"cursor":-1,"records":[]}`，事件序号从 0 连续递增。
- `GET /api/sessions/:sessionId/follow` 使用 SSE。首帧是完整快照，后续交付原始事件及 Assistant 实时流。关闭连接或切换会话只停止观察，Turn 继续运行。同步故障会终止当前流并允许用户主动重试。
- 取消已加载会话返回 `202 {"accept":true}`，结果通过历史或 follow 确认。未加载会话返回 `404 {"code":"session/not-found"}`，取消请求不会加载 Agent。存储阻塞时新提交返回 `503`。
- 浏览器本地目录保存会话编号及选中项，刷新后重新通过 follow 安装快照。本地存储不可用时仅在当前页面保留目录。默认模型为模拟 Adapter；可按 DeepSeek 最小验证说明显式启用真实 Provider。会话压缩按 OpenSpec 后续任务交付。

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

## 模拟 MCP 工具

在一个 PowerShell 7 窗口启动模拟服务，默认仅监听 `127.0.0.1:3101`：

```powershell
pnpm --filter @mharness/mock-mcp dev
```

在另一个 PowerShell 7 窗口显式启用 MCP 后启动应用：

```powershell
$env:MHARNESS_MCP_ENDPOINT = 'http://127.0.0.1:3101/mcp'
pnpm dev
```

可在服务窗口通过 `$env:MHARNESS_MOCK_MCP_PORT` 修改端口，并相应调整后端地址；未设置 `MHARNESS_MCP_ENDPOINT` 时保持默认行为。可信配置将 `mock_read` 设为只读免审批，`mock_write` 设为副作用且需审批。模拟模型默认只回答文本，可在测试驱动中发出工具调用。

服务使用 MCP Streamable HTTP，输入保留顶层 `operationId`，只由 Harness 在操作记录建立后注入。模型输入和包含标识的完整输入分别按远端 JSON Schema 校验，服务入口也独立校验。仅支持可安全移除保留字段的顶层对象规则；复杂的跨字段约束会在连接时拒绝。MCP 默认采用远程取消策略，即使地址是 localhost 也不保证服务端停止。模拟写入将 operationId、工具名、规范化业务参数、效果和成功结果保存在独立 SQLite 台账中，重复请求返回已保存的结果，冲突请求不会产生效果。默认路径为仓库根目录下的 `data/mock-mcp.sqlite`，可使用 `MHARNESS_MOCK_MCP_DB_PATH` 指定其他路径（相对仓库根目录）；该路径应与会话数据库分开。台账不会自动过期，Harness 不会因此自动重试。此保证仅适用于同一数据库内的模拟效果，不适用于真实外部副作用。

运行模拟服务测试：

```powershell
pnpm --filter @mharness/mock-mcp test
```

响应丢失可通过测试或自定义模拟服务启动代码显式注入：

```ts
const server = await startMockMcp(0, databasePath, { dropResponseOnceForOperationId: "op-1" });
```

该选项只影响指定 `operationId` 的一次成功 `mock_write`（包括重用已保存的结果）：SQLite 事务提交后断开该请求的 HTTP 响应。读取、其他操作、参数无效和冲突不会消耗故障。默认关闭；状态仅存在于服务实例中，每次启动时再次传入选项都会重新启用，不传则关闭。上述测试使用临时数据库和真实 MCP SDK 验证响应丢失、提交后的结果及手动重发，不会触及默认数据库，也不会触发 Harness 自动重试。
