# 会话目录第一批实施计划（2026-11-26）

> **执行方式**：使用 `superpowers:subagent-driven-development` 和 `superpowers:test-driven-development`。经用户批准本计划后开始改动。主代理独立验证，安排两次只读审查，并等待用户决定如何处理发现。

**目标**：在已有实现上完成 `restore-sessions-from-server` 的 1.1、1.2，使列表 GET 返回可用于恢复的目录基线，并由后端独立核实首次创建结果。

**架构**：应用入口装配必需的目录查询。GET 从已提交清单出发，合并当前进程的在线状态及创建临时项，再在同一同步步骤取得完整摘要和其覆盖的 SSE 进度。创建核实由独立于请求生命周期的后端任务负责，冷会话借助持久化检查点生成摘要。

**技术栈**：TypeScript、Zod、Fastify、Node.js SQLite、Node.js 测试运行器、pnpm。

---

## 当前基线与范围

- 已在 `feat/restore-sessions-from-server`，HEAD 为 `4721d1f`。工作区含用户原有暂存和未暂存改动、第一轮实现及旧父 ID 修复。续作前记录实际差异，保留这些输入，并在后续审查快照中标明既有改动和本批新增差异。
- 保留已存在的目录摘要与 SSE 帧契约、首次注册提前可见和 `flush()` 成功后关闭失败仍成功的响应语义，以及旧分支父 ID 修复。此前服务端 613 项通过是历史证据。
- 2026-11-26 的定向基线在加载 `packages/session/src/api/directory.ts:4` 时因独立的 `wo` 报 `ReferenceError`，相关测试未执行。先在获得开发授权后处理该阻塞，再重跑基线。
- 当前目录 GET 仍只取内存快照，缺省目录依赖会创建空对象。启动重建逐会话读取完整日志，单会话历史 GET 仍会改变核实状态。这三条是本批要替换的旧路径。
- 以当前 `openspec/changes/restore-sessions-from-server/` 的设计、增量规格和任务为准，术语沿用 `GLOSSARY.md`。本计划接替 2026-11-25 的计划用于后续执行。任务 1.3 的定时和定量检查点、实时状态及事件通知，2.1 的 SSE 传输、2.2 的客户端续接，以及 3.2 的 Web 手动核实移除按各自任务交付。本批提供这些任务依赖的元数据读取和查询边界。

## A. 恢复基线

**文件**：`packages/session/src/api/directory.ts`、`apps/server/src/session/directory.test.ts`、`apps/server/src/session/routes-acceptance.test.ts`。

- [ ] 复核独立的 `wo` 在执行时仍存在，记录当前代码差异，仅在开发授权内解除导入阻塞。
- [ ] 运行 `pnpm --filter @mharness/server exec node --import tsx --test src/session/directory.test.ts src/session/routes-acceptance.test.ts`。预期两个文件均能加载，旧父 ID、首次提交时序和既有分支场景通过。记录与新规格相反的旧断言，分别在 B 至 D 用新验收替换。

## B. 冷摘要与初始检查点（1.2 存储基础）

**文件**：`packages/session/src/persistence.ts`、`packages/session/src/server.ts`、`packages/session/src/storage/sqlite-persistence.ts`、`packages/session/src/storage/sqlite-persistence.test.ts`、`apps/server/src/session/directory.ts`、`apps/server/src/session/directory.test.ts`、`apps/server/src/app.ts`。

- [ ] 先写真实 SQLite 测试：空会话头首次提交后重开可读到空检查点，未提交头重开时不存在；旧库无检查点可读且不扫日志；只读打开不迁移；已有未知版本或损坏库的保护仍通过。用替身让冷目录的事件读取入口抛错，构建目录仍须成功。预期旧实现没有检查点，并会打开日志。
- [ ] 为持久化清单补充可选的目录检查点。建议使用以会话 ID 为键的 SQLite 附表，保留原 `header_json` 和现有事务核对规则。已知旧格式可只读打开，未知版本继续拒绝。写入升级由应用入口在取得实例所有权后显式调用，以事务完成；存储构造器不会仅因打开旧库就升级；首次空头与初始检查点在同一事务提交。读清单时以同一 SQLite 读取截点取会话头、事件数、继承数和检查点。格式升级不得扫描旧事件或将旧的未知状态写成空。
- [ ] 检查点保存 `{ blank, lastPromptAt, eventCount, inheritedEventCount }`，由记录键绑定同一会话。新空会话的值为 `{ blank: true, lastPromptAt: null, eventCount: 0, inheritedEventCount: 0 }`。只有检查点身份、字段和事件前缀可验证时才采用，分支还须匹配其继承边界。缺失、无效、落后或继承边界无法验证时，使用 `blank: false` 和 `updatedAt: createdAt`。有效检查点使用其 `blank` 和 `max(createdAt, lastPromptAt ?? createdAt)`。
- [ ] 应用启动原有的执行中断恢复保留自己的日志读取。目录初始化和 GET 共享冷摘要生成逻辑，无需为目录遍历事件。用真实应用重开验证空头与检查点恢复，直接验证未提交头不出现、已保存会话释放后仍可列出。用故障替身区分是执行恢复还是目录查询打开了日志。
- [ ] 运行 `pnpm --filter @mharness/server exec node --import tsx --test ../../packages/session/src/storage/sqlite-persistence.test.ts src/session/directory.test.ts`。预期上述存储兼容、默认值和不读日志用例由红转绿。另断言写入和读取初始检查点不会改变 SSE 进度。

