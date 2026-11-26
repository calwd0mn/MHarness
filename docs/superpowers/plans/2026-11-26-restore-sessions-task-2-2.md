# 会话目录任务 2.2 实施计划

> **For agentic workers:** Use superpowers:subagent-driven-development and superpowers:test-driven-development. 每组测试先记录预期失败，再做最小实现并复跑。

**目标**：Web 在启动或重连时，用本代次的完整目录快照和连续 SSE 变更恢复会话目录，合并成功后一起更新侧栏和选中项。

**架构**：目录控制器独立于聊天 follow，拥有目录连接、GET 取消和重连。React 用一次状态更新安装合并结果并对账本页选择和已确认的创建。

**技术栈**：TypeScript、React、EventSource、Zod、Node test runner、Vitest、pnpm。

## 基线与边界

- 复用分支 `feat/restore-sessions-from-server`，起点 HEAD `58911490fb29b7cf32a90b8177b10f02e1cf278b`，另通过临时索引冻结已包含前序改动的工作区树 `3f0fee05f740281c0356bce4a5cdb6ed032060db`。评审以该树比较候选，保留既有暂存、服务端和 Web 待核实创建逻辑。当前分支已经具备服务端 SSE，直接沿用。
- 行为依据 `openspec/changes/restore-sessions-from-server/{tasks.md,design.md,specs/execution-streaming/spec.md}`、主规格及 `GLOSSARY.md`。在 2.2 投影实时摘要、过滤未选中的空会话并核对选择。共享键、键迁移及旧核实入口的移除留给 3.1 和 3.2。继续用现有目录存储读选中提示。
- 使用 PowerShell 7、严格 TypeScript 和中文 JSDoc。计划独立评审通过后开发。
- 独立计划评审通过。根据评审补齐了选择提示的跨窗口保护、GET 失败释放连接、读取期间改选的两种对账结果，以及 SSE/POST 逆序的创建与撤回测试。

## A. 目录连接、快照与连续重放

**新增** `apps/web/src/session/directory-controller.ts` 和 `apps/web/src/session/directory-controller.test.js`。

- [x] 先写可控传输与延迟 GET 测试。断言连接建立后不立即 GET，首个 ready 启动唯一 GET。安装快照前目录不变。缓存 status#12 后用 revision 12 且 running=false 的快照覆盖，再推送迟到的 #12，仍保持 false。缓存快照后的 added#13、同 ID added#14、removed#15，断言仅发布一次最终 revision 15，新增不重复、撤回不复活。另覆盖首 Turn 设为非空、活动时间仅增、运行状态、排序、无版本错误帧。运行 `pnpm --filter @mharness/web exec node --test src/session/directory-controller.test.js`，预期缺控制器或行为断言失败。
- [x] 用代次对象标识活连接，每个代次保存缓冲和 AbortController。用现有共享 frame/snapshot Zod schema 校验两个入口。收到 ready 后才请求快照。用当前快照构造以 ID 为键的候选目录，逐帧跳过 revision <= 当前候选版本，连续版本才应用。新增按 ID 更新，撤回删除，updated/status/activity 更新已有条目，进度仍反映连续交付。完整候选一次性发布。实时帧遵循相同合并规则，sort 与服务端一致。
- [x] 无版本的 error 只给有效代次已存在的会话对象记录 `lastAgentError`，未知 ID 忽略。错误无需参与目录重放，不建立行、不推进版本、不改变排序或选择。用后续连续 status 帧核对版本和错误字段。
- [x] 先补缺号与代次测试。分别在重放中和已安装后触发缺号，拒绝带缺口的结果并重新订阅。旧版 20 断开，新连接缓存 added#1，再安装 revision 0，最终发布 revision 1。另一组在旧 GET 未完成时换代，旧请求晚成或晚失败、旧通知和旧 onerror 均无效。GET 非成功或解析失败保留旧目录并暴露手动重试，重试新建订阅。销毁后验证连接关闭、GET 中止、重连计时取消和迟到回调无效。用假时钟或可控调度逐步推进，避免固定 sleep。
- [x] 实现换代时先失效、再关闭连接与中止 GET。断连、无效 SSE 帧或缺号自动重新订阅，避免以无延迟循环重连。GET 失败时关闭该连接、丢弃其缓冲并保留上一份发布结果，等待手动重试。断言失败连接的晚到帧与 onerror 无作用。手动重试取消已安排的重连。运行 A 的定向测试直到通过。

## B. 页面投影和选择对账

