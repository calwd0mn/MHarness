# 会话目录恢复最后一批实施计划

> 使用 Superpowers 子 agent 开发流程逐步执行。独立计划评审通过后按本轮授权直接开发。

**目标**　在 README 记录目录接口与部署约定，以两个独立 SQLite 实例和真实双窗口验证会话恢复，再完成 Full 与双路复审。

**范围**　`restore-sessions-from-server` 的 3.3、4.1、4.2。起点为 `610469e4b63da5fba372855a86b7a95a5061f5cb`，沿用 `feat/restore-sessions-from-server`，保留已有工作区与暂存区变更。行为以该变更的 design、execution-streaming delta 和 tasks 为准。

**技术**　PowerShell 7、Node 24、Fastify、SQLite、Vite、Chromium。浏览器使用真实页面、浏览器存储和后端 HTTP/SSE，模型输出采用可控替身。

## 3.3 部署说明与数据库隔离

- [x] 先增加 `apps/server/src/session/directory-isolation.test.ts`。用 `mkdtemp` 建两个不同文件，分别启动 `createEventSessionApp(path)`。经真实路由 POST 写入各自一个会话，解析 `createSessionResponseSchema` 并验证两个 ID 不同。GET 校验 HTTP 200 并以 `sessionDirectorySnapshotSchema` 解析，断言两个目录各自只包含本库 ID。关闭应用后以原路径各自重开，重复 GET 断言并确认进度归零。通过 `finally` 或测试清理关闭实例后删除临时目录。
- [x] 先运行 `pnpm --filter @mharness/server exec node --import tsx --test src/session/directory-isolation.test.ts`。隔离是已有行为，若基线通过，记录为回归基线；在临时测试副本让 A 查询 B 的目录，确认断言会因 ID 错误失败，再恢复并重跑。缺失的 README 用文件内容验收产生真实红灯，例如 `Select-String -Quiet -SimpleMatch 'GET /api/session-directory/events' README.md` 期望为 `True`。若浏览器或隔离测试发现实际缺陷，先将其固化为稳定红灯，再做最小修复。每个失败记录具体断言和实际值。
- [x] 在 `README.md` 的会话接口附近补齐 `GET /api/sessions` 的完整快照语义和 `GET /api/session-directory/events` 的 ready、进程内实时通知和重连快照，保留单会话 follow 的分工。说明首版提供单后端实例内目录、全量快照、环境数据库通过 `MHARNESS_SESSION_DB_PATH` 隔离，同一文件不会构成环境隔离。写明后端目录接口先部署、Web 后部署，旧库无可用检查点时回退冷摘要且无需为目录扫历史，升级迁移旧提示并清理旧键，Web 回退从浏览器重新积累目录。重跑文档验收及定向服务端用例。

## 4.1 真实双窗口验收

- [x] Vite 代理到隔离的 `createEventSessionApp`，只使用临时 SQLite。用 `apps/web/scripts/session-directory-browser-acceptance.mjs` 打开同一 Chromium 上下文的两个独立顶层窗口 A、B，并用独立无痕上下文检查新启动。记录各场景的 DOM、共享键、HTTP/SSE 或历史断言。以可控网络时序和最迟失败超时代替固定睡眠。额外依赖安装在仓库外，关闭浏览器、Vite、后端和测试连接后清理本轮临时 SQLite 与 Vite 缓存。
- [x] 先准备非空 X、Z，A 选 X、B 选 Z。记录两页 `nav [aria-current="page"]` 与 `mharness.sessions.current`。在 B 选定时让 A 所看的 X 发生消息和状态变化，断言各页选择保持，键值仍指向 B，使用启动注入包装 `Storage.prototype.setItem` 并调用原实现以记录此期间无重复写入。B 创建空 Y 后保持选中 Y，A 的 `nav` 查不到 Y。保留提示时刷新 A，断言 Y 被选中且显示。接下来由 A 改选 X、刷新并断言只恢复 X，再由 A 关闭选择、刷新并断言没有选中项。两次刷新均验证 A 隐藏 Y、B 持续选中 Y。最后 A 重新选 X，B 在 Y 发送第一条消息，A 出现唯一的 Y 行并保留 X。
- [x] 注入下一次创建写事务的确定失败或未知后确认未提交，沿用服务端测试的 SQLite 写句柄故障注入。采集真实新增及 `creation-failed` 撤回帧和失败响应，断言发起页显示失败、临时 ID 从 GET 目录消失且无错误选择，观察页继续保留自己的选择。用独立浏览器上下文验证目录有非空项但无当前选择、空会话隐藏，正常上下文键不受影响。
- [x] Vite 代理按浏览器窗口测试标识和路由分别记录真实 SSE 响应，断开时销毁 A 对应的现有代理请求及下游响应，在代理前挂住该路径的下次连接，B 的流及 A 的其他流保持在线。A 断开后在 B 创建新会话并发送消息，验证 A 尚未显示它。放行挂住的 A 目录连接，记录 ready 后的新 GET 和重连前后 DOM，断言漏掉的会话经快照补齐、只有一行且旧选择保持。代理只控制连接，所有业务帧及 GET 响应来自实际后端。
- [x] 用可控 Mock Provider 让一轮先可见草稿再暂停。刷新选中会话的窗口，确认重新连 follow 时恢复同一轮草稿。按同一代理机制关闭并挂住 A 的指定 follow，释放模型并由保持连接的 B 及服务端历史确认已完成。放行 A 首次挂住的重连；若浏览器限时令重试耗尽，解除挂起后使用「重新同步」，记录实际恢复方式。在 DOM 断言正式回答只出现一次、草稿消失，该轮历史恰有一次正式 assistant 和一次 `completed` 终态。再刷新一次验证回答仍为单份。必要时按 `apps/web/src/mcp-turn-acceptance.test.jsx` 的适配器与运行门写定向自动化回归。

