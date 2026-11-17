# Task 7.2：跨模块故障路径验收计划

状态：已完成开发、验证和独立审查。基线：`main` 的 `2f5456b`。范围仅为 OpenSpec `agent-harness-prototype` 的 7.2；依赖 4.3 和 7.1 已完成，四类规划产物均就绪。以 `tasks.md`、design §5–§8 以及 `agent-execution`、`execution-streaming`、`tool-governance` 三份规格为准。

## 验收方式与测试边界

推荐沿用 7.1 的方式：Web 用 Vitest/jsdom 驱动真实 `App`，接实际 Fastify HTTP、SSE、临时 SQLite 和模拟模型；只有 EventSource 及本地 URL 在测试边界适配。工具调用走真实 MCP SDK 和独立监听的模拟 MCP。另用 Node 测试启动并强制终止后端子进程验证重启。单独扩充后端测试无法证明页面同步及重连行为；全部在浏览器中验证会额外引入浏览器依赖，且存储与崩溃仍需进程侧夹具。页面结论明确限于 DOM 行为和真实网络帧。

| 测试边界 | 验证内容与限制 |
| --- | --- |
| App 的公开交互、真实 follow SSE、HTTP 历史 | 验证审批刷新、流式断线、失败提示、断线恢复及 live 与已提交前缀的差异。EventSource 由测试适配，不覆盖浏览器原生 EventSource 或页面布局。 |
| SQLite 写入、独立只读观察及服务端诊断 | 用临时数据库的写事务阻挡实际写入，对照故障前后的 HTTP 历史、服务端告警和 SSE。只在测试里定位故障时机，不以替换 `Session.flush` 的返回值代替写入失败。 |
| MCP 请求与临时台账 | 计数 `tools/call`，核对调用参数、`operationId`、历史结果及实际效果。只对模拟工具验证幂等协议。 |
| 子进程生命周期与重启后公开 API | 在外部证据已确认后强制终止持库子进程，再用同一临时库启动后端验证自动关闭遗留记录；不通过正常关闭、手填事件或直接调用恢复函数模拟崩溃。 |

## 场景与通过条件

| 场景 | 实施与预期 |
| --- | --- |
| 工具成功写入、响应丢失 | 沿用 4.3 的故障语义。在 MCP 转发夹具中扣住实际成功响应，独立读取台账确认操作、参数和效果已提交，再销毁响应连接。核对 Harness 的工具结果与原操作配对，记录失败缘由且不误报成功。等 Turn 完整结算后确认 Harness 仅发送一次该操作，后续模型是否续答按现有工具失败契约核对，并确认没有再次派发。另由测试客户端显式重发相同工具名、参数和 `operationId`，返回保存的原结果，效果仍为一次。显式重发不经过 Harness，不改变此前的历史。 |
| 审批期间刷新 | 等 `approval/asked` 进入已提交 HTTP 历史，且实际工具请求、效果均为零。卸载并重挂 App，保留浏览器存储并重新 follow。快照应恢复同一审批 ID、工具、版本和参数；通过页面单次允许，得到同一审批的决定、一次派发和一次效果，同一 Turn 正常结算。观察连接和模型调用，确认刷新没有提交第二个 Turn。 |
| Turn 进行中断线 | 控制模拟模型先产生片段，等待页面显示草稿再中断真实 SSE 连接，由适配器向 App 投递断线。扣住模型的后续输出直到重新 follow，验证新快照带同一 Attempt、已收片段和继续位置。放行后验证草稿交接为一份结算回答，只有一次模型请求、一次终态，无重复用户消息、片段或取消。 |
| 仅后台写入失败 | 在模型已进入流、显式检查点暂不运行时锁住 SQLite 写入，控制模型正常结束，让结算尾部只经后台写入器处理。等实际写入失败和服务端告警，核对 SSE 没有 `agent/error` 或终止 `error`，页面显示原结算和正常终态，HTTP 仍只返回故障前的已提交前缀。解除故障后显式排空，观察原缓冲按序提交，原事件序号和内容不变；不重新执行 Turn。 |
| 执行检查点失败 | 参数化覆盖首次模型请求前、已显示正式回答且即将进入工具正文、以及首批工具已结算且即将继续请求模型。后两种先在页面确认由 `assistant/message` 结算的完整内容，再放行目标检查点；用待写记录和明确屏障定位检查点，保持真实 writer 和 SQLite 路径。核对一次安全的 `agent/error` 先于唯一失败 `turn/end`，有稳定分类时保留错误码，两端不向浏览器泄漏数据库诊断；无终止 `error`、无放弃已结算 Attempt。首次请求前模型与工具都为零；工具正文前失败不产生该工具请求、效果或下一次模型请求；续答前失败仅保留已完成的原工具结果与效果，新增模型请求和工具效果为零。故障尚未解除时，同进程重连快照仍需包含原 `assistant/message` 及失败终态，HTTP 历史保持已提交前缀。解除故障后，通过现有 `Session.flush()` 检查点确认失败终态随原尾部一次落盘；结算前缀逐项核对 `seq`、载荷和顺序。 |
| 执行错误与重连预算 | 投递真实 `agent/error` 时连接保持可用，继续接收后续原始事件，且不发起新 follow。随后受控断开连接，在成功快照安装前制造连续连接失败，比较有无执行错误的公开连接次数及停止状态，验证预算只用于同步故障；不读控制器私有计数。可复用现有 FollowController 的可控连接与调度入口做预算对照，实际页面仍由上一场景覆盖。 |
| 后端进程被强制终止 | 让真实工具批次至少含已派发且结果未知的写操作和一个尚未派发的声明。独立观察台账已有一次写效果、HTTP 已提交原 `tool/call` 与声明且还没有配对结果或 Turn 终态后，才终止后端子进程；MCP 和转发夹具继续运行，不交付原响应。重启后从已提交日志恢复，已调度调用补 `TOOL_OUTCOME_UNKNOWN`，未调度声明补 `TOOL_NOT_STARTED`，仅关闭实际打开的 Step 和 Turn，Turn 为 `interrupted`。核对原关联和前缀，重复打开或启动不追加修复记录；模型调用无增长、MCP 请求不重发，台账效果仍为一次。 |