## C. 列表 GET 与必需依赖（1.1）

**文件**：`apps/server/src/app.ts`、`apps/server/src/agent/manager.ts`、`apps/server/src/session/directory.ts`、`apps/server/src/session/routes.ts`、`packages/session/src/api/directory.ts`，以及路由、目录和直接装配路由的测试文件。用 `rg -n 'registerSessionRoutes\(' apps/server/src` 核对所有调用方。

已知直接调用覆盖 `apps/server/src/session/routes-acceptance.test.ts`、`apps/server/src/session/compact-routes.test.ts`、`apps/server/src/session/compaction-summary-acceptance.test.ts`、`apps/server/src/session/tool-result-pruning-acceptance.test.ts` 和 `apps/server/src/tools/operation.test.ts`。

- [ ] 先写路由验收：依赖缺失时阻止装配；清单读取故障时返回错误，即使曾有内存目录；只有查询及合并成功且无会话才返回 `200` 和空数组；启动后已提交但未发布 Agent 的分支仍在 GET 中出现。在真实 GET 路由验收中覆盖冷会话与已加载会话，令加载 Agent、打开事件正文和存储写入入口一旦被调用就失败。用受控延迟关闭覆盖同 ID 同时存在于已提交清单与创建临时项，只输出一条。预期现有装配兜底及内存查询会失败。
- [ ] 从应用入口显式注入目录能力，移除路由的空目录兜底。直接装配路由的测试显式使用真实依赖或目的明确的替身。GET 先 await 已提交清单，再同步查看当前注册表、创建临时项及 SSE 状态；合并完成后输出同一个截点的快照。使用注册表只读访问，不经过会加载 Agent 的入口。
- [ ] 按 ID 配对在线和持久化记录，比较 `createdAt`、普通或分支身份，以及分支的原始 `parentSession` 和继承事件数。将缺省 `isSeeded` 与 `false` 视为等价。身份冲突时记录服务端诊断并返回持久化冷摘要。在线摘要取已有 Session 的目录投影与 Agent 公开状态。若需先引入在线元数据读取能力，可从 Session 已加载的前缀初始化并同步随其已接受事件推进，供 GET 读取；定期持久化及实时通知接线仍归 1.3。GET 不重新读取或逐会话重放日志。
- [ ] 验证每个 ID 只返回一条摘要，未列入已提交清单的创建临时项仍可见。保留已发布分支和旧父 ID 回归。覆盖冷、在线、临时项的字段来源，活动时间降序、并列按 ID 升序，维护和无 Agent 的 `running` 为 `false`。
- [ ] 目录维护独立于 SSE revision 的进程内创建确认计数。创建流程确认保存时，在结束临时项参与合并的同一个同步步骤递增该计数，SSE revision 保持原值。GET 在读取已提交清单前记录计数，读取后若发现计数变化则重读清单并重新检查；计数稳定后同步合并在线 Session、Agent 与创建临时项并取得覆盖的 revision。GET 不直接读取 #pending。
- [ ] 用两个并发窗口的请求验证上述交接：让 A 的 GET 取得提交前的清单后挂起，等 B 的普通会话创建返回 201 且尚未加载 Agent，再恢复 A。断言 A 的首次 GET 已包含 B 的摘要且只出现一次，并覆盖 B 注册时发布的版本；确认保存本身不推进 SSE revision。
- [ ] 为进度边界写可控并发测试：清单读取挂起时发布一次在线变化，GET 若返回序号 N，摘要须已反映该变化或被更新结果覆盖。若清单和更新后的状态无法组成这个截点，重新取所需的已提交数据，避免用未覆盖的快照标为 N。用同一进度的两次快照验证新检查点可使 `blank` 从 `false` 变成 `true`。请求补齐分支或纠正摘要的过程中不调用实时发布入口、不推进 SSE 进度；无列表 GET 时也没有单独的扫描和补录任务。
- [ ] 运行 `pnpm --filter @mharness/server exec node --import tsx --test src/session/directory.test.ts src/session/routes-acceptance.test.ts src/session/compact-routes.test.ts`。预期新装配、合并和进度验收通过。完整服务端套件覆盖其余直接装配调用方。

