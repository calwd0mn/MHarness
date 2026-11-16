# 工具基础契约实施计划

## continue-dev 与范围

用户已授权本轮先写 plan，再并行开发并以 continue-review 启动新的独立审查子 agent。基线为 `fb0dea3`，工作区起始干净。继续已确认的 `agent-harness-prototype`，OpenSpec status 确认 proposal、design、specs、tasks 均已完成；不进入 OpenSpec apply，不重写已确认设计。

本轮交付 3.1（工具注册、治理及输入校验）、3.6（自有结构化工具结果）、3.7（持久化工具结果投影）。依据 design §4.1–§4.2、tool-governance 增量规格及既有 Session 日志契约实施。暂不接通审批、批次调度、MCP、超时、真实 Provider、fork 或压缩，不以基础服务测试代替这些后续任务的闭环。

选择理由：纯文本链路已通过，3.1 与 3.6 没有互相阻塞的实现前置；3.7 等结果契约稳定后接入。三者为 3.2、3.3、3.5 的审批和调度提供直接前置。另一条可行路线为先做 1.7 fork，或 8.5 压缩暂存；两者本轮均不影响工具主链解阻。2.6 还需明确真实 Provider，放在专门轮次决定。

## 分工、所有权和顺序

| 工作包 | 任务与文件所有权 | 前置与验收 |
| --- | --- | --- |
| tools-registry | 3.1；`apps/server/src/tools/registry.ts`、`registry.test.ts`、`schema.ts` | 与结果工作包并行。注册配置来自可信调用方；模型只得到工具定义。Zod 4 同源导出输入 JSON Schema，代表性输入通过独立 JSON Schema 校验器做判定对照。 |
| tools-result | 3.6；`apps/server/src/tools/result.ts`、`result.test.ts`，必要的同目录快照辅助文件 | 与注册工作包并行。提供内存结果契约、HarnessError、值校验及纯 render/presentationMeta 派生；不写 Session 日志。 |
| tools-projection | 3.7；`apps/server/src/tools/result-event.ts`、`result-event.test.ts` | 前两项合入后启动。消费 result 的真实导出及 Session 公共入口，生成并追加配对结果，验证已接受、落盘、重开和模型重建。 |

开发代理使用 GPT-6.1 Terra 高思考度，按 TDD 记录 red/green。前两项各用从基线建立的 repo-local worktree；集成时仅回传各自拥有的文件。投影工作使用集成后基线并单独保留 diff。开发代理不得修改 tasks、根计划、README、锁文件或彼此文件；需要依赖时由统筹代理串行添加。TypeScript 不使用 any。调用方可依赖的公共约定按 jsdoc-contracts 维护中文 JSDoc，内部注释仅解释非显而易见的原因。

## 接口衔接

结果模块拥有规范化结果：成功 `isError:false`、可选运行期 `value`、`content`、可选 `meta` 与 `concludeTurn`；失败 `isError:true`、`error:{message,info?:{name,code}}`、`content` 和可选 `meta`，不带 value 或结束意向。本地成功必须先校验输出值并取得独立不可变快照，再从同份参数和值派生 content/meta。输出定义、转换函数、原始异常和 value 不进入普通持久结果。

注册模块拥有可信工具身份、版本、执行边界、取消退出保证、副作用、幂等、查询、审批和超时。未知副作用默认需审批，MCP/远程不因本机地址获得可靠取消保证。输入准备不进入审批或执行；为后续调度保留明确的已验证调用边界。正文返回 value；由集成步骤接通统一结果归一化，测试替身不跳过未来所需审批或检查点。

投影模块以 Session 当前日志中的声明、调度和操作为关联依据，按 `(turn,step,callId)` 配对，消息来源和工具结果块使用同一调用标识。追加来源引用 tool/call，无调度时引用 Assistant 声明；有操作时保存原 operationId。结果的 event.meta 不进入模型上下文；失败仅投影可用 error.info，普通错误只有安全说明。保持既有替换校验与稳定消息身份，不修改共享事件格式。

## 验收与证据

1. 3.1：合法参数、缺失必填、未知字段、错误类型、声明值域在 JSON Schema 与 Zod 入口判定一致；JSON 解析失败与参数校验失败可区分；失败的审批及正文调用数均为零。模型参数不能覆盖策略。默认未知与远程取消约束有测试。
2. 3.6：先校验再 render；无效值不会调用 render；Schema、render、meta 任一失败都得到安全 INVALID_TOOL_OUTPUT 且省略 value/结束意向；同份不可变值派生模型和 UI 内容。普通异常不泄漏秘密。
3. 3.7：成功/失败均有带 isError/content 的消息，按调用范围配对，操作标识存在与缺省均正确；原值、函数、输出定义不落盘；重开和重放不重新 render，meta 不进入模型输入；验证 HTTP 原始历史与 follow 共用契约能接受保存事件。
4. 集成执行 `pnpm typecheck`、服务端测试、Web 测试及构建、`git diff --check`、OpenSpec 严格校验。按真实证据决定是否勾选任务，不用文档或测试数量代替行为验证。