夹具按已提交事件、真实帧、模型或转发请求的屏障推进；等待带截止时间。SQLite 用例优先采用独立连接的 `BEGIN IMMEDIATE`／回滚。若需要在测试驱动包装检查点来对齐 DOM 或落点，只等待条件、控制加锁并调用原检查点，不伪造错误结果或改换生产时序。写入器失败后会暂停后台排空；测试驱动可保留 `Session` 引用，等待原 Turn 终态并解锁后显式 `flush()`，再经 HTTP 核对提交，不增加恢复路由。测试在异常退出时也要释放屏障、事务、网络连接、子进程及临时目录。比较模型与 MCP 计数前应等对应 Turn 或恢复结算完成。

## 开发与交接

1. 用户批准此计划及上述测试边界后，从已核对的 `2f5456b` 创建 `codex/fault-path-acceptance` 和隔离工作树 `.worktrees/fault-path-acceptance`。只复制本计划到新工作树，保留主工作树现有的未提交 OpenSpec 与其他任务文件；核对 7.2 条款在基线与当前工作树一致。分派给全新上下文的 GPT-6.1 Terra（`gpt-6.1-terra`、`high`）开发子 agent，明确工作树、基线、方案、权限和验收要求。
2. 按 TDD 一次推进一条路径，先补可观察的测试，再做必要的最小修复。以 `apps/web/src/mcp-turn-acceptance.test.jsx`、`apps/server/src/text-session.test.ts`、`apps/server/src/event-session-app.test.ts`、`apps/mock-mcp/src/server.test.ts` 为参考。新增或扩展的用例必须进入现有默认测试命令。记录现有行为直接通过的验收与实际复现的缺陷。优先只新增验收测试与局部夹具；不引入生产故障开关、依赖、自动重试或未知副作用恢复。如修复需要扩大到计划外的协议、持久化或工具语义，先给出已复现证据及最小变更方案，再取得授权。
3. 命令用 PowerShell 7，TypeScript 不使用 `any`；JS/TS 变更执行 `jsdoc-contracts`，核对涉及 API 的中文 JSDoc，行内注释只解释非显而易见的原因。新工作树有需要时用 `pnpm install --frozen-lockfile`。先运行新增用例并复跑存储、重连与强制终止用例，再运行 `pnpm typecheck`、`pnpm --filter @mharness/web test`、`pnpm --filter @mharness/server test`、`pnpm --filter @mharness/mock-mcp test`、`pnpm --filter @mharness/web build`、`git diff --check` 和 `openspec validate agent-harness-prototype --strict`。主 agent 核对产物并重新验证关键路径。完整证据通过后只勾选 7.2，并记录命令、结果和验收边界。
4. 完成开发与验证后，按用户本次已指定的 `continue-review` 自动进入审查。主 agent 另起一个干净上下文的只读子 agent，针对固定基线到交付工作树的完整改动（含新增文件），独立审查 7.2 覆盖、故障注入证据、无重试/无重复效果、时序与资源清理；主 agent 整理发现和最终验证。未经后续请求不合并主分支，不归档 OpenSpec。


