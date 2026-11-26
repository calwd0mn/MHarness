# MHarness

本地 Agent Harness 原型。开发环境需要 Node.js 24 和 pnpm 10。

```sh
pnpm install
pnpm dev
```

打开 `https://127.0.0.1:5173`，新建会话即可开始问答。Vite 会为本地开发生成自签名证书，浏览器首次访问可能提示证书未受信任。确认地址为本机开发入口后，可在浏览器中继续访问。HTTPS 通过 HTTP/2 多路复用目录 SSE、聊天订阅和普通 `/api` 请求，开发服务将这些请求转发到 Fastify。

页面支持会话切换、按会话取消、刷新恢复，以及发送结果未知时使用原编号重试。旧 HTTP 地址的选中提示保存在另一个浏览器来源，首次访问 HTTPS 地址需重新选择会话。已保存会话仍从同一开发后端读取。

后端启动时会读取仓库根目录的 `.env`，已设置的进程环境变量优先。未指定模型 Provider 时使用 Mock。要在页面使用 DeepSeek，参照 `.env.example` 填写根目录的 `.env`，设置 `MHARNESS_MODEL_PROVIDER=deepseek` 和 `DEEPSEEK_API_KEY`，然后启动或重启 `pnpm dev`。

在空闲会话中单独输入 `/compact` 可压缩旧上下文。命令使用维护接口，并在结果落盘后返回。摘要替换只影响后续模型上下文，原始聊天和工具记录仍可查看。可从同一会话取消压缩。关闭页面或断开订阅不会取消，重新连接后可从共享命令卡片查看结果。

`pnpm typecheck` 检查全部工作区包的 TypeScript 类型。

## 原型闭环验收

在仓库根目录用 PowerShell 7 执行。服务端和 Web 联验会创建临时 SQLite 数据库，模型默认使用模拟 Adapter。

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm --filter @mharness/server test
pnpm --filter @mharness/web test
pnpm --filter @mharness/web build
openspec validate agent-harness-prototype --strict
```

2026-11-23 以 `main` 的 `4ce28fe` 为基线完成回归验收。服务端与 Session 600 项、Web 176 项通过，类型检查、Web 构建和 OpenSpec 严格校验通过。Web 构建有两条来自 Zod 依赖的 Rollup 注解警告。

| OpenSpec 项 | 验收结果与复现位置 |
| --- | --- |
| 1.15 | SQLite 重开逐条还原混存的旧分片和统一内容块，正式消息与工具配对可重建模型历史。追加、替换、分支、写入权、检查点失败及关闭回归随服务端测试执行。见 `@apps/server/src/agent/model-replay.test.ts` 和 `@apps/server/src/session/session-writer.test.ts`。 |
| 8.4 | 三个压缩入口的持久化、取消和预算，以及分支、重启修复和前端恢复已有联合验收。见 `@docs/superpowers/plans/2026-11-23-task-8.4-fork-recovery-first-slice.md:50`。 |
| 7.1、7.2 | 真实页面与模拟 MCP 验收审批、超时、拒绝、取消、响应丢失、检查点失败和重启。核对页面、持久历史、模型请求和工具效果。见 `@apps/web/src/mcp-turn-acceptance.test.jsx` 和 `@apps/server/src/fault-crash-acceptance.test.ts`。 |
| 7.4–7.6 | 切回会话补齐草稿并只结算一次，丢失结束帧后可取消审批且下一轮保留工具配对，工具批次处理完毕后按结束意向结算。见 `@apps/web/src/app.test.jsx`、`@apps/web/src/approval-cancel-live.test.jsx` 和 `@apps/web/src/conclude-turn-live.test.jsx`。 |
| 7.7、7.9 | 真实 follow 验证续答帧顺序及结算引用。Web 测试覆盖乱序交接、跨 Step 调用号复用、切换会话与重连竞态。见 `@apps/web/src/mcp-turn-acceptance.test.jsx`、`@apps/web/src/app.test.jsx` 和 `@apps/web/src/session/follow-controller.test.js`。 |
| 7.8 | 同一会话验证按需加载、审批及取消收尾时的忙碌拒绝和跨轮复用。关闭期间拒绝新任务，等待活动退出后释放写入权，重新取得写入权后可读取两轮完整历史。启动修复没有加载 Agent。见 `@apps/server/src/session/routes-acceptance.test.ts` 和 `@apps/server/src/event-session-app.test.ts`。 |

2026-11-23 完成 7.3 的真实 DeepSeek 验证。用隔离 SQLite 库向官方接口提交一条短文本，后端返回 `202 {"accepted":true}`。关闭后端并重开数据库后，读到一条 `request/header`（`deepseek/deepseek-flash`）、Assistant 正式回答「你好」和 `turn/end` 的 `completed` 终态。此次真实验证覆盖该模型的一轮纯文本问答，工具、压缩和故障场景采用表中的自动化用例。复现步骤见下一节。受控传输用例见 `@apps/server/src/deepseek-assembly.test.ts:130`。

## DeepSeek 最小验证

DeepSeek 单次生成只发送一次请求，不自动重试。鉴权、限流、传输、协议、提前断流、请求或空闲超时和调用方取消分别归类；明确的输入上下文超限使用 `CONTEXT_WINDOW_EXCEEDED`，输出达到上限仍为 `max-tokens`。请求超时累计到首个有效 SSE 事件，之后使用空闲超时；下游暂停不消耗等待预算。取消、超时或提前停止消费会中止请求并释放本地资源，不保证远端或不合作的取消回调已完成。

可用 `MHARNESS_MODEL_NAME` 指定模型，用 `MHarness_BASE_URL` 指定 API 基础地址。未设置或留空时分别使用 `deepseek-v4-pro` 和 `https://api.deepseek.com`。基础地址支持 HTTP(S) 和路径前缀，例如 `https://gateway.example/v1` 会请求其 `/v1/chat/completions` 端点。基础地址不能包含用户信息、查询参数或片段。配置自定义地址时，`DEEPSEEK_API_KEY` 会发送给该地址。

