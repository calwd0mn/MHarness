# 模型驱动与 Attempt 剩余内容实施计划

继续 `agent-harness-prototype` 的 2.4、2.5。以现有 OpenSpec 的任务、design §3–§3.2、agent-execution 的请求快照、有限步数、结算与上下文筛选场景为验收依据。保留已完成的会话受理及前端同步行为。

## 依赖与范围

| 关系 | 当前状态与实施安排 |
| --- | --- |
| 1.6 surface、2.1 Agent 生命周期、2.3 Runtime | 已完成，先核对现有公开接口，再复用这些能力准备每次独立请求。 |
| 2.4 请求准备先于 2.5 正式接线 | Runtime 参数与模型信息、header 归一快照和请求重建可独立开发；Attempt 消费、结算与预算可用可控 Runtime 并行验证，约定接口后接线。 |
| 1.10 检查点与 1.12 恢复、6.1 实时交付 | 已实现，使用真实 SQLite、故障注入和 HTTP/SSE 回归，确认调用前崩溃不续跑、追加接受与实时 end 引用一致。 |
| 3.5 工具批次及续答、2.8 批次结束意向 | 按原任务后续接入。本轮保留最小可注入批次边界，用替身验证步数、结果检查点和取消阻止后续调度。当前未装配工具时继续安全结算未派发调用，保持调用与结果配对。 |
| 8.6 上下文超限压缩重试、2.6–2.7 真实 Provider | 按原任务后续验收。本轮使用模拟 Adapter，不启动压缩或新增真实 Provider。 |

## 并行开发与合入顺序

三个开发工作树使用本轮开始时的工作区快照为共同基线。开发代理均为 GPT‑6.1 Terra 高思考度，通过 TDD 验证公开行为，TypeScript 禁止 `any`，按 `jsdoc-contracts` 维护中文 API 文档。

| 分工 | 交付与文件职责 |
| --- | --- |
| A · 2.4 请求配置与重建 | 维护 Runtime、Adapter 配置和模型信息契约，补 reasoningEffort、stop、最大输出默认值及来源。归一快照同时用于实际请求和 header，准备每次独立的消息、系统提示与工具定义，并提供结算前缀的 header 折叠及请求重建入口。拥有 model 目录和独立请求准备模块，提前与 B 约定接口。 |
| B · 2.4 步数预算与 2.5 结算 | 维护 model-turn 和必要的 Attempt 内部模块。加入有限且经过校验的步数配置，在取消、预算耗尽、检查点或生成失败时停止后续调度。补四类结算、有序 reasoning/完整工具调用、紧凑流边界和时序、唯一 Attempt/Turn 终态，以及存储故障后保留缓冲。接入 A 的请求准备模块。 |
| C · 请求重放与故障集成验收 | 独立新增集成测试，捕获模拟 Adapter 输入后以真实持久日志各自 Assistant 结算前缀重建并逐项核对。覆盖恢复、surface 替换、配置和工具定义变化、检查点期间修改配置、调用前崩溃及不续跑。文件与 A/B 分离，使用双方公开接口接线。 |

默认最大模型步数采用集中配置，实施时记录具体值及边界语义。同一 Turn 在需要继续执行但达到上限时记录稳定的预算耗尽原因，不再发起模型或工具调用。纯文本正常回答仍以 completed 结束。

## 验收条件

