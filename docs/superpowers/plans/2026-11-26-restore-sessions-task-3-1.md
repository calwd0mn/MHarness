# 会话选择任务 3.1 实施计划

> **For agentic workers:** Use superpowers:subagent-driven-development and superpowers:test-driven-development. 每组先记录失败原因，最小实现后再复跑。

**目标**是在目录确认后保存本窗口的顶层会话选择，让同源窗口各自保持当前选择并在刷新时读取共享提示。

**架构**沿用 2.2 的目录和 follow。选择存储负责解析、兼容及写入，页面只在确认恢复、明确选择、创建成功或选择失效的边界处理提示。

**技术栈** TypeScript、React、localStorage、Node test runner、Vitest 和 pnpm。

## 基线与范围

- 以 `restore-sessions-from-server` 的增量规格、设计、任务 3.1 和现行主规格为准。复用 `feat/restore-sessions-from-server`，HEAD 为 `58911490fb29b7cf32a90b8177b10f02e1cf278b`。工作区包含未提交的前序实现和 2.2 勾选，临时索引树 `ba3b7c4011545b4d10c59bc6c0252e4e59b29edf` 冻结前序输入。真实索引和现有暂存内容独立保留。
- 本次覆盖选择契约、旧键迁移、显式清空、跨窗口保护和 follow 失败重试。沿用 2.2 的目录排序、隐藏和创建保护，旧创建核实入口归属 3.2。使用 PowerShell 7、严格 TypeScript 和 `jsdoc-contracts` 中文契约说明。

## A. 选择存储

**修改** `apps/web/src/session/directory.ts`、`apps/web/src/session/directory.test.js`。用选择存储 API 替换仅由页面使用的旧目录 API。

- [x] 先写测试断言读新键有效顶层 ID 和有效预留地址，读取 `{}` 或无效/损坏新键时不回退旧键。测试新键缺失时只读取合法旧 `selected`，旧列表无需进入页面。覆盖访问与写入异常、产生的 JSON 只包含 `sessionId` 或空对象。跑 `pnpm --filter @mharness/web exec node --test src/session/directory.test.js`，记录旧实现不具备选择契约的红灯。
- [x] 定义 `SessionSelection` 和 `SubagentAddress`，保留 `one-shot` / `continuable`、父与子 ID，使用共享会话 ID 校验约束。解析时以顶层 `sessionId` 为准，只在地址字段完整且父 ID 匹配时保留地址；无效地址不阻断有效顶层选择。存储读取区分新键、回退旧键、无提示。启动解析保持只读，给异步目录确认保留初始提示的来源与值。
- [x] 以来源及 `sessionId`、地址字段值比较启动提示当前是否仍匹配。仅在目录成功确认后，用仍匹配的有效旧提示迁移到新键，或者把仍匹配的失效提示清为 `{}`。新键出现后优先使用新键。新键写入成功后尽力清理旧键，写入失败继续可用本页内存选择并保留旧键供刷新重试。测试同 ID 不同地址的另一窗口写入、带预留地址的现有新提示恢复零次写入、旧键清理失败、新键写入失败和旧提示确认前另一窗口写入的保护。复跑 A 定向测试至通过。

## B. 接入页面与恢复行为

**修改** `apps/web/src/session/use-conversation.ts`、`apps/web/src/features/conversation/ConversationView.tsx`。**测试**在 `apps/web/src/app.test.jsx` 或独立 `apps/web/src/session-selection.test.jsx` 添加用例，更新 `apps/web/src/directory-sync.test.jsx` 中现有跨窗口断言。演示及一般测试夹具使用新键，专门迁移用例保留旧键。

- [x] 先用延迟目录 GET、独立目录/follow SSE 替身和可观测存储写入写 App 测试。没有有效提示时只显示服务端非空会话且不打开 follow。有效新提示仅在目录确认后打开顶层 follow，恢复时不回写。等待目录时保留提示，GET 失败重试后才能迁移或清理。旧 ID 无效且另一窗口已写新提示时，本页置空，保留另一窗口的值。两个已挂载的窗口用同一存储，分别选 A/B，普通目录更新与聊天消息不回写，刷新后恢复最新提示。用真实 follow 终止错误帧验证选择与共享键仍在，点击现有「重新同步」只重新订阅该会话。运行 `pnpm --filter @mharness/web exec vitest run src/app.test.jsx src/directory-sync.test.jsx` 及独立新增文件，记录旧页面的红灯。
- [x] 显式选中目录中存在的行或 POST 成功自动选中时，若当前顶层选择发生变化，在打开 follow 前写入 `{ sessionId }`。重复点击当前行仍作为明确选择意图，阻止此前的迟到 POST 抢回选择，同时保持共享键不被重复写入。复用目录的同步 ref 防止已撤回的旧按钮写回失效 ID。目录更新确认已打开会话失效时清空内存和共享键。仅启动恢复提示失效时使用读取来源及字段值核对共享键；成功恢复新键中的同一提示保持零次写入。保留 2.2 的创建保护、GET/SSE 时序、订阅失败重试。
- [x] 在会话头部增加选中时可用的「关闭会话」入口，调用 `setSelected(null)` 清空提示，释放当前 follow，保持页面目录连接。测试清空后刷新无 follow、旧键不复活、存储不可用仍可切换和关闭。验证普通刷新、状态和消息不写键。接入代码使用中文 JSDoc，定向页面及存储测试通过。

