# 审批、工具状态与 Turn 闭环实施计划

用户通过 continue-dev 授权本批 6.3、6.4、7.5、7.6 的开发与必要修复，并预先要求开发后直接 continue-review，分别启动独立子 agent 审查各任务 diff。沿用 agent-harness-prototype 已确认设计，不走 OpenSpec apply，不归档，不开展 4.1–4.3，也不合并 main。

基线 main@b7f0709。集成分支 codex/approval-tools-integration，工作树 .worktrees/approval-tools-integration。开发代理均为新建 GPT-6.1 Terra / high；各任务独立工作树、独立提交，统筹串行集成并记录 base/head。主工作区既有未跟踪文件和旧工作树保留。

## 执行顺序与职责

1. 统筹先保存本计划，运行基线检查并准备独立工作树。使用 planning-with-files 的持久记录方式，工作记录存入本批 .scratch，正式任务完成状态只维护 OpenSpec tasks.md。
2. 新开发代理并行执行 6.3 与 6.4。6.3 拥有审批 HTTP 适配与共享审批契约接线及审批联调测试；6.4 拥有工具/消息/Turn 投影、卡片及工具联调测试。不要同时修改已有 app.test.jsx；各自新增独立测试入口。共用 package.json 或联调辅助设施由统筹协调。
3. 集成两项后，由新开发代理执行 7.5：丢失中间消息实时 end、审批阶段取消、重连恢复、下一轮模型上下文、工具零执行。完成后再由新开发代理执行 7.6 与联验：成功 concludeTurn A + 明确错误 B、均执行且持久化、completed、无下一模型请求、真实页面结果一致。
4. 统筹运行最终全仓类型检查、服务端全部测试、Web 全部测试及构建、diff check、OpenSpec strict validate；核对本批中文 JSDoc 与任务验收证据后才勾选四项。
5. 直接进入已授权 continue-review。针对 6.3、6.4、7.5、7.6 分别新开独立只读审查代理，读取各任务 base/head 和最终集成调用链。证实的问题交开发代理修复并由独立审查者复核；修复后运行相关检查。最后保存审查与验收记录，不归档。

## 验收矩阵

| 任务 | 必须可验证的结果 |
| --- | --- |
| 6.3 | 浏览器消费唯一共享审批答复契约；真实审批按 id、operationId 对应确切工具/版本/参数；刷新恢复；200 重发、409 已有决定、409 approval_not_active、404 收敛；结果或终态关闭；重复答复无重复执行。 |
| 6.4 | 真实 tool/call 准备卡片及原始参数、operation 已校验参数、可展开详情；增量、刷新快照、flush 后 HTTP 历史投影一致；参数错误配对；等待审批；截断/取消标签；无正文声明无空泡；reasoning 折叠；恢复 TOOL_NOT_STARTED；错误与 meta 重放。 |
| 7.5 | 带文字调用提交后丢失 end，审批期间取消，通过真实链路重连；文字仅一次，工具正文计数 0；下一轮模型输入包含此前完整文字、工具调用及取消结果。 |
| 7.6 | A 成功且 concludeTurn=true，B 明确失败；调用顺序与效果计数正确，两个结果均保存，Turn completed；Provider 请求总数 1；页面、重连、日志一致。 |

## 实现与测试约束

开发采用测试先行，记录真实 red/green；既有行为首次通过属于新增验收覆盖，不能虚报 red。使用生产 HTTP/SSE/Agent 路径、临时数据库、模拟 Provider 和无外部副作用的注册工具。不得用手写完整事件窗口替代正式联调；DOM 断言可检验真实 App 内容，但不能宣称本批验证了浏览器布局。

TypeScript 禁止 any。应用 jsdoc-contracts、karpathy-guidelines 及代码注释规范；公共契约中文 JSDoc 记录行为、失败与资源所有权，内部注释仅说明必要原因。不增加 MCP 接入、自动重试、持久幂等台账、迟到核实或范围外重构。当前无专用 JSDoc 静态检查器，人工核对并如实报告。

## 初始核对

