# Task 7.1：模拟模型与 MCP 的 Turn 闭环验收计划

状态：开发、验收与独立审查通过。基线：`main` 的 `4596626`。仅执行 OpenSpec `agent-harness-prototype` 的 7.1；4.1、5.3、6.3、6.4 已完成，proposal、design、specs、tasks 已就绪。以 `tasks.md`、design §4.2、§5、§7、§8 和 `tool-governance` 规格为准。

## 验收方案

采用可重复运行的 Web 集成套件：用当前 Vitest/jsdom 运行真实 React `App`，用户提交、单次允许、拒绝、取消均通过实际页面控件。请求和 SSE 走真实 Fastify 监听与 Session 路由，只在 jsdom 边界适配相对 URL 和 EventSource，读取真实网络帧。后端使用 `createEventSessionApp`、`createModelTurnDriver`、受控 `createMockAdapter` 和 `connectMcpTools`，由真实 MCP SDK 调用独立监听的 `startMockMcp`。Session 与 MCP 台账分别使用临时 SQLite 文件。

推荐此方案，因为现有 Web 和 MCP 测试已分别验证两段链路，复用入口即可在同一场景核对页面、记录和效果。单独扩充后端测试无法证明页面消费正确；另建真实浏览器套件能检验原生 EventSource 和浏览器行为，但会引入新的运行依赖，7.1 的页面内容与交互验收可沿用现有 DOM 集成边界。验证记录会标明 jsdom 的范围。

在测试中用本机转发夹具计数 `tools/call`，按 MCP 工具、业务参数和注入的 `operationId` 记录；初始化、目录查询和取消通知不计入工具调用。转发夹具不生成工具结果。超时用例只扣住指定真实响应，等真实工具返回后留下证据，再让 Harness 达到测试专用的等待上限；测试观察到 Turn 终态后释放响应并清理。副作用超时用例要先观察到台账写入和 MCP 成功响应已被夹具扣住，避免把未派发、连接失败或工具本身报错误当成超时。场景使用条件或屏障等待，加有界截止；超时越早、越晚都不能绕过实际链路证据。普通用例不缩短生产默认超时。

## 场景与预期

| 场景 | 页面及已提交记录 | 模型调用、MCP 请求及实际效果 |
| --- | --- | --- |
| 正常问答 | 实际提交，正式用户消息、回答各一条，Turn 为 `completed`。 | 模型 1 次；工具请求 0；写入效果 0。 |
| 单次允许后调用 | 等待审批时显示已绑定工具、版本和参数；点击允许后保存同一审批 ID 的 `allowed-once`；同一操作得到成功结果，续答并正常结束。 | 批准前工具请求和效果均为 0；总计模型 2 次、写请求 1 次、效果 1。核对 MCP 请求和持久操作的 `operationId`、参数，以及续答收到配对结果。 |
| 只读超时继续 | `mock_read` 保存并显示 `TOOL_TIMEOUT`；下一步模型收到配对的超时结果，生成回答；Turn 为 `completed`。 | 模型 2 次、读请求 1 次、写入效果 0；没有重发。 |
| 副作用超时结束 | 多调用批次中先允许 `mock_write`，扣住已成功的远程响应；当前调用以 `TOOL_TIMEOUT` 结算，页面显示结果未确认；后续调用结算 `TOOL_NOT_STARTED`，Turn 为 `error/TOOL_TIMEOUT`。 | 模型 1 次、首个写请求 1 次、后续请求 0、台账实际效果 1。响应释放后结果、终态和计数保持原值。 |
| 用户明确拒绝 | 批次包含需审批的写调用与免审批的后续读调用。点击拒绝后，保存 `rejected`，首个调用配对 `APPROVAL_REJECTED`，后续调用配对 `TOOL_NOT_STARTED`，Turn 为 `blocked`。后续调用不得出现 `tool/call` 或 `tool/operation`。 | 被拒绝的正文和后续派发均为 0：MCP 无任何 `tools/call`，台账效果为 0；模型总计 1 次，拒绝后新增调用为 0。 |
| 等待审批时取消 | 通过「取消任务」取消仍在审批的写调用；关闭审批交互，保存 `ABORTED_BEFORE_DISPATCH`，Turn 为 `aborted`，原因 `user`。 | 模型 1 次、工具请求 0、写入效果 0。 |