## continue-review

用户已提前授权开发完成后连续进入 review，无需重复询问。为三个工作包分别建立新的独立 review 子 agent，使用 mharness-code-review，审查每项相对其基线的 diff，并追踪集成调用方、spec、测试和中文 JSDoc。审查者只读，不参与开发或修复。统筹代理或原开发代理处理具体发现并补回归，原审查者复查。完成后更新本计划的证据及剩余限制；本 change 尚有其他任务，不归档。

## 实施记录

- 三个开发工作包均已完成并串行回传主工作区；每个工作包保留独立 worktree 和相对 `fb0dea3` 的 patch。交付按工具注册、结构化结果、持久化投影和文档记录拆分为四个提交，任务勾选随对应实现提交。前端改动与 `.scratch/` 本地记录不纳入提交。仓库没有 `.superpowers-memory/`，不创建替代记忆目录。

| 工作包 | 开发与独立 review | 验收证据 |
| --- | --- | --- |
| 3.1 | tools_registry_dev / tools_registry_review，未发现具体 P1/P2 | 5 项注册测试覆盖 Zod/Ajv 判定对照、字符串长度和 emoji、数字范围、严格未知字段、类型错误、不可等价规则拒绝、治理默认值、错误分类以及参数冻结。负零和非有限数在准备时拒绝，保证可保存为操作参数。 |
| 3.6 | tools_result_dev / tools_result_review，首轮发现 1 项 P2，修复复查通过 | 首轮仅保留 Zod 定义而未提供输出 JSON Schema。新增 defineLocalToolOutput，由同一份受限 Zod 定义导出冻结 JSON Schema 并绑定运行时校验；共享 schema.ts，拒绝不等价规则。9 项结果测试覆盖快照、派生失败、安全错误、结束意向与 Ajv 边界对照。 |
| 3.7 | tools_projection_dev / tools_projection_review，首轮及 API 适配复查均未发现具体 P1/P2 | 2 项集成测试覆盖 Registry→执行→归一化→Session→SQLite→重开，跨 Turn/Step 的同名调用、调度与未调度来源、已有操作、准备失败且正文次数为零、稳定消息身份、重放不 render、实际模型输入隔离 meta、HTTP 历史及 follow 帧解析。 |

公共 API 的中文 JSDoc 已由开发与审查对照行为人工核对。未发现专用 JSDoc 静态检查器，本轮没有新增检查器，也未声称 CI 强制覆盖。输入和输出共用明确支持的 JSON 子集，不声称支持任意 Zod 结构。

## 最终验证（2026-11-16）

- `pnpm typecheck`：全部 workspace 通过。
- `pnpm --filter @mharness/server test`：145/145 通过（原基线 129 项，新增 16 项）。
- `pnpm --filter @mharness/web test`：40 项 Node 测试与 11 项 React 测试通过。
- `pnpm --filter @mharness/web build`：通过；保留两条 Zod 上游 Rollup 注释警告。
- `git diff --check` 与 `openspec validate agent-harness-prototype --strict`：通过。
- Ajv 8.20.0 仅新增为服务端开发依赖；锁文件只增加对应 importer，其他已有版本保持基线。

后半程工作区出现本轮之外的前端 App、入口、样式与 theme.css 改动；未覆盖、暂存或纳入工具工作包 review。最终主树 Web 测试和构建也在这些改动存在时通过。本轮没有对其做 UI 行为或视觉验收。

## 剩余范围与后续顺序

仅勾选 3.1、3.6、3.7。注册和结果投影是后续调度使用的内部入口，正式 Turn 尚未接入这些基础模块；远程仅保存治理信息，未实现 MCP 参数校验或派发。准备成功不等于审批通过或工具正文执行，底层 execute 的调用方须完成审批、持久化检查点与取消检查。

建议下一轮先并行 3.2（操作绑定与 pre-execute）和 3.4（取消/派发状态门）；3.3 接 3.2 落地审批与 HTTP 答复；3.5 等 3.3、3.4 和本轮 3.7 后接串行批次与模型续答。5.1 的工具级取消清理可在 3.1 基础上并行准备，Turn 级验收等待 3.5。真实 Provider、fork 和压缩按原任务依赖另行安排。本 change 仍有未完成任务，保持进行中，不归档。