1. 日志 config 保存 provider、model 和生效 reasoningEffort、temperature、maxTokens、stop。Adapter 模型信息补入的默认值同步记录在 adapterDefaults，显式不支持的 reasoningEffort 在调用前拒绝。旧 Runtime 输入的兼容映射在声明处说明，无法无损记录的参数在调用前拒绝。
2. initial、resume、change、series 和 startsSeries 有逐项证据。配置相同复用 header，配置、系统提示或工具定义变化写 change，surface 替换或显式新系列写 series，组合变化记录 startsSeries。
3. 每次请求重新派生独立消息数组。真实 SQLite 重开后，按对应 Assistant 结算前缀重建模型消息、生效参数、系统提示与工具定义，和实际捕获请求逐项相等。准备后发生的可变配置变更不影响本次请求。
4. 检查点失败时依赖的模型及工具调用为零，失败原因保留安全稳定代码，未知错误为 UNKNOWN。实时 agent/error 与失败 turn/end 正常交付，待写批次保留；恢复后可以排空，调用前崩溃只修复遗留范围。
5. Attempt 最多结算一次。completed 保存正式消息、完整有序工具调用、reasoning 和 usage；cancelled/truncated 仅保留非空展示正文；failed 仅保留诊断流。流的分片边界、顺序和相对时间可无损回放，回放不重复派生模型消息。
6. start 只在检查点成功、取得流对象并检查取消后发布。已开始的 Attempt 无论是否有 chunk 都有 end，追加成功引用实际事件位置，追加失败发 abandoned。Turn 终态独立且唯一，取消、截断、失败和预算耗尽不继续调度。
7. 截断或取消后的下一轮上下文排除部分回答，并保留此前正式消息与配对工具结果。Turn 结束后继续复用同一个 Agent。
8. 集成树与实际工作区执行类型检查、服务端与 Web 测试、Web 构建、差异空白检查和 OpenSpec 严格校验，仅在全部本任务条件满足后勾选 2.4、2.5。

## continue-review

开发及验证后，按用户已授权的流程为 A、B、C 分别启动未参与开发的新子代理，对照本计划、OpenSpec 及 `mharness-code-review` 审查各自 diff。审查发现由开发代理补回归测试并修复，再交原审查者复查。记录提交范围、验收矩阵、实际检查及尚待其他任务交付的能力。

## 实施与独立审查记录

共同快照为 `e631b908ba755476984e777140a5db942c2cc916`。A、B、C 均使用 GPT‑6.1 Terra 高思考度在独立工作树开发，A 的请求准备接口确定后由 B 接入驱动，C 接入两者执行真实 SQLite 验收。

| 分工与独立审查者 | 开发提交 | 审查修复及复核 |
| --- | --- | --- |
| A / drive_request_review | `604604f`、`62aa818`、`b20f623` | 修复多个准备器交替使用时缓存与最新日志不一致、无效工具定义过早写入，以及旧默认参数被静默忽略。复核 17 项相关测试通过，未再发现具体 P1/P2。 |
| B / drive_attempt_review | `b4d1a92`、`b3be2d5`、`73dbc6f`、`fa16671`、`ae5ffba`、`1468122`、`21f37ee` | 修复工具续答终态、部分已确认结果保留、非法工具分片污染公开帧、取得流后的取消检查及非 JSON 索引造成结算被拒绝。复核 25 项驱动测试通过，包含清理抛错后仍唯一结算取消。 |
| C / drive_replay_review | `78507df`、`c50b1aa`、`c04a7ee` | 补独立的消息字面量、实际 reasoningEffort 比较、相邻请求复用 header、紧凑流精确边界与时间，以及 failed Attempt 的持久前缀重建。4 项集成测试独立复核通过。 |

新增或修改的公开 Runtime、请求准备和驱动 API 已人工核对中文 JSDoc，仓库没有独立的 JSDoc 静态检查器。本轮没有宣称完成该类自动检查。

## 参数与预算约定

| Runtime 输入或来源 | 请求日志与实际调用 |
| --- | --- |
| `params.reasoningEffort` | 映射到 config.reasoningEffort，优先使用显式值，其次模型信息默认值，再其次旧 Adapter 默认值；统一校验支持值，补入的默认值记录在 adapterDefaults。 |
| `params.maxOutputTokens` | 映射到 config.maxTokens，保持既有 Runtime 名称兼容。模型信息 defaultMaxTokens 优先于旧 Adapter 默认值，默认来源同时写入 adapterDefaults。 |
| `params.temperature`、`params.stop` | Turn 使用显式值或保持缺省。若旧 Adapter 为这些字段提供隐式默认值，调用方须显式覆盖，否则在模型调用及 header 追加前拒绝。普通 Runtime 调用保留旧默认行为。 |
| `topP`、`endpointId` | 普通 Runtime 的既有能力保留，Turn 因既有 header 无相应字段而在调用前拒绝，保持实际请求可重建。 |

