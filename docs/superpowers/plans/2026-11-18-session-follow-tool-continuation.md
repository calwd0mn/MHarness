# Task 7.7：Session.follow 正常工具续答验收计划

用户已确认计划并授权开发及两路独立审查。核对基线为 `main` 的 `254846d`，验收范围使用当前工作区的 7.7 完整条款，其中包含双向到达和 `callId` 重用。OpenSpec 的 proposal、design、specs、tasks 均已就绪，前置 2.6、3.5、6.5 已完成。

2026-11-18 开发、完整验证和两路独立审查完成。交付位于 `codex/session-follow-tool-continuation` 分支的工作树中。

`@openspec/changes/agent-harness-prototype/tasks.md:148`

计划阶段已运行两套现有页面验收，合计 59 项通过，OpenSpec 严格校验通过。2026-11-18 用户进一步确认了结算时序，append 同步将正式事件加入 follow 队列，然后 end 携带其 seq 入队。原计划把真实服务端顺序写成 end 先到，是计划和测试的错误，已据此更正。端到端验收核对既定的事件先到顺序，受控页面验收覆盖两种到达顺序。

## 验收方案

扩展现有 Web/MCP 验收的成功路径，同时在 Web 受控帧测试中精确控制交接时点。真实网络用例证明服务端实际发帧顺序、模型续答和工具执行，受控帧用例证明两种到达顺序均在配对齐备后完成交接，正文只显示一次。页面验证使用 Vitest/jsdom，沿用现有 EventSource 适配器读取真实 SSE。

### 1. 真实 Session.follow：一个 Turn、两次 Attempt

复用真实 `App`、Fastify `/follow`、模拟模型、MCP SDK、`startMockMcp` 和临时 SQLite。增加一个正常续答场景：Attempt A 输出可独立识别的正文和完整 `mock_read` 调用，以 `tool-calls` 结束；工具成功返回可独立识别的结果；Attempt B 输出不同正文，以 `stop` 结束。使用现有无审批只读工具配置。

`@apps/web/src/mcp-turn-acceptance.test.jsx`

- [x] 提交前先消费 SSE 首个业务帧，确认是同一会话的空 `snapshot`，`records` 为空、`cursor === -1`，没有活动 Attempt；随后从页面发起一次提交。
- [x] 按原始 SSE 接收顺序核对 `turn/start` → `step/start(1)` → `start A` → A 的正文 `chunk` → `assistant/message A` → `end A` → `tool/call` 和 `tool/result` → `step/end(1)` → `step/start(2)` → `start B`。通过完整帧列表验证这些位置及各帧归属。
- [x] 核对 A 的 `end.attemptId` 与 A 的 `start` 相同，`outcome` 为 `{ kind: "committed", eventType: "assistant/message", seq: eventA.seq }`，其中 `eventA` 是实际收到的原始结算事件，Turn、Step 和正文、工具声明均相符。B 是同一 Turn 下第二个 Step 的独立 Attempt，唯一一次 `turn/end` 为 `completed`。
- [x] 用现有逐帧交付能力，在 A 的正文分片、仅收到 `assistant/message`、再收到引用它的 `end`、B 开始以及 Turn 结束后分别检查 A 正文恰好出现一次。交接前后严格比较同一个 `article.assistant` DOM 对象，确认「正在生成」仅在两帧齐备后移除。B 结束时再核对两段不同正文各出现一次。
- [x] 核对模型恰好请求两次，B 的输入包含 A 的已结算正文、配对调用和成功工具结果；MCP 仅调用一次，结果归属 Step 1，匹配 `tool/call` 的 `sourceEventSeqs` 和对应操作；只读效果计数为零。复用现有 HTTP 历史比对来确认实时原始事件与最终已提交日志相同。以有界条件等待推进用例，用现有 `finally` 清理连接、应用和数据库。

### 2. 受控页面帧：两个交接顺序

复用 `Source`、`snapshot` 和 `sendFrame`，从合法快照和可见的 A 草稿开始，分别发送 `end → assistant/message` 与 `assistant/message → end`。这里使用 `tool-calls` 正式消息，补足已有控制器对 `assistant/attempt` 两种顺序的覆盖。

`@apps/web/src/app.test.jsx`

- [x] 每次只发送一帧并等待 React 更新。第一帧到达后仍显示同一个草稿节点、原正文一份和「正在生成」；第二帧到达后只显示一份正式正文、移除草稿标记且保留同一节点。随后推进到下一 Step/Attempt，确认 A 不闪退、不重复出现，订阅没有因正常交接而重连。

### 3. 同一 Turn 的两个工具 Step 复用 `callId`