**修改** `apps/web/src/session/use-conversation.ts`、`apps/web/src/features/conversation/ConversationView.tsx`。需要提取目录副作用时使用 `apps/web/src/session/use-session-directory.ts`。**测试** 新增 `apps/web/src/directory-sync.test.jsx`，调整 `apps/web/src/app.test.jsx` 及受新订阅影响的现有网络或演示夹具。

- [x] 用真实 App、独立 URL 的 EventSource 替身和可控 GET 写红灯测试。验证 ready 后请求 `GET /api/sessions`，启动选中提示仅在合并后的目录验证成功时打开 follow。重连保留原目录和聊天，在同 revision 快照把未选中会话改为 blank 后隐藏它，选中的空会话仍显示。用一个截点后的新增/撤回验证从未渲染快照中已撤回的行，并在有效撤回选中项后清空。断言目录错误时保留提示及旧列表，专用重试成功后才对账。验证切换选择不重启目录流，页面卸载关闭目录连接。
- [x] 同一套页面测试验证 GET 期间本页选项仍有效时保留。如果 GET 截点早于本页确认创建，延迟快照缺失该 ID 时继续保护本页已确认的会话与选择。之后由包含该 ID 的快照/通知或一次在确认后开始的 GET 对账，撤回有效时移除。用户主动切换后迟到的创建响应不得反选。命令 `pnpm --filter @mharness/web exec vitest run src/directory-sync.test.jsx`，期望旧版缺目录订阅、未核对选择或不能重试。
- [x] 初次启动旧键只提供 selected 提示，侧栏使用本页安装的目录。重连等待期间从已展示的 A 改选 B 时，合并后 B 仍存在就保持 B。若权威合并结果缺少 B 且没有本页创建保护，清空选择并关闭 B 的 follow。两个场景都验证不会恢复到 A。
- [x] 将控制器绑定到页面生命周期，使用 `localConfig.apiPrefix`、`EventSource` 和传递 signal 的 no-store GET。以一次 React 状态更新发布已合并的全量摘要和对账后的选择。从该副本按更新时间降序、ID 升序投影到现有导航，仅显示非空、当前选择或仍受本页创建保护的条目。若安装前已有展示继续保留。显式目录读取重试独立于会话 follow 和现存创建核实按钮。首次恢复失败期间保持原存储中的提示，成功后才确认或清除。以快照请求开始时捕获的本页创建序号判断快照能否对账。严格模式清理必须释放该次订阅。
- [x] 移除旧键在普通目录变化时的回写。显式选择或确认新建才写入本页选择。权威目录确认选择失效时，仅当旧键仍保存该失效 ID 才清除。启动恢复同一值或普通帧均不回写。用两组页面测试模拟另一窗口分别在实时更新前和初始 GET 返回前写入选择，断言其提示保留。
- [x] 页内确认创建前检查当前全量副本，SSE added 或已安装快照若已含同 ID，沿用服务端摘要，不另留本页保护。测试先收到 added 再收到 POST 201，只有一行，切走后空条目按规则隐藏。保留旧 503 核实入口。重放只应用截点后的撤回。若覆盖范围内的撤回在快照前后到达，最终目录仍缺失该 ID 时，只用撤回证据对账待核实入口。没有收到新增或撤回时，用成功快照对账在该次 GET 开始前已经收到 503 的会话。测试两种交付次序和 GET 开始后收到 503 的保护。
- [x] 调整现有替身使目录 SSE 与聊天 SSE 独立。正式服务器夹具保留真实 GET/SSE；仅对依靠旧本地虚构目录的测试补齐服务端夹具，原审批、压缩、切换、发送与创建核实断言保留。演示若使用固定 EventSource/fetch，按 URL 返回合法目录 ready 和快照。运行 `pnpm --filter @mharness/web exec vitest run src/directory-sync.test.jsx src/app.test.jsx`，预期通过。

## C. 默认开发入口使用 HTTP/2

用户同意把原生评审发现的 HTTP/1.1 连接池饥饿纳入 2.2。使用已安装的 Vite 7 自带的 TLS/HTTP2 服务及原有 `/api` 流式代理。开发证书使用官方 `@vitejs/plugin-basic-ssl`，由插件生成并缓存。开发地址改为 `https://127.0.0.1:5173`，README 记录证书提示及 HTTP 与 HTTPS 的选择存储差异。

**修改** `apps/web/vite.config.ts`、`apps/web/package.json`、`pnpm-lock.yaml` 和 `README.md`。**新增测试** `apps/web/src/dev-http2.test.jsx`。

