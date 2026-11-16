# 工具超时与批次结束实施计划

用户已通过 continue-dev 授权本轮 5.1、2.8、5.2、5.3 的代码修改，并要求开发完成后直接 continue-review。沿用已确认的 agent-harness-prototype 设计及完整 OpenSpec 规划产物，不走 apply，不重新发起设计审批。

基线：4856b44。集成分支：codex/tool-timeout-conclude；工作树：.worktrees/tool-timeout-conclude。主工作区既有 .scratch/、前端设计草稿及其他工作树不纳入本轮。每个任务使用独立工作树和提交，统筹记录 base/head 并串行集成。

## 建议值与边界

- 工具默认等待超时 30_000 ms，由 config/local.ts 集中提供，可信注册可以覆盖；不与模型 requestTimeoutMs 混用。只从实际派发开始计时，审批和持久化检查点不消耗该工具等待时间。注册及派发均限制值大于 0 且不超过 Node 定时器上限 2_147_483_647 ms。
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

统筹在集成工作树确认基线：`pnpm typecheck`、服务端 185/185、Web 40 项 Node 与 11 项 React 测试、Web build、OpenSpec strict validate 全部通过。构建保留两条已有 Zod 上游 Rollup 注释警告。

5.1 与 2.8 以 d3e1fbf 为共同开发基线并行。5.1 的执行接口约定为 `gate.dispatch(body, prepared.call.governance)`；新增 `timeout / TOOL_TIMEOUT` 结果，旧字符串参数保持兼容。集中配置字段为 `localConfig.tools.timeoutMs` 与 `localConfig.tools.maxReadOnlyTimeouts`，5.2 消费并接入 Turn 策略。

| 任务 | 开发 diff / 集成提交 | 已有验证证据 |
| --- | --- | --- |
| 2.8 | d3e1fbf..388e0c1 / 3155f41 | 新增 Agent/SQLite 测试先因模型请求 2 次而期望 1 次失败；实现后 model-turn-conclude、model-turn、batch 共 44 项通过，server typecheck 通过。 |
| 5.1 | d3e1fbf..c480d38 / 07e8315 | `node --import tsx --test src/tools/dispatch.test.ts src/tools/registry.test.ts` 定向 18/18；server typecheck 与服务端 192/192 通过。迟到值不触发 render 的单例先以 1 !== 0 失败，再通过。完整 Turn 接线留给 5.2/5.3。 |
| 5.2 | 07e8315..03091dd / 3ef67b0 | `node --import tsx --test src/agent/model-turn-timeout.test.ts` 先 3/3 失败：副作用尾项仍派发、只读预算仍请求第 4 步。修复后加 batch、model-turn-conclude 共 23/23 通过，server typecheck 通过。 |
| 5.3 | 3ef67b0..d436904 / 0ebf595 | 新增 5 个真实 HTTP/临时 SQLite 场景，合并 timeout、batch、dispatch 共 37/37 通过，server typecheck 通过。临时移除超时优先结算后，timeout-cleanup 用例因 TOOL_TIMEOUT 变为成功而失败；还原后通过，最终 diff 仅新增测试。 |

上述定向 Node 命令在 apps/server 执行。5.1 新增 timeout 分支、旧签名兼容、集中默认值以及停止观察后不派生迟到值的约定；2.8 覆盖成功意向、明确错误、拒绝/取消/异常优先及同一 Agent 复用。开发代理已人工核对中文 JSDoc，项目没有专用 JSDoc 静态检查脚本。

5.3 覆盖本地清理期间无 turn/end、新编号 HTTP 409、截止前结果、迟到 resolve/reject 后事件不变、模型不续跑、同一在线会话后续 Turn、flush 后 HTTP 历史及关闭重开一致。已派发结果引用 tool/call，未派发尾项引用 Assistant 声明。停止等待使用无退出保证的本地替身，不声称已验收真实 MCP；live 观察使用 Session 事件，未新增真实 SSE 路由场景，既有 follow 测试继续回归。

## 集成验证与 continue-review

统筹在最终集成代码 0ebf595 亲自执行：`pnpm typecheck`、`pnpm --filter @mharness/server test`（204/204）、`pnpm --filter @mharness/web test`（40 项 Node + 11 项 React）、`pnpm --filter @mharness/web build`、`git diff 4856b44 HEAD --check`、工作区 diff 检查、`openspec validate agent-harness-prototype --strict` 全通过。构建仍有两条已有 Zod 上游 Rollup 注释警告。

按用户预授权直接进入 continue-review，5.1、2.8、5.2、5.3 分别新建了独立只读代理。审查按上述任务 diff 及最终集成调用链核对，不把 4.x MCP 或全局 7.x 待办当成本轮已交付。

- 2.8：未发现可证实的本批缺陷；独立运行 model-turn-conclude、model-turn、batch 共 44/44 通过。
- 5.1：确认 P2，正有限的超时值 2_147_483_648 超过 Node 定时器上限，实际被缩为 1ms。统筹真实 dispatch 复现约 2ms 得到 TOOL_TIMEOUT，独立审查者确认。原开发代理修复 a8d8b23，集成 094d9c7：本地/远程注册与派发均拒绝超过 2_147_483_647 ms，接受合法上界，补回归并更新 JSDoc。两个新用例先因未抛错而失败，修复后定向 20/20、server typecheck、diff check 通过。原独立审查者运行定向 20/20、重做边界复现并确认 P2 关闭，无其他发现。
- 5.2：未发现可证实的本批缺陷；独立运行服务端 204/204 与任务 diff check 通过，确认跨 Step 预算、每轮重置、配对及取消监听器收束。
- 5.3：未发现可证实的本批缺陷；独立运行竞态与相关测试 37/37 通过，确认 HTTP/SQLite 历史及首版替身限制。

## 最终交付

统筹在审查修复后的 094d9c7 再次运行 `pnpm typecheck` 全部通过，服务端最终 **206/206** 通过。首次重跑为 205/206，既有 `routes-acceptance.test.ts` 的 SSE 测试在 `fetch` 连接动态端口时出现 `bad port`；没有进入快照断言。随后原测试单独复跑 1/1 及全量复跑 206/206 均通过，未修改范围外测试，原始失败已记录到本地 issue。Web 40+11、build 在此前最终功能集成代码上通过，此后修改只涉及服务端超时上界；不重复无关 Web 检查。

仅勾选本轮 2.8、5.1、5.2、5.3，未勾选全局 7.x。README 已同步超时、预算、成功结束及首版未知结果限制；本次 API 中文 JSDoc 已由开发者、统筹和独立审查者对照行为核对，没有专用 JSDoc 静态检查器，不声称自动覆盖检查。

成果保留于 codex/tool-timeout-conclude 的独立工作树；未合并 main、未归档 OpenSpec change。主工作区既有前端探索及其他工作树内容未纳入本批。开发和 continue-review 已完成，工作流在此暂停，后续任务等待用户指示。
