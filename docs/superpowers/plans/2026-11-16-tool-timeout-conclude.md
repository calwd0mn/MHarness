# 工具超时与批次结束实施计划

用户已通过 continue-dev 授权本轮 5.1、2.8、5.2、5.3 的代码修改，并要求开发完成后直接 continue-review。沿用已确认的 agent-harness-prototype 设计及完整 OpenSpec 规划产物，不走 apply，不重新发起设计审批。

基线：4856b44。集成分支：codex/tool-timeout-conclude；工作树：.worktrees/tool-timeout-conclude。主工作区既有 .scratch/、前端设计草稿及其他工作树不纳入本轮。每个任务使用独立工作树和提交，统筹记录 base/head 并串行集成。

## 建议值与边界

- 工具默认等待超时 30_000 ms，由 config/local.ts 集中提供，可信注册可以覆盖；不与模型 requestTimeoutMs 混用。只从实际派发开始计时，审批和持久化检查点不消耗该工具等待时间。
- 每 Turn 的只读超时次数上限建议为 3：第 1、2 次允许继续，第 3 次停止本批剩余派发及模型续答，以明确预算耗尽原因结算。次数跨 Step 累计，新 Turn 重置。
- 最大模型步数保持现有 8；不新增自动重试、查询、Turn 总墙钟期限或审批超时。
- 本地且 cooperative-exit：截止/取消传播信号后，等待正文及清理结束。清理没有额外强制截断期限；违约工具可能长期占用 Turn，这是退出保证的明确代价，不能提前宣称已停止。
- remote 或无退出保证：截止即停止等待，取消已派发调用立即停止等待（额外取消宽限为 0 ms）；仍观察正文 Promise 的迟到兑现/拒绝以防未处理异常，不改写已结算事实。远程即使声明 cooperative-exit，本轮仍按远程停止等待策略。
- 在截止前取得的规范化结果按结果处理；截止已取得结算资格后，本地清理只影响完成时机，不将迟到成功反转为正常完成。超时不代表副作用撤销。
- TOOL_TIMEOUT 对副作用/unknown 停止本轮；只读按上述预算继续。取消保存 ABORTED 或派发前 ABORTED_BEFORE_DISPATCH。中止优先于成功 concludeTurn。

## 分工与顺序

1. 新的 GPT-6.1 Terra / high 开发代理并行完成 5.1 和 2.8。5.1 拥有 dispatch、集中工具配置、注册默认值及必要执行封装；2.8 拥有 model-turn 的结束意向接线和测试。共享 batch 接口由统筹协调，避免并发覆盖。
2. 两项集成后，新的 Terra / high 代理实施 5.2：在 batch 与 model-turn 接入超时结果、跨 Step 只读预算和明确中止原因，并覆盖成功结束意向优先级。
3. 5.2 集成后，新的 Terra / high 代理实施 5.3 及联验：可控时钟和 Promise 覆盖截止前完成、截止后迟到 resolve/reject、本地清理、远程停止等待；真实临时 SQLite/HTTP/Agent 链路核对活动期间拒绝新编号、最终持久结果及同一 Agent 后续复用。必要的修复限于本批行为。
4. 统筹运行新鲜 typecheck、服务端全量、Web 测试与构建、diff 检查及 OpenSpec strict validate；核对任务验收与中文 JSDoc 后更新 tasks/README/本计划。
5. 直接执行已授权 continue-review，为四项任务分别新建独立只读审查代理，按每项 base/head 与最终集成调用链审查。将证实的问题交原开发代理修复并由独立审查者复核；修复后重跑相关检查。

所有开发先记录行为测试 red，再实现并记录 green；测试使用可控时钟/Promise、临时库，不使用真实 Provider 或用户数据库。TypeScript 禁止 any。使用 jsdoc-contracts 和项目注释规则，公共说明归属于约定声明；内部中文注释只解释必要原因。各开发代理不得更新共享计划或 OpenSpec 任务状态。

## 验收矩阵

| 任务 | 关键可证伪结果 |
| --- | --- |
| 5.1 | 超时传播、本地清理结束前仍 pending、远程停止等待、边界与保证分别判断、计时器和监听器收束；30 秒默认与覆盖有效。Turn 级验收等待 5.2/5.3。 |
| 2.8 | 成功 A concludeTurn + 明确失败 B 均按序执行并保存，无下一 Step/模型总结，completed；失败不能触发意向，拒绝/取消/派发异常优先，同一 Agent 可复用。 |
| 5.2 | 副作用/unknown 超时 TOOL_TIMEOUT、已派发取消 ABORTED，尾项配对未执行；幂等/查询不触发重试或核实；只读超时计数跨 Step，达到 3 停止，成功意向不能掩盖中止。 |
| 5.3 | 截止前已取得结果保留，超时后迟到结果/拒绝不追加、不改写、不续跑、无 unhandledRejection；临时库重开及 HTTP 历史与 live 结局一致。 |

本轮不交付 MCP 接入、真实 Provider、工具页面交互、迟到结果入账/核实/恢复执行，不勾选这些任务或全局 7.x 闭环。变更尚有待办，不归档、不合并 main。

## 执行记录

待开发及独立审查完成后追加各任务 diff、red/green 与最终验证证据。
