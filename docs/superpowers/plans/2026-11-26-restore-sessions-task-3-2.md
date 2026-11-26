# 会话侧栏与创建对账 3.2 实施计划

> **For agentic workers:** Use superpowers:subagent-driven-development and superpowers:test-driven-development. 先运行失败测试，再做最小实现。

**目标**　完成 OpenSpec 的 3.2。侧栏按活动时间排序并隐藏未选中的空会话。本页成功创建与明确选择按会话 ID 对账。未知创建交由目录通知和重连快照同步。

**架构**　保留独立的目录 GET/SSE 和单会话 follow。目录控制器负责版本合并，页面负责合并本地确认的创建、投影可见项和保留窗口选择。

**技术栈**　React、TypeScript、Vitest、Node test runner、pnpm。

## 基线与范围

- 复用 feat/restore-sessions-from-server。起始 HEAD 为 58911490fb29b7cf32a90b8177b10f02e1cf278b。临时索引基线树 3a0732b50f21736f2cb2e2804324f3f3cf8a3507 含当前工作区的前序实现和 OpenSpec。就地继续以保留这些未提交依赖及真实索引。只用显式路径生成 3.2 候选树。
- 以 restore-sessions-from-server 的 design.md、execution-streaming 增量规格和 tasks.md 为准。目录/SSE 协议、服务端核实、选择存储和聊天 follow 沿用既有契约。3.3 和 4.x 保持独立。
- 使用 pwsh.exe。TypeScript 禁用 any，使用 jsdoc-contracts 核对变更 API。

## A. 侧栏投影与 201 对账

**文件**　apps/web/src/session/use-conversation.ts、apps/web/src/session/directory-controller.ts、apps/web/src/directory-sync.test.jsx。必要时补 apps/web/src/session/directory-controller.test.js。

- [x] 写受控页面测试。已选 A，切入另一目录代次读取之前，当前目录曾收到空会话 X 的 added。读取开始后本页 X 的 POST 返回 201。目录 GET 尚未完成时再发不推进进度的 api-session/error，覆盖它发布的旧目录副本。旧快照缺少 X，断言 X 仍选中、共享提示仍为 X、X 的 follow 保持打开。补 POST 先于 added、相同 ID 只出现一次、以服务端摘要排序、X 切走后为空则隐藏。补本页开始创建后用户明确选择 A，在 201 先于目录摘要时 A 不被抢选，X 保留在完整数据但隐藏。已有显式清空、改选及迟到 201 测试一起保留。
- [x] 在同一套测试挂载共享存储的 A、B，分别建立目录 SSE。B 新建空会话，在两页模拟 added 并向 B 返回 201。A 选中仍为原会话且侧栏顺序不动，B 选中新会话。向 A 送 updated 后显示该会话且不移动选中。再发送 activity 检查排序与更新不回写共享提示，也校验并列按 ID 升序。对已有行为仅作回归覆盖。
- [x] 运行 pnpm --filter @mharness/web exec vitest run src/directory-sync.test.jsx src/session-selection.test.jsx。旧实现预期在 added 先于 201 的重连竞态以及未选择的临时空行断言失败。
- [x] 让 201 为确认 ID 登记完成顺序，即使当时已见到服务端摘要。以接收的服务端摘要代替同 ID 的本地摘要。开始时间早于该 201 的缺项快照保留该记录，开始于之后的缺项快照收敛。区分目录快照缺项和明确撤回。已被快照覆盖的撤回仅作为本地对账凭据，且只在快照和有效重放合并后该 ID 仍缺失时使用。测试较新快照仍含同 ID 或撤回后收到新的 added 时不清掉当前项。目录读取期间用旧副本发布的 error 不确认目录成员关系，不结束创建保护。只有无更新的本页选择意图时自动选中新建 ID。完整目录保留本页确认，侧栏只投影非空或当前选中，继续按活动时间降序、ID 升序排序。
- [x] 复跑定向页面测试和 pnpm --filter @mharness/web exec node --test src/session/directory-controller.test.js。测试应全部通过。

## B. 移除手动核实并验证未知结果收敛

**文件**　apps/web/src/features/conversation/ConversationView.tsx、apps/web/src/session/use-conversation.ts、apps/web/src/directory-sync.test.jsx、apps/web/src/app.test.jsx。

- [x] 先改旧按钮测试。503 返回 session_creation_unknown 与 ID 时，验证无核实按钮，不 GET 单会话历史、不打开该 ID 的 follow、不清空或改写当前选择。保持真实目录 SSE 能接收同 ID 的 added、updated 和 activity。向目录注入撤回和断线补齐，覆盖 503 前后、快照覆盖的撤回、快照仍含该 ID、快照较新且缺少该 ID。用可见反馈或同 ID 已成为当前目录选中的情况验证对账，避免只断言按钮消失。确认已知 POST 失败仍可见。
- [x] 运行 pnpm --filter @mharness/web exec vitest run src/app.test.jsx src/directory-sync.test.jsx。旧实现预期因显示手动核实按钮或缺少新反馈而失败。
- [x] 503 解析合法载荷后只在本页记住原 ID 供对账，不制造本地成功条目。移除手动核实动作、历史 GET、按钮和由它们决定的空状态。用可信撤回或开始于记录该 503 之后且缺项的完整快照清除记录。已明确在途撤回的 ID 不因迟来的 503 重新登记。目录仅出现该 ID 不触发成功或自动选中。若反馈结果未知或后续撤回，在新建入口附近使用非交互状态，保留已有选择和新建能力。
- [x] 复跑同组定向测试，确认通过。