## 4.2 Full 和双路独立复审

- [x] 从主 agent 新鲜运行 `pnpm typecheck`、`pnpm --filter @mharness/server test`、`pnpm --filter @mharness/web test`、`pnpm --filter @mharness/mock-mcp test`、`pnpm --filter @mharness/web build`、`openspec validate restore-sessions-from-server --strict`。记录各项退出码与计数，人工核对有变动的公开 JS/TS 声明的中文 JSDoc 与实际契约。
- [x] 用临时 Git 索引从起点树加入本轮计划和明确的实现文件，写出固定候选树，执行 `git diff --check <基线树> <候选树>`。两路同看固定差异、OpenSpec 与验收证据。一路按 MHarness 项目技能，一路优先 Codex 原生 review（可配置 gpt-6.2-sol / high 时使用），否则使用同配置独立只读子 agent 并披露。若有阻断项，先补红灯再修复并重新固定候选，复跑相关定向用例、真实浏览器、Full 与两路复审。
- [x] 在真实双窗口、Full 和两路复审全部通过后，于 `openspec/changes/restore-sessions-from-server/tasks.md` 勾选 3.3、4.1、4.2。重新做差异空白检查和 OpenSpec 严格校验，确认与复审候选相比只有这三处勾选和实施计划的验收证据增量。保留归档给后续指令。

## 实施与验收记录