- [x] 先用实际 Vite 开发服务和受控本地 HTTP 上游写验收。客户端先以 TLS ALPN 验证协商 `h2`，再同时打开三条目录 SSE 和三条 follow SSE，收到所有首帧后通过同一连接发起 POST。验证上游收到请求主体并返回 202，且原有流继续送帧。现有配置预期在 TLS 连接时失败。用门闩及明确失败超时清理服务器与客户端资源。
- [x] 在 Vite serve 配置接入官方开发证书插件，沿用同源代理。Vite 的 HTTP/2 前端连接与 Fastify 的 HTTP/1.1 上游独立，保持原接口和状态。更新 README 并执行定向测试，确认 TLS、代理及长流通过。
- [x] 使用 Chromium 同一浏览器上下文打开三个标签页接入实际开发入口和临时 mock 后端，核对六条 SSE 均协商 h2，发消息 POST 成功并收到回复，页面和证书设置限定在测试临时环境。

## D. Full 全量验证、双路独立复审及勾选

- [x] 主 agent 在最终改动上重新执行 `pnpm typecheck`、`pnpm --filter @mharness/server test`（含 Session 包测试）、`pnpm --filter @mharness/web test`、`pnpm --filter @mharness/mock-mcp test`、`pnpm --filter @mharness/web build` 和 `openspec validate restore-sessions-from-server --strict`。在冻结的差异上运行 `git diff --check <基线树> <候选树>`。核对中文 JSDoc 覆盖和准确性。记录红绿证据、全量测试和构建的实际结果。
- [x] 用临时 Git 索引从基线树读取并仅加入 2.2 改动，固定候选树。两位独立评审检查同一份基线到候选树的差异。一位按 MHarness 项目规则，另一位使用可指定模型和推理强度的 Codex 原生入口，入口不可用时用同配置独立只读子 agent。关注版本重置、缓存顺序、竞态、资源释放、现有调用兼容性及任务范围。发现缺陷后先补红灯并修正，再重跑 Full 和两路复审。两路和 Full 均通过后只勾选 2.2。

## 实施与验证记录

- 初始控制器测试因模块未实现而失败，首次页面测试因直接打开聊天 follow 而失败。修复后通过。后续定向红绿覆盖 ID 排序、原型属性 ID、未知会话错误和过期快照令牌。
- 首轮 Full 通过的候选 `88165cfdbae785610c5e800edd338eb5db7728f4` 被两路复审退回。补红绿回归并修复重连期间重复启动泄漏连接、创建确认后排序、被截点吸收或断线遗漏的撤回，以及过时导航点击重新打开会话。补充重连期间选择缺失、旧共享提示失效、多窗口提示保护、GET 失败和销毁清理的断言。
- 用户确认 HTTP/2 纳入 2.2，补充计划通过独立评审。实际 Vite 入口原先在 TLS 握手失败。接入本地证书插件后，自动化验证六条 SSE 首帧、POST 202 和六条后续帧，另验证 Vite 预览入口的证书配置保持原行为。实际 Chromium 三个同源标签页的六条 SSE 均协商 `h2`，同页发消息返回 202，三页均收到目录更新和助手回复，现有六条订阅持续连接。
- 候选 `7fd10b463bfe0faee71040c69d273f9fe2c833a3` 项目复审通过，原生复审另复现晚于快照交付的撤回、断线同时漏掉新增和撤回两种待核实入口残留。新增页面测试先得到三处预期失败，再修复并通过 20 项页面测试。控制器测试确认晚到撤回只对账缺失项，已安装目录、版本和后继连续帧保持一致。
- 最终固定候选 `4e57c338dae1eec88bbc3b4833c7e87d4581be0f` 的 Full 全量通过。服务端及 Session 720 项，Web Node 55 项和 Vitest 156 项，Mock MCP 7 项。类型检查、Web 构建、OpenSpec 严格校验及固定差异空白检查通过。此前修复了本机 pnpm 的断链，服务端既有测试一次随机端口被 Undici 拒绝，最终全量复跑通过。
- 最终候选再次通过实际 Chromium 三标签页验收，六条原有 SSE 持续使用 h2，发送消息返回 202，三页均收到目录和助手更新。
- MHarness 项目复审与 Codex 原生复审均对同一固定差异给出 GO。项目复审独立跑过 11 项控制器和 22 项页面及 HTTP/2 验证。原生复审独立跑过 11 项控制器、内存时序复现和 Web 类型检查。中文 JSDoc 采用人工契约核对。通过后仅勾选 OpenSpec 2.2。