## C. 让隔离演示提供真实目录语义

**文件**　apps/web/src/fixture.tsx、apps/web/src/dev-fixture.test.jsx。更新上述用例内的测试替身。

- [x] 先扩展演示测试。现有演示历史仍可打开，创建返回 201，快照能读取同 ID，切走后隐藏空项。重连前后各只出现一行，真实站点 localStorage 保持不变。运行 pnpm --filter @mharness/web exec vitest run src/dev-fixture.test.jsx。旧演示预期因 POST 后 GET 始终返回初始数据而失败。
- [x] 让 fixture 在内存记录演示摘要、目录进度和活跃目录订阅。POST 增加一次条目，发送一次 added 并返回 201。目录 GET 返回当前快照，close 释放对应的目录订阅。复用 3.1 已有演示存储隔离。
- [x] 复跑演示定向测试，确认通过。

## D. Full 验证和两路独立复审

- [x] 主 agent 新鲜运行 pnpm typecheck、pnpm --filter @mharness/server test（含 Session）、pnpm --filter @mharness/web test、pnpm --filter @mharness/mock-mcp test、pnpm --filter @mharness/web build、openspec validate restore-sessions-from-server --strict。记录失败到通过的证据、测试数量、中文 JSDoc 人工核对及固定差异 git diff --check。
- [x] 固定同一候选 Git 树与基线树。两路复审均只读。一路使用 MHarness 项目评审技能，一路使用 Codex 原生评审，均用 gpt-6.2-sol / high。原生入口不可用时按照工作流派同配置独立子 agent 并披露。发现阻断项先复现和修复，再针对最终候选重跑 Full 和两路复审。
- [x] 仅在最终候选全部通过后勾选 OpenSpec 3.2，并核对 checklist 差异。归档留待后续明确指令。

## 实施与验证记录

- 独立计划评审先指出已被快照覆盖的撤回只能在合并结果仍缺少该 ID 时用于对账，以及重连等待期间旧目录副本的 error 可能提前解除 201 保护。计划补齐针对性测试后获得 GO。
- RED 覆盖了 201 后旧目录副本和旧快照清空选择、未选中的本地空行仍显示、503 仍提供历史核实、演示 POST 返回 200、被快照覆盖的迟到撤回未解除本地保护，以及快照缺项早于或晚于 503 时待确认提示未正确收敛。先观察预期失败，再复跑实现后的定向用例。
- 双窗口回归验证 A 隐藏 B 的新空会话、首次 Turn 后显示、活动时间重排和 ID 并列规则，并检查 A 的本页选择与共享恢复提示。演示页面回归实际触发目录重连，核对选中项及唯一行，保留真实存储隔离。
- 对称 503 顺序回归补齐后，四个 Web 页面测试文件共 159 项通过，目录控制器 11 项通过，Web TypeScript 检查通过。人工核对了 useConversation、SessionNavigation 和目录控制器回调的中文 JSDoc。
- 第一轮固定候选 210ffc1bcde96f6034d93a0f483a0c17f86866b5 通过 Full。两路评审均复现缺项快照结束未知状态时未显示失败提示。Codex 原生评审还指出，若客户端漏收新增和撤回，快照先于迟到的 503 完成时应补取目录以确认缺项。评审同时要求确保折叠状态中的反馈可见，并强化旧快照和演示通知测试。第一轮固定差异漏纳已通过的双窗口测试，下一轮将其纳入同一候选。
- 第二轮固定候选 a45edc967f054fea69b2540b086618f0a583eafc 包含双窗口测试并通过 Full。项目与原生复审独立复现了反向到达顺序仍未结算的情况，即未知响应在重连读取过程中先到，旧读取随后缺少该 ID。原生复审还复现了演示订阅在同一 JavaScript 轮次创建时先收到 added、后收到 ready 的顺序问题。
- 第三轮固定候选 00a863531f406decf4e08aea0fd1d09be9a90b5a 通过 Full 与 MHarness 项目复审。两种到达顺序、补读有项与缺项及演示 ready-first 均先用失败用例固定，再验证通过。原生复审另复现了实时新增已应用时仍重连，以及演示 GET 未按活动时间排序的问题。补测分别因健康订阅提前关闭和原始结果顺序错误失败，修复后转绿。
- 最终候选 471d4a5e6def344192c3ac9ad018fbd0bdd14933 通过 Full。服务端与 Session 720 项，Web Node 68 项与 Vitest 186 项，Mock MCP 7 项。全项目类型检查、Web 构建、OpenSpec 严格校验和固定差异空白检查通过。新增及变更的中文 JSDoc 已人工核对。
- 最终同一固定差异获得两路 GO。MHarness 项目复审与 Codex 原生 review 均使用 gpt-6.2-sol / high，分别独立通过 Web 定向 165 项与目录控制器 11 项。项目复审另用受控 DOM 核对了目录补读次数和失败反馈。两路通过后仅勾选 OpenSpec 3.2。