- 独立计划评审发现清空后无法从侧栏重新选择空会话、断线必须关闭已建立的流，以及勾选后的差异仍须核对。修订后获得 GO。
- 在改 README 之前，`Select-String -Quiet -SimpleMatch 'GET /api/session-directory/events' README.md` 返回 `False`，补充说明后返回 `True`。双库用例基线与改动后均为 1 项通过。临时反例让 A 查询 B，按预期在会话 ID 断言失败。已删除反例副本。用例通过 Fastify 注入执行真实路由并写入 SQLite，关闭重开后目录仍各自只包含本库 ID，进度均为 0。变更没有新增公共 JS/TS API，已人工核对中文 JSDoc 适用范围。
- Chromium 148.0.7778.96 实测通过。通过 CDP 确认 A、B 属于两个不同的顶层窗口，导航协商为 HTTP/2。A 和 B 分别选 X、Z，普通消息及运行、活动、空闲通知期间两个窗口各自的共享键写入计数无增量，共享提示仍指向 Z。B 创建并保持选择空会话 Y，A 收到 Y 新增后的 Z 活动重排并更新侧栏，仍保留 X 并隐藏 Y。A 在共享提示为 Y、X 和 `{}` 时分别刷新，恢复 Y、恢复 X 和无选中，后两种隐藏 Y。独立无痕上下文启动时共享键为 `null`，无选中项且未建立 follow，常规上下文仍保存 X。B 发送第一条消息后，A 收到 `seq: 0` 的首次 Turn 更新，以单行显示 Y，仍选 X。
- 在 SQLite 首次提交挂起时，两个窗口收到同 ID 的空会话新增，目录 GET 可读到该临时项。首轮浏览器已实测立即确认失败的 `500 session_creation_failed`。最终脚本将首次核实保持未知，真实 POST 返回 `503 session_creation_unknown`，发起窗先显示待确认，独立无痕窗口从隔离提示选中该临时项。随后放行真实 SQLite 核实，两个普通窗口均收到同 ID 的 `creation-failed`。发起窗从待确认切换为创建失败，隔离窗的临时行、选中及保存提示均撤回。这两个页面没有重新请求目录。普通窗口各自选择不变，后端目录 GET 中临时项消失。
- 仅断开 A 的目录 SSE 并挂起下一次请求。B 在此期间创建并完成新会话，A 断线期间没有收到该会话通知，释放重连后恰好读取一次新 GET，补齐单行并保留选择。随后两个窗口同看另一轮草稿，A 刷新后的 follow 快照含相同 `attemptId`。仅关闭 A 的 follow，待 B 和历史确认结算后放行 A 的首次重连。两个窗口各显示一个正式回答，A 再刷新也只有一份，历史含一个 `assistant/message` 和一个 `completed` 终态。
- 第一轮复审指出迁移条件及 HTTP/2 部署约束需要补充，浏览器命令依赖本机路径，关闭应用失败会跳过隔离测试的临时目录清理。先确认 README 缺少迁移条件与 HTTP/2 说明、仓库内缺少可运行脚本，再补齐文档和脚本。Web 选中项定向回归通过 16 项。
- 在双库用例的临时副本中注入应用关闭时抛错。修复前该测试退出 1 并留下临时目录；修复后两个应用的关闭尝试均已结算，临时目录删除，原始关闭错误保留。故障副本已清理。
- 第二轮原生复审指出验收脚本会撞 Vite 默认端口，且慢速 follow 注册会让草稿测试等待未交付的增量帧。预占 5173 时旧脚本因端口冲突退出 1，允许 Vite 选择下一空闲端口后，在同一占用条件下通过双窗口验收。两窗先收到各自初始 follow 快照才启动测试 Turn。断线时核对其他 SSE 使用原响应且没有替代请求，历史轮询的 HTTP 读共享本场景截止信号。
- 将 Playwright 操作与等待组成同一个 Promise，确保点击或导航超时仍走资源清理。创建失败场景需先验证双窗都看到临时项，再释放响应，因此在开始等待时就为响应注册拒绝处理器。
- 共享键写入计数在两个窗口都渲染晚于空闲帧的可见目录项后核对，避免将代理已收到帧当作浏览器已应用。代理解析 SSE 的失败经主流程报告窗口与路径，浏览器和 SQLite 清理完成后才报告验收通过。
- 轮询截止时间也中止等待仍在进行的浏览器读操作，避免渲染进程无响应时跳过测试超时和资源清理。
- 空会话 Y 恢复时，核对 A 的新 follow 快照为空且聊天区已连接。目录断线期间记录 A 原有侧栏顺序和选择，确认放行前仍保留。新增和撤回均核对两窗收到的同一会话 ID。共享键写入计数检查前，等待同源锁完成已经排队的写入。
- 真实 Chromium 核对 `running: true` 帧先于首次 Turn 更新，且 Y 更新后在 A 只出现一次。Web 双页面定向用例逐帧送达，单独断言只收到运行通知时 Y 仍隐藏。浏览器脚本执行统一使用有截止时间的读取，包括独立校验协议和存储时。
- 复跑浏览器前根据 README 安装工作区依赖。在仓库根目录用 PowerShell 7 执行下列命令，需要可启动图形窗口的环境。Playwright Core 固定为 1.60.0，依赖安装在仓库外，Chromium 使用 Playwright 管理的缓存。脚本只连接本机隔离后端并使用模拟模型。

```powershell
$mharnessBrowserTools = Join-Path $env:TEMP ('mharness-browser-tools-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $mharnessBrowserTools | Out-Null
'{"private":true}' | Set-Content -LiteralPath (Join-Path $mharnessBrowserTools 'package.json') -Encoding utf8NoBOM
pnpm --dir $mharnessBrowserTools add --save-exact playwright-core@1.60.0
if ($LASTEXITCODE) { throw 'Playwright Core 安装失败' }
$mharnessPlaywright = Join-Path $mharnessBrowserTools 'node_modules/playwright-core'
node (Join-Path $mharnessPlaywright 'cli.js') install chromium
if ($LASTEXITCODE) { throw 'Chromium 安装失败' }
pnpm --filter @mharness/server exec node --import tsx ../web/scripts/session-directory-browser-acceptance.mjs $mharnessPlaywright
```

- 最终候选 `bd800b0af0405ec73c78c6395fd204b25e25bd55` 的树为 `15c6ce7441506af54602bf3be44d5c79813841cf`，与验收结束时的工作文件一致。MHarness 项目复审和 Codex 原生复审独立核对相同候选，未发现阻断项。原生复审核对差异和脚本语法，Full 由主 agent 单独执行。
- 最终 Full 串行执行全部退出 0。Server 与 Session 721 项，Web Node 68 项、Vitest 186 项，Mock MCP 7 项。全工作区类型检查、Web 构建、OpenSpec 严格校验、浏览器脚本语法和固定差异空白检查均通过。此前并行执行时有一次既有 Web 计时用例失败，Web 独立复跑和最终串行 Full 均通过。
- 两路复审和 Full 通过后，勾选 OpenSpec 3.3、4.1、4.2。