可选环境变量 `MHARNESS_MODEL_CONTEXT_WINDOW` 与 `MHARNESS_MODEL_DEFAULT_OUTPUT_TOKENS` 分别声明本地上下文窗口及默认输出预留，单位均为 token，须使用十进制正安全整数表示（允许前后空白和前导零）。缺少窗口，或既没有生效的生成上限也没有声明默认输出预留时，无法进行自动压力判断。它们不改变发送参数；`MHARNESS_MODEL_MAX_TOKENS` 仍控制实际显式输出上限。

要用临时数据库和较低的输出上限手动验证 DeepSeek，可在 PowerShell 7 中设置进程环境变量并启动后端。

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
$body = @{ requestId = [guid]::NewGuid().ToString(); content = @(@{ type = 'text'; text = '请只回复两个字：你好' }) } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri "$api/sessions/$($session.sessionId)/messages" -ContentType 'application/json' -Body $body
Invoke-RestMethod -Uri "$api/sessions/$($session.sessionId)" | ConvertTo-Json -Depth 30
```

受理返回后可能需要稍后重新查询历史。预期看到 `request/header` 中的实际模型名、Assistant 正式回答及 `turn/end` 的 `completed`。`max-tokens` 表示输出上限截断。真实请求会使用相应 Provider 账户，自动测试使用受控传输。

可选配置 `MHARNESS_MODEL_REASONING_EFFORT` 为 `none`、`low`、`high` 或 `max`，以及 `MHARNESS_MODEL_TEMPERATURE`、`MHARNESS_MODEL_STOP`（JSON 字符串数组）。推理模式不接受显式温度。退出后端后，在原窗口清除临时配置，并将进程的 Provider 设为 `mock` 即可切回 Mock。

```powershell
Remove-Item Env:MHARNESS_MODEL_NAME, Env:MHarness_BASE_URL, Env:DEEPSEEK_API_KEY, Env:MHARNESS_MODEL_MAX_TOKENS, Env:MHARNESS_MODEL_CONTEXT_WINDOW, Env:MHARNESS_MODEL_DEFAULT_OUTPUT_TOKENS, Env:MHARNESS_SESSION_DB_PATH -ErrorAction SilentlyContinue
Remove-Item Env:MHARNESS_MODEL_REASONING_EFFORT, Env:MHARNESS_MODEL_TEMPERATURE, Env:MHARNESS_MODEL_STOP -ErrorAction SilentlyContinue
$env:MHARNESS_MODEL_PROVIDER = 'mock'
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

以下 PowerShell 示例直接请求本机 Fastify。

`GET /api/sessions` 返回当前后端的完整目录快照 `{ revision, sessions }`，包含已提交会话、兼容的在线状态和正在创建的会话。查询不加载 Agent、不读取事件正文，也不会推进目录版本或广播通知。旧会话没有可用目录检查点时，使用 `blank: false`、`updatedAt: createdAt` 的冷摘要，目录重建无需扫描历史正文。

`GET /api/session-directory/events` 提供独立的目录 SSE。服务端注册监听后先发送 `api-session/ready`，随后发送本进程内的实时目录通知；Web 每次收到 ready 后读取全量快照，重连也重新读取快照以补齐断线期间的变化。`revision` 只属于当前后端进程，重启后从零开始。单会话聊天历史与实时内容仍由对应的 follow 接口提供。

首版目录的实时通知限于单个后端实例，目录快照为全量返回。不同环境应通过 `MHARNESS_SESSION_DB_PATH` 使用各自的 SQLite 数据库；共用同一文件不会隔离环境。部署升级时先部署提供目录 GET 和 SSE 的后端，再部署 Web。

部署时，浏览器侧代理应通过 HTTPS 协商 HTTP/2，让同源的目录 SSE、会话 follow 和普通 API 请求可以共享连接。HTTP/1.1 下，三个各自打开会话的标签页就可能占满浏览器的六条同源连接。代理到本地 Fastify 可继续使用 HTTP/1.1，并应流式转发 SSE。

启动时，新选择键缺失才会读取旧选中提示。目录确认提示中的会话后，支持 Web Locks 的浏览器会在同源锁内复核提示并尝试保存到新键，写入成功后再尝试清理旧目录键。持久化未成功时，本页仍可使用已确认的选择。回退到旧版 Web 后，旧侧栏会从浏览器重新积累目录。

```powershell
$api = 'http://127.0.0.1:3000/api'
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
- 浏览器从后端目录恢复选中项，并通过 follow 加载该会话的聊天快照。本地存储不可用时，选中项只保留在当前页面。手动压缩可在空闲会话中通过 `/compact` 发起。

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