每个场景从真实 SSE 等到 `turn/end`，核对页面中的回答、工具状态和终态，再等待已提交历史覆盖该序号。按连续的 `seq` 比较 live 原始记录与 HTTP 持久历史；对照 MCP 计数和独立只读 SQLite 台账中的操作及效果。以正式 Assistant 声明为起点，按 `(turn, step, callId)` 验证每个调用恰有一个结果，核对结果错误码、来源序号和已有的 `operationId`；对拒绝的后续调用验证来源为 Assistant 声明。完成后重开页面读取快照，核对渲染与持久历史一致；正常关闭和释放测试资源，不模拟崩溃、断线或丢失响应后的重发（7.2）。

## 开发与交接

1. 获准后，从已核对的基线创建 `codex/mcp-turn-acceptance` 和隔离工作树 `.worktrees/mcp-turn-acceptance`。保留主工作树现有本地记录。使用全新上下文的 GPT-6.1 Terra / high 开发子代理，明确固定工作树、基线、计划和 7.1 范围。
2. 测试先行，按现有 `apps/web/src/*.test.jsx` 入口纳入默认 Web 测试，参考 `conclude-turn-live.test.jsx` 的真实 SSE/落盘结构和 `apps/server/src/tools/mcp.test.ts` 的 MCP 装配。先用正常问答与批准用例建立夹具，再加入超时、拒绝和取消。记录现有行为直接通过的用例和实际复现的失败；若发现 7.1 所涉行为缺陷，先固定失败断言，再做范围内的最小修复。优先只增加验收代码，不新增生产配置和依赖。
3. 使用 PowerShell 7。TypeScript 禁用 `any`。实现时按 `jsdoc-contracts` 维护变更 API 的中文 JSDoc；行内注释只写非显而易见的原因或约束。先单跑新增套件并复跑含时序的场景，再执行 `pnpm typecheck`、`pnpm --filter @mharness/web test`、`pnpm --filter @mharness/server test`、`pnpm --filter @mharness/mock-mcp test`、`pnpm --filter @mharness/web build`、`git diff --check` 和 `openspec validate agent-harness-prototype --strict`。统筹复验并记录命令、结果和边界；六条路径及跨层核对全部通过后只勾选 7.1。
4. 开发和验证完成后停在 `continue-review`。收到该指令后，由一个干净上下文的只读子代理独立审查固定基线到交付工作树的完整变更（含新增测试），按 7.1 和项目约定检查需求、断言有效性、时序稳定性及清理。OpenSpec 保持活跃。

## 实施与验收记录

2026-11-17，GPT-6.1 Terra（高思考）开发子代理在 `codex/mcp-turn-acceptance` 新增 `apps/web/src/mcp-turn-acceptance.test.jsx`，通过默认 Web 测试入口执行。六个用例核对真实 SSE 与已提交 HTTP 历史，并在刷新后核对页面状态。只读超时结果进入下一次模型请求。副作用超时保存结果未确认，独立只读台账已观察到一次写入。拒绝后无 MCP 请求或新模型请求，第二个调用从 Assistant 声明配对未开始结果。取消发生在等待审批阶段。

测试先行期间修正了测试夹具的审批服务、fetch 接线和随机端口问题。六条路径在既有产品实现上通过，生产代码无改动。人工核对中文注释和 JSDoc，本次没有新增或修改公共 API，仓库没有专用 JSDoc 检查命令。页面通过 jsdom 验收，网络使用真实 HTTP、SSE 帧和 MCP 请求，EventSource 由测试适配。

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @mharness/web exec vitest run src/mcp-turn-acceptance.test.jsx` | 新增用例多次通过，每次 6 项，包含最终改动。 |
| `pnpm --filter @mharness/web exec vitest run src/mcp-turn-acceptance.test.jsx -t '超时'` | 两条超时路径单独复跑通过。 |
| `pnpm --filter @mharness/web test` | Node 40 项、Vitest 57 项通过。 |
| `pnpm --filter @mharness/server test`、`pnpm --filter @mharness/mock-mcp test` | 服务端与 Session 213 项、模拟 MCP 7 项通过。 |
| `pnpm typecheck`、`pnpm --filter @mharness/web build` | 全仓类型检查和前端构建通过，构建保留两条既有 Zod 注释警告。 |
| `git diff --check`、`git diff --no-index --check`、`openspec validate agent-harness-prototype --strict` | 已跟踪与新增文件均无空白错误，OpenSpec 严格校验通过。 |

## 独立审查

一个干净上下文的只读子代理审查了从 `4596626` 到验收工作树的全部变更，未发现需要修复的问题。审查复跑新增 6 项及完整 Web 套件 97 项，均通过。差异检查和 OpenSpec 严格校验均通过。