- 6.15 / 6.14 及后端 3.3 / 3.5 / 5.2 已实现；6.3、6.4、7.5、7.6 尚未勾选。
- 审批请求/决定 Schema 现位于 apps/server/src/approval/contracts.ts，浏览器尚未统一消费；6.3 在现有 @mharness/session/contracts 浏览器边界提供同一 Schema，保持服务端兼容导出，避免双份定义。
- 仓库无 GLOSSARY.md、docs/adr 或 .superpowers-memory，按规则继续，不创建空文档。
- 上一批曾出现系统动态端口触发 fetch bad port；新增真实网络测试应避开禁用端口，保留实际失败证据，不用反复重试掩盖问题。

## 执行与审查记录

基线已亲自执行：`pnpm typecheck` 通过；服务端 `pnpm --filter @mharness/server test` 206/206 通过；Web `pnpm --filter @mharness/web test` 40 项 Node + 46 项 React 通过；Web build 通过，仅保留两条既有 Zod 上游注释警告。基线 Web 实际用例数是 46，与上一批记录的 11 不同，以本次运行输出为准。

6.3、6.4 以 cc71a69 为共同基线启动独立 Terra/high 开发。统筹将 Web 常规入口扩展为 `src/*.test.jsx`，确保本批新增独立联调测试参与常规检查。

集成 6.3（49f521e → 08fc576）及 6.4（f9e5863 → 6e0b501）后，统筹复跑6.3新增测试2/2通过。首次常规Web测试的Node40/40通过，但Windows未展开`src/*.test.jsx`且Vitest将其当普通筛选文本，报告没有测试。入口改用Vitest文件名筛选`.test.jsx`后重新验证，不能以单独测试通过替代常规入口可执行。

7.5新建Terra/high子agent首次启动遇登录令牌刷新错误（logged out or signed in to another account），尚未开展代码工作；统筹已尝试恢复一次。

| 任务 | 开发 diff / 集成提交 | 已有验证证据 |
| --- | --- | --- |
| 6.3 | cc71a69..49f521e / 08fc576 | 共享导出缺失用例先报 undefined safeParse，接线后通过；真实 App/HTTP/SSE/Agent/临时SQLite 验证允许、首次拒绝、刷新、200重发、409决定冲突、404与恢复后inactive；工具执行计数仅1。新增2/2统筹复跑通过。 |
| 6.4 | cc71a69..f9e5863 / 6e0b501 | 摘要断言真实失败后最小修复；真实链路验证校验失败、审批、元数据/错误、reasoning、取消/截断及TOOL_NOT_STARTED，关闭排空并重开后完整工具投影与HTTP历史、刷新快照一致。 |
| 7.5 | 待执行 | 已创建 codex/approval-cancel-acceptance 工作树，基线6e0b501；新Terra/high代理及一次恢复均在启动时因令牌刷新失败，未写代码。 |
| 7.6 | 待执行 | 等待7.5完成后新建Terra/high代理。 |

统筹在6e0b501集成内容及edd7fc5测试入口上亲自完成新鲜检查：全仓`pnpm typecheck`通过；服务端206/206；Web Node40/40 + React49/49；Web build通过（两条已有Zod上游注释提示）；`git diff b7f0709 HEAD --check`与`openspec validate agent-harness-prototype --strict`通过。本批API中文JSDoc经开发者及统筹人工对照，项目无专用JSDoc静态检查器；测试使用jsdom验证真实App内容，不声称已验证浏览器布局或真实MCP。

独立continue-review：为6.3新建了未参与开发的只读审查agent，但同样启动即报登录令牌错误，未实际审查；6.4/7.5/7.6独立审查仍待启动。不得将此次启动失败写成审查完成或无发现。

用户选择“重新登录后继续Terra子agent”，未授权统筹替代剩余开发。当前等待用户重新登录确认，之后恢复7.5，串行完成7.6与联验，再分别新开四项独立review代理。6.3/6.4行为验收已通过并勾选；7.5/7.6保留待办。README同步已交付契约及交互，不归档、不合并main。