集中配置 `localConfig.model.maxSteps` 默认为 8，驱动可用正安全整数覆盖。达到上限且仍需继续工具或模型处理时，以稳定错误码 MAX_STEPS 结束，不派发该步后续批次；最后一步直接产生正常回答时仍以 completed 结束。默认未装配批次处理器的工具声明继续配对为 TOOL_NOT_STARTED 并以 blocked 结束。注入的文本结果批次用于预算与检查点边界验证，真实工具治理仍由 3.5 交付。

## 任务验收证据

| 任务内容 | 验证位置与结果 |
| --- | --- |
| 参数、默认来源、字段支持与快照 | `@apps/server/src/model/request-config.test.ts`、`@apps/server/src/model/runtime.test.ts`、`@apps/server/src/agent/request-context.test.ts` 覆盖默认优先级、兼容拒绝、显式支持值、工具快照、失败原子性、header 复用和四种 reason。 |
| 真实请求的逐结算前缀重建 | `@apps/server/src/agent/model-replay.test.ts` 捕获六次请求，真实 SQLite 关闭重开后分别重建并逐项比较实际配置、消息、系统提示和工具。消息同时与独立字面量比较，覆盖配置/工具变化、surface 替换、startsSeries、resume 和相邻相同配置复用头。 |
| 检查点期间变更与调用前崩溃 | 同一集成文件在检查点期间修改配置与工具定义，核对本次仍使用旧快照；子进程在检查点后退出，重开只修复遗留范围，不调用模型续跑。 |
| 四类结算、精确流回放及上下文 | 驱动和集成测试覆盖 completed、cancelled、truncated、failed，SQLite 重开后按固定时钟逐项核对连续和交错 chunk 的边界及 2/5/9/14/20/24/30ms 相对时间。失败流不展示，取消与截断部分不进入下一轮，既有正式消息和工具配对保留。 |
| 有界循环与取消 | `@apps/server/src/agent/model-turn.test.ts` 覆盖预算耗尽后不再调用模型或批次、已开始流的唯一 end、同步生成失败、取得流后取消、批次前取消、批次异常和部分已确认结果，以及工具结果检查点失败时不创建下一步。 |
| 持久化失败与原缓冲保留 | 真实 SQLite 触发器阻止提交时模型调用数为零，agent/error 与唯一失败终态使用安全文案；删除故障后原批次成功排空。既有真实 HTTP/SSE 测试回归 committed/abandoned 与失败终态交付。 |

非法但可 JSON 表达的分片仅用于失败诊断。NaN、Infinity、负零等无法由 Session 无损保存的工具索引在记录和公开发布前终止，保留此前合法诊断前缀并以 PROTOCOL 结算。迭代器清理抛错时只保证尝试清理、取消结算和停止后续调度，不能据此保证执行端资源已经释放。

## 最终验证

2026-11-16 在集成树运行 `pnpm --filter @mharness/server test`，129 项通过。`pnpm --filter @mharness/web test` 的 40 项 Node 和 11 项 React DOM 测试通过。`pnpm typecheck`、`pnpm --filter @mharness/web build`、标准差异空白检查和 `openspec validate agent-harness-prototype --strict` 通过。Web 构建仍有两条 Zod 上游注释警告。

结合上述各层证据，本轮勾选 2.4、2.5。工具注册、审批、真实批次调度、批次结束意向、真实 Provider 和上下文超限压缩重试继续依照 3.1–3.7、2.8、2.6–2.7 和 8.6 推进，整个 change 保持进行中。