- [x] 在 follow EventSource 构造时直接读取新键，分别验证手选行和 POST 201 自动选中都已写入相应提示。用门闩覆盖初始目录 GET 仍在等、旧提示 A、POST 201 先选 B、随后只含 A 的旧快照，核对 B 继续保留且不会迁移 A。开始 POST 后显式清空并延迟交付 201，断言仍为空且共享键仍为 `{}`。
- [x] 比较启动与当前选择失效的跨窗口行为。启动提示尚未经确认时，另一窗口先保存新值，失效的旧提示不覆盖它。当前窗口已确认选中 B 并收到 B 的有效撤回时，写清空值 `{}` 且关闭 B 的 follow。保留另一页内存当前选择。
- [x] 原生复审发现跨窗口可在读取与写入之间交错。先用受控锁和存储复现，收到锁后才重新读取待迁移或失效的提示。共享键的正常写入、迁移与清空共用同源独占 Web Lock。无锁环境仅在本页恢复启动提示，跳过可能覆盖其他窗口的自动迁移或失效写回。明确选择或清空仍尽力写入，获取锁失败时允许本页继续使用内存选择。用可控异步锁检查写入完成后才打开 follow，改选、清空及卸载会让旧完成回调失效。补验默认 HTTPS 开发地址下的浏览器双窗口锁争用。
## C. Full 全量验证与两路独立复审

- [x] 主 agent 独立运行 `pnpm typecheck`、`pnpm --filter @mharness/server test`（含 Session）、`pnpm --filter @mharness/web test`、`pnpm --filter @mharness/mock-mcp test`、`pnpm --filter @mharness/web build`、`openspec validate restore-sessions-from-server --strict` 和固定差异的 `git diff --check`。记录定向红绿、全量及中文 JSDoc 的实际核对结果。
- [x] 用临时索引固定候选。从同一前序基线发起 MHarness 项目复审及 Codex 原生复审，均为独立只读且使用 gpt-6.2-sol / high。原生入口无法完成时按工作流以同配置独立子 agent 复审并披露。发现缺陷先补红灯再修复，对最终候选复跑 Full 和两路复审。通过后仅勾选 3.1。

## 实施与验证记录

- 修订计划通过独立评审。补齐了手选和创建先写提示再开 follow、初始读取与创建交错、主动清空后迟到 201 以及不同失效场景的验收。
- 存储定向测试先因选择 API 缺失而失败。页面定向测试先因旧实现未读取新键、确认目录后未打开预期 follow 而失败。语义相同而属性顺序不同的提示比对也先复现失败，改为逐字段比较后通过。选择存储测试 7 项，页面选择测试 10 项通过。
- 固定候选 `cf361170b1bf5716c431baddfd46f9f54da0555b` 通过 Full。服务端与 Session 720 项，Web Node 60 项与 Vitest 166 项，Mock MCP 7 项。类型检查、Web 构建、OpenSpec 严格校验及固定差异空白检查通过。中文 JSDoc 采用人工契约核对。
- 首轮原生复审复现跨窗口先读后写可覆盖较新的提示。先补红灯，再将正常写入、迁移和失效清理移入同源独占 Web Lock，且在锁内重读。默认 HTTPS 下实际 Chromium 双窗口争用通过。存储不可用时跳过锁请求，保留内存选择。
- 项目复审在 `f30a32214b93d01478357c3e3127f28a7a817dd2` 复现批内由 A 改选 B 再回到 A 时可能提前打开 follow。新增测试先失败，再将最新写入 Promise 与目录选中状态一起提交。follow 只接受当前选择及当前写入的完成，重复点击同一行继续保留原有明确选择意图。
- 原生复审确认同源锁关闭了首轮覆盖。针对清空排队，在本页已关闭、共享写入仍未完成时显示「正在清除恢复提示」。针对演示入口，先验证直接加载会覆盖真实新键，再隔离为本页内存存储并复验演示仍可打开及关闭。
- 项目复审对 `e43c3f243d92bc8b45f6827fd1adbaf92b570093` 复现了清空恢复提示完成时误清创建失败反馈。先补定向红灯，再让操作提示只在实际选中值变化时清理。清空状态结束且创建失败提示仍可见的测试已转绿。
- 原生复审在 `f7bc72e255a01da0e8f88bb62bdfe1ba7922c187` 复现无 Web Locks 时启动写回仍可覆盖其他窗口。受控存储与页面先红再绿。无锁启动保持只读，用户主动改选或清空仍可写入；锁拒绝或同步抛错时保留内存选择。
- 最终固定候选 `5646c7caa346ad6fc61a1cca834049f5df1ecac5` 的 Full 通过。服务端与 Session 720 项、Web Node 68 项与 Vitest 172 项、Mock MCP 7 项。全项目类型检查、Web 构建、OpenSpec 严格校验及固定差异空白检查通过。并行运行 Vite 和浏览器期间曾有一次既有预览配置测试超时，Web 独立全量重跑通过。
- 实际 Chromium 双窗口验收通过。共享锁保留较新的写入，两页各持有其本地选择。清空过程可见，解除锁后刷新保持未选中，演示页存储隔离。模拟无锁环境时，启动恢复旧选择保持只读，主动改选成功写入并清除旧键。
- 同一最终差异的 MHarness 项目复审与 Codex 原生复审都给出 GO。项目复审独立通过 15 项存储和 36 项页面测试。原生复审独立通过 15 项存储测试并对比受控交错在修复前后结果。通过后仅勾选 OpenSpec 3.1。