## D. 创建三态与后台核实（1.2 创建流程）

**文件**：`packages/session/src/persistence.ts`、`packages/session/src/storage/sqlite-persistence.ts`、`packages/session/src/api/use-cases.ts`、`packages/session/src/api/submission.ts`、`apps/server/src/session/directory.ts`、`apps/server/src/session/routes.ts`、`apps/server/src/app.ts` 及对应存储与路由验收测试。

- [ ] 使用延迟读取复现旧并发：首次提交前读到缺失的历史 GET 在 POST 返回 503 后才交付。新验收要求该 GET 仍返回历史结果，且目录和核实状态不变；随后无客户端请求也能确认保存或撤回。用受控事务故障覆盖已提交读取失败、仍有提交可能、确认事务结束且未提交三条路径。保留提交前可见及 `flush()` 明确成功后关闭失败仍返回 201、启动核实次数为零的测试。
- [ ] 由持久化层给出原写事务已结束的可靠证据。显式回滚或写连接确认关闭并保证原事务已终止可以提供证据，普通历史读缺项、关闭异常或重试次数不能提供证据。首次创建把原事务的尝试级核实能力交给后台；即使句柄已从管理集合移除或 close() 已缓存失败，核实仍可检查原事务状态并在仍属于该尝试时重新尝试安全清理。清理不得影响后续事务。先用新的 SQLite 已提交读取核对原 ID 和创建身份，已提交头匹配即确认。首次读不到头时，只有确认原事务已结束后新的已提交读取仍无头，才可撤回；核实失败或事务仍可能提交则继续重试。不要改变普通执行写入器或暂存事务的确认语义。
- [ ] 用 SQLite 故障注入验证首次回滚与连接关闭均失败时暂留条目，解除故障后后台能重新取得该次尝试的证据。分别验证事务结束后新读到匹配头时确认保存、仍无头时只撤回一次，以及清理不会作用到后续事务。
- [ ] 创建流程登记 `(sessionId, attemptId)` 和待核实项。请求内的首次核实若已得出结论则返回 201 或 500，否则返回含原 ID 的 503。后端为同一次尝试独立调度最多一个任务，读取前和应用结果前核对身份。重试从 250 ms 开始退避，转为低频后继续，终态、替换或应用关闭时停止。关闭时取消定时器，迟到结果不能改写状态。
- [ ] 移除历史 GET 的核实分支，将存储确认从 HTTP 读取彻底拆出。持久化确认不推进 SSE 进度；确认未提交时先移除临时项，再交给实时发布边界产生一次带 `creation-failed` 的撤回，传输接线归 2.1。用假时钟和真实 SQLite 验证重试、保护当前尝试及关闭清理。
- [ ] 运行 `pnpm --filter @mharness/server exec node --import tsx --test src/session/routes-acceptance.test.ts src/session/session-api-new.test.ts ../../packages/session/src/storage/sqlite-persistence.test.ts`。预期旧历史 404 误撤回及未知结果不核实的回归先失败，再按新行为通过。用例覆盖正常创建、存储故障和无后续 HTTP 请求。

## 后续任务交接

- 1.3 接入已接受事件和 Agent 状态的实时通知，按已提交前缀的 200 条或 5 秒及生命周期触发保存 `SessionListMetadata`。用真实 SQLite 重开验证首 Turn 未提交时沿用有效空检查点、已提交但检查点落后时仍显示。2.1、2.2 验收独立 SSE 和相同进度的新快照安装。3.2 移除 Web 手动核实。

## 第一批验收与审查

- [ ] 主代理独立运行 `pnpm typecheck`、`pnpm --filter @mharness/server test`、`openspec validate restore-sessions-from-server --strict` 和 `git diff --check`。核对变更声明的中文 JSDoc 和类型约束，记录实际结果、必要的定向红绿证据及已知限制。
- [ ] 对同一个固定差异进行 MHarness 项目级审查和 Codex 原生审查，按工作流要求配置审查模型和推理强度。原生评审无法使用所需配置时采用独立只读子代理，并如实披露。汇总发现并等待用户决定，验收证据充分时只勾选已完成的 OpenSpec 任务。