## 执行证据（2026-11-17）

- `apps/web/src/mcp-turn-acceptance.test.jsx` 通过真实 App、HTTP、SSE、SQLite 和 MCP 测试审批期间刷新、响应丢失、流式断线、后台写失败和三处执行检查点失败。检查点通过事件屏障与独立 SQLite 写锁定位，失败后解锁并由原 `Session.flush()` 提交原缓冲。工具正文前锁定时 `tool/operation` 已接受而未提交，写请求为零；续答前已有一次写效果，模型不再调用。真实错误码为 `ERR_SQLITE_ERROR`，响应丢失的工具结果为 `MCP_TRANSPORT_ERROR`。
- `apps/web/src/session/follow-controller.test.js` 对照有无 `agent/error` 时的公开连接次数、原始事件交付和重连终态。
- `apps/server/src/fault-crash-acceptance.test.ts` 在已确认工具台账和已提交前缀后强制终止后端；两次重启均重新装配同一模拟模型和 MCP 注册表，核对未知结果、未开始结果、关联序号、终态、重复恢复及零重派发。`apps/server/src/test-support/mcp-client.ts` 仅为跨包测试复用已有 SDK 客户端导出。
- `pnpm typecheck` 通过；`pnpm --filter @mharness/web test` 通过（Node 41、Vitest 64）；`pnpm --filter @mharness/server test` 通过（214）；`pnpm --filter @mharness/mock-mcp test` 通过（7）；`pnpm --filter @mharness/web build` 通过；`openspec validate agent-harness-prototype --strict` 通过。构建有依赖 Zod 的注释位置警告，不影响构建。
- 单独复跑存储和流式重连（5 项）、重连预算（1 项）、强制终止（1 项）通过。执行 `git diff --check` 通过，Git 提示工作区行尾转换。
- 本次只增加测试与测试辅助导出，没有修改生产行为或引入依赖。核对了新增声明：没有新增生产公共 API；跨模块测试辅助重导出 SDK 声明，并以中文 JSDoc 说明仅供测试及连接关闭责任。未发现本次相关的 JSDoc 静态检查，按技能要求进行了人工核对。
- 页面结果限于 jsdom DOM 与真实网络帧；EventSource 为测试适配器，不覆盖原生 EventSource 或布局。幂等结论仅适用于模拟工具。没有执行真实 Provider 验收，仍属 7.3 范围。


### 审查修复与复验

- 后台写失败告警后，在同一真实 SSE 流中等待告警时已观察心跳之后的新心跳，按接收顺序消费到该屏障并检查业务帧；等待有 20 秒截止时间。测试适配器仅记录心跳，不交给 App 作为业务帧。
- 临时在告警后的队列注入 `agent/error`，定向测试因发现多出的错误帧按预期失败；恢复原测试后，后台写失败定向测试通过。
- 修复后重新运行 `pnpm --filter @mharness/web test`（Node 41、Vitest 64）、`pnpm typecheck` 和 `git diff --check`，均通过；Git 仍提示工作区行尾转换。对测试辅助导出的中文 JSDoc 及客户端关闭责任进行了人工语义核对，未运行 JSDoc 静态检查。

### 独立审查结论

一个干净上下文的子 agent 只读审查了从 `2f5456b` 到交付工作树的完整差异。审查指出测试 SDK 重导出缺少中文 JSDoc，主 agent 发现后台写失败用例可能漏掉 Turn 终态之后排队的错误帧。两项均已修复，审查子 agent 复跑后台写失败用例并确认两项关闭，没有遗留可操作问题。

主 agent 独立复跑 Web 105 项、服务端 214 项、模拟 MCP 7 项，并验证类型检查、前端构建、OpenSpec 严格校验和差异检查。补强心跳断言后，开发子 agent 复跑完整 Web 测试及类型检查，主 agent 与审查子 agent 分别复跑后台写失败用例。
