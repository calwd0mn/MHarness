# 工具操作、审批与串行批次实施计划

## continue-dev 与授权范围

用户明确要求继续既有 `agent-harness-prototype`：先写 plan，并行开发 3.2、3.4，再开发 3.3、3.5，开发由新的 GPT-6.1 Terra 高思考子 agent 完成，最后为各任务新开独立 review 子 agent。该请求已授权本轮代码修改和 continue-review，无需再次请求同一授权。

基线为 `8119358`，根工作区只有既有未跟踪 `.scratch/`，不覆盖或纳入本轮提交。集成分支为 `codex/tool-governance-batch`，位于 `.worktrees/tool-governance-batch`。各开发任务使用独立 repo-local worktree 和分支，按任务独立提交，保留可核对的 base/head。OpenSpec status 已确认四类规划产物完成；本轮沿用已确认设计及上一轮工具基础计划，不走 OpenSpec apply，不扩大为 MCP、超时策略、前端审批 UI 或 2.8 的结束意向交付。

## 分工与顺序

| 任务 | 所有权与交付 | 前置 |
| --- | --- | --- |
| 3.2 操作绑定和策略 | `apps/server/src/tools/operation.ts` 及测试；必要时最小调整注册服务。参数校验后保存操作，按会话及 `(turn,step,callId)` 重用原操作，提供可信 allow/deny/ask 决策及配对失败。 | 使用 3.1、3.7 与现有 Session 契约；与 3.4 并行。 |
| 3.4 取消派发门 | `apps/server/src/tools/dispatch.ts` 及测试；提供同步原子派发资格、取消传播与逐调用结果保留，不依赖审批模块。 | 用可控 Promise 验证取消竞态；与 3.2 并行。 |
| 3.3 审批服务 | `apps/server/src/approval/` 的服务、共享答复 Schema、路由与测试；必要时应用装配最小接线。审批契约归属审批能力，事件继续由 Session 原样交付。 | 3.2 合入后开发；复用 3.4 的派发前取消约定。 |
| 3.5 串行批次 | `apps/server/src/tools/batch.ts` 及测试、模型驱动和应用工具装配的最小改动。消费上述真实模块，按原模型声明顺序保存调用和结果并控制续答。 | 3.2、3.4、3.3 全部合入后开发。 |

每项开发均启动全新的 Terra 高思考代理。代理只能修改自己的任务范围，不更新根计划、OpenSpec tasks 或其他代理文件。跨模块接口先报告统筹并与消费者确认，避免两个任务复制实现同一状态机。依赖、锁文件和集成文档由统筹串行处理。TypeScript 禁止 any；使用 jsdoc-contracts 维护涉及 API 的中文 JSDoc，内部注释只解释非显而易见的原因。

## 实施与验收

1. **TDD**：每个任务先写能捕捉目标缺陷的失败用例，记录 red，再实现并记录 green；不以编译失败代替行为失败。使用临时 SQLite 库与可控时序，不操作开发数据库或真实 Provider。
2. **3.2**：非法 JSON/参数只产生本调用失败，无 operation、审批或正文执行；允许和拒绝都不询问；允许仍需检查点。可信版本、参数不可变，同一调用范围重传重用标识，同参数的新调用和不同 Step 不混用。核对 follow 已接受前缀、flush 后 HTTP 历史和快照的共同事件一致。
3. **3.4**：待审批、已批准未派发、等待检查点取消均不执行并保存 `ABORTED_BEFORE_DISPATCH`；已派发无最终结果保存 `ABORTED`，不声称没有副作用；已确认结果保留。取消及派发没有可插入的异步间隙，迟到 resolve/reject 不改写结果或产生未处理异常。保证协作退出的工具等待清理，其他工具停止等待的策略不冒充远端已停止；完整超时由 5.1–5.3 另行验收。
4. **3.3**：operation 和 asked 检查点成功后才发起请求；同一操作沿用审批，决定按 id 唯一保存并经 flush 后交付。HTTP 覆盖首次/重复 200、冲突/已关闭 409、`approval_not_active`、404 及无渠道 unavailable。分别注入 asked、decided 持久化失败，正文次数为零。审批等待不锁住读取、取消或答复，新 prompt 仍 agent_busy 且不排队。用户拒绝作为独立批次中止原因传递。
5. **3.5**：完整 assistant 先接受并展示、通过 flush 后进入工具阶段；不完整参数与失败 Attempt 不派发。按声明保存 tool/call，再校验、操作、策略、审批、最终 flush、取消检查和派发；每个结果通过现有投影保存。无效调用不阻止下一项及下一 Step 修正。明确拒绝、取消、派发异常停止后续调用，按模型顺序补齐未执行结果，保持已完成项；不同 Step 重用 callId 仍按范围隔离。续答前确认结果和 step/end 已提交，检查点失败阻止模型和工具；崩溃恢复维持既定 TOOL_OUTCOME_UNKNOWN 保守规则。2.8 的 concludeTurn 汇总独立保留待办，不在本轮声称完成。
6. **最终验证**：运行 `pnpm typecheck`、服务端全量测试、Web 测试与构建、`git diff --check`、`openspec validate agent-harness-prototype --strict`。逐项核对 JSDoc 行为及覆盖；如果没有专用静态检查器，明确只做人工语义核对。

## continue-review 与收尾

开发及集成验证后直接执行用户已授权的 continue-review。为 3.2、3.4、3.3、3.5 分别启动新的独立审查代理（与开发者不同），只读应用 mharness-code-review，对各自 base/head diff 及最终调用链审查，并核对规格、失败路径、取消竞态与 JSDoc。统筹将可操作发现交给开发代理修复并补回归，审查代理复核。保留每项审查范围、发现和检查证据。

仅在真实行为与验证证据满足时勾选本轮任务，README 记录实际接口和当前限制。本 change 仍有其余任务，不归档，不合并主分支或改动既有用户工作。最终汇报分支、任务状态、验证和审查结果，以及尚未交付的能力。