扩充 Web 中已有的按 Step 工具归属用例：用同一 Turn 下的两个不同 Step、相同 `callId`、不同原始参数、操作 ID、审批 ID 和结果内容。后端已有用例验证真实驱动跨 Step 复用及续答前落盘；本轮补齐前端对两套审批和结果的区分。

`@apps/server/src/tools/batch.test.ts:146`

- [x] 通过合法事件顺序观察第一步审批通过并成功结算，再观察第二步仍独立处于待审批：第一步的审批决定、结果和状态不得传给第二步。第二步结算后核对两个调用仍分别保留各自的参数、审批关联及决定、配对结果。通过操作 ID 连接 `approval/asked` 和工具操作，通过审批 ID 连接 `approval/decided`，并使用各自的 `tool/call.seq` 验证结果来源。两步均有独立证据，不能只比较调用数。

## 开发、验证与审查

1. 收到用户批准后，主 agent 建立 `.worktrees/session-follow-tool-continuation`（分支 `codex/session-follow-tool-continuation`），固定开发基线并交接本计划。当前主工作区的 `tasks.md` 有并行中的未提交修改：仅把 7.7 条款作为范围传给工作树，不携带其他修改，不覆盖主工作区。
2. 启用新上下文开发子 agent：`gpt-6.1-terra`、`high`。按 Superpowers `test-driven-development` 逐项先补验收。若新增测试在基线上复现行为缺陷，记录因目标断言失败的 RED，再做最小修复并重跑；若行为已满足，保留基线绿色，在隔离工作树临时注入相关错误（例如改变结算帧顺序／引用、提前替换草稿、按裸 `callId` 合并）证明目标断言会失败，撤回注入后重跑。负对照不进入交付。默认只改测试或必要夹具；若确实要改生产逻辑，先报告失败证据和最小修复范围，等用户授权。全部使用 `pwsh.exe`，按项目要求应用 `jsdoc-contracts`，TypeScript 不用 `any`。
3. 新鲜验证：先执行 `pnpm --filter @mharness/web exec vitest run app.test.jsx mcp-turn-acceptance.test.jsx`，再运行 Web 全套（`pnpm --filter @mharness/web test`）、服务端全套（`pnpm --filter @mharness/server test`）、`pnpm typecheck`、`openspec validate agent-harness-prototype --strict` 和 `git diff --check`。若有生产 Web 变更，再运行 `pnpm --filter @mharness/web build`。记录测试数量、RED 证据、GREEN 结果及基线到交付 diff。
4. 按用户本次指定的 `continue-review`，主 agent 在开发和验证完成后另启一个无开发上下文的只读审查子 agent。交接基线、工作树、已批准计划、OpenSpec、验证命令，独立应用 `mharness-code-review` 核对实际改动与用例，重点检查真实发帧顺序、原始 `seq` 和范围关联、DOM 身份、审批归属、断言敏感度与资源清理。根据用户追加要求，再由另一独立子 agent 运行 Codex 自带的 `codex review --uncommitted`，审查同一份交付差异。审查结论和必要复验通过后，在验收分支同步并勾选本计划依据的 7.7 条款。

## 验证和审查记录

开发由 GPT-6.1 Terra 高思考子 agent 完成，交付包含两个 Web 测试文件和本项任务文档。既有实现通过新增验收。临时负对照分别篡改 `end.outcome.seq`、在单帧到达时提前清除草稿，以及移除工具投影键中的 Step，目标断言均失败。负对照恢复后测试通过。最初错误期待服务端先发送 end 的失败已按用户说明纠正。

- 集中页面与 MCP 验收 62 项通过。
- Web 全套 Node 41 项、Vitest 67 项通过，主 agent 已另行完整复跑通过。
- 服务端及 Session 全套 233 项通过。
- `pnpm typecheck`、`openspec validate agent-harness-prototype --strict` 和 `git diff --check` 通过，主 agent 已复验。
- 项目独立审查未发现可操作问题，独立运行页面测试 48 项及真实续答 1 项通过。审查时完整 MCP 文件的输出缺少汇总，审查者据实保留该项验证限制。
- 第二位独立子 agent 实际运行 `codex review --uncommitted`，退出码 0，审查结论为未发现需要修复的缺陷。该审查运行集中验收 62 项、类型检查和差异检查通过。

页面验证使用 jsdom 和真实 SSE/MCP 网络。变更涉及测试内部声明，已人工核对中文 JSDoc 适用范围和行为一致性。仓库没有单独的 JSDoc 静态检查脚本。测试运行有 SQLite 实验性警告以及服务端故障用例的预期错误日志。
