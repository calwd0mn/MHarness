# 会话目录任务 1.3 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development and superpowers:test-driven-development. 按复选框推进，记录每组测试的红灯原因和绿灯结果。

**目标**：让目录实时反映首次 Turn、用户活动和 Agent 状态，并从已提交前缀定期保存会话目录元数据。

**架构**：复用 Agent 与 Session 的同步观察入口，在目录投影中应用变化并分配版本。SQLite 写句柄跟踪已确认的前缀，在指定触发点写入检查点；冷目录继续从清单读取摘要。

**技术栈**：TypeScript、Fastify、Node.js SQLite、Node.js test runner、pnpm。

---

## 范围和工作区

- 起点为 `feat/restore-sessions-from-server` 上的 `58911490fb29b7cf32a90b8177b10f02e1cf278b`。现有 Web、技能、忽略规则及文档改动与 1.3 的代码路径不重叠。复用当前分支，使用只包含本任务文件的固定差异做评审，不整理已有变更，不提交。
- 依据 `openspec/changes/restore-sessions-from-server/tasks.md` 的 1.3、同变更的 `design.md` 和 `specs/execution-streaming/spec.md`。本任务交付可被后续 SSE 层消费的内部通知。2.1 负责完整业务订阅与新增、撤回、就绪和 HTTP SSE 装配。
- 使用 PowerShell 7、严格 TypeScript、中文 JSDoc。先运行服务端基线。确认测试失败原因后写最小实现。

## A. 在线投影和运行通知

**修改**：`apps/server/src/session/directory.ts`、`apps/server/src/app.ts`、`apps/server/src/agent/react-agent.ts`。**测试**：`apps/server/src/session/directory.test.ts`、`apps/server/src/event-session-app.test.ts`。

- [ ] 接上真实 Agent 的目录观察，在 prompt 前监听其公开状态、已接受事件与公开错误。定向测试用空会话已提交头和阻塞写入或同步回调控制时序。先断言运行状态发布时 `blank === true`，随后收到含实际 `seq: 0` 的首次 Turn 更新，同时独立 SQLite 读取的 `eventCount === 0`。输入真实用户消息后时间上升；添加较旧或等时的用户消息、由其他来源生成的消息和后续 Turn，断言对应重复更新缺席且版本无额外增长。
- [ ] 用可控驱动发出公开错误、等待收尾门闩、再退出。错误到达时目录仍为 running，错误帧没有 revision；收尾前不得收到 idle。维护开始和结束都保持目录运行值为 false 且不推进版本。验证相同状态去重，并覆盖 GET 持久化清单返回后看见已应用的摘要与对应 revision。
- [ ] 在 Agent 单独暴露同步状态观察，状态发布点分别在首次追加前和内部活动清理完之后，再复用已有 observation 取 log event 与 agent/error。避免把状态通知混入现有聊天 follow 的事件流。未知驱动故障若需公开通知使用稳定公开文案，原始异常仅用于服务端诊断。代理释放时撤销目录观察，保留已保存目录项。
- [ ] 用目录刚接入时的 Session 投影 / 公共状态建立比较基线。对每次实际字段变化，先更新相关内存摘要（包括适用的临时项），再推进 revision 并发给内部观察者；不通过 GET 发布或纠正其他观察者。以真实被接受事件及 payload 比较，有效时间取 `max(createdAt, lastPromptAt)`。确保分支在 onLoaded 先于 onSessionCreated 的既有时序下只登记一次，继承历史只建立基线，不作为新活动发布。对冷加载建立正确比较基线且不发布历史事件；未发布分支保持 GET 补齐语义。
- [ ] 运行 `pnpm --filter @mharness/server exec node --import tsx --test src/session/directory.test.ts src/event-session-app.test.ts`。预期先因新通知缺失而红，补齐后全绿。

## B. SQLite 已提交目录元数据

**修改**：`packages/session/src/storage/sqlite-persistence.ts`、`packages/session/src/session.ts`。需要共享投影规则时使用包内的 `packages/session/src/list-metadata.ts`，无须修改共享 HTTP 契约。**测试**：`packages/session/src/storage/sqlite-persistence.test.ts`、`apps/server/src/session/directory.test.ts`。

- [ ] 用 v2 真实库记录触发测试。创建普通空会话后断言 checkpoint 为 `{ blank: true, lastPromptAt: null, eventCount: 0, inheritedEventCount: 0 }`；创建带继承前缀的分支后断言检查点包括完整继承边界和首批事件。仍持有写句柄时验证第 199 条无新检查点，第 200 条保存；小批量用 Node 测试时钟推进到 4999/5000ms，期间追加事件不得重新起算。另测已提交 `turn/end` 提前保存、释放补齐已提交尾部和只读句柄无写入。使用真实 committed view 检查每个触发点。
- [ ] 从 SQLite 写句柄的确认点更新已提交投影，同时覆盖普通追加、初次创建、暂存提交和待定批次核实。基于批次及其 start 推进，不从在线 Session 读可能超前的元数据。基线可复用绑定时已确认无尾部的投影，或从同写句柄已提交前缀取得；未绑定写入同样受触发规则约束。读取现有旧日志只允许发生在写入生命周期按需建基线，保持 GET、冷目录重建和 schema 升级仅查元数据。复用相同的事件投影语义，真实用户时间取最大值。
- [ ] 保留初次创建的事务原子性。数量及 Turn 结算触发可与事件在同一事务保存，若分开保存需隔离检查点故障，不误报已经确认的事件提交。未确认批次不更新投影；核实已提交后只更新一次。计时器从首条待保存的已提交事件开始，清理或成功保存后重置，释放前在排空/核实之后保存可确认的未保存前缀并取消计时器。独立保存不得加入或中断另一句柄的事务，遇到该事务仍在活动时保留待保存前缀并重试。用 v2 故障注入在 SQLite 实际 COMMIT 后丢弃回执，验证核实只推进一次投影与待保存计数。v1 保持现有行为。
- [ ] 用两个独立的真实 SQLite 重启用例验证恢复。子进程把空头和初始检查点提交，并分别在首条 Turn 进入内存后、写入提交前退出，或在首条 Turn 提交后、保存触发前退出。子进程直接退出，跳过正常 release。独立只读连接可用于检查崩溃前提交窗口。父进程重新打开同一文件，先核对持久 eventCount 分别为 0 和 1、检查点仍为 0，再通过 SessionDirectory.restore/query 验证分别恢复为空与按创建时间可见。最后另验证完整应用重启后的 GET。应用正常启动会先补写中断的 turn/end，因此冷摘要断言必须在应用修复前完成。补测在线用户消息被接受却未提交时，就算定时器触发仍只保存此前确认的元数据。旧测试显式构造其所要求的旧格式或落后检查点，避免把 1.3 的正常释放视为旧行为。
- [ ] 运行 `pnpm --filter @mharness/server exec node --import tsx --test ../../packages/session/src/storage/sqlite-persistence.test.ts src/session/directory.test.ts`。新触发测试应先因检查点仍缺失或落后而红，完成后全绿。

## C. 独立验证和评审

- [ ] 运行 `pnpm typecheck`、`pnpm --filter @mharness/server test`、`pnpm --filter @mharness/web test` 和 `openspec validate restore-sessions-from-server --strict`，记录退出状态和通过数。若 Web 仅在现有本地修改上失败，复现并标明与本批的关系。
- [ ] 核对涉及 API 的中文 JSDoc、计时器清理和命令适用的平台路径；仅在通过验收后将 OpenSpec 1.3 打勾。
- [ ] 固定以起点为基线、仅包含 1.3 的差异。让 MHarness 项目评审和 Codex 评审对照同一版本独立只读检查，汇总评审结果。

## D. 首轮评审后的修复

- [x] 在 `packages/session/src/storage/sqlite-persistence.test.ts` 补故障测试，覆盖检查点读取失败仍提交事件、锁冲突时释放后的保存、提交回执丢失后的原定期限。用现有 Web「工具前检查点失败」用例复现同进程 SQLite 锁等待叠加。
- [ ] 在 `packages/session/src/storage/sqlite-persistence.ts` 保持首次检查点与会话头同事务。让后续保存通过存储层管理的零锁等待连接，冲突时稍后重试。释放时交接待保存的已确认前缀，保存前核对会话身份与边界，避免覆盖更新的检查点。隔离派生检查点故障，核实提交后保留原定期限。
- [ ] 在 `apps/server/src/session/directory-live.test.ts` 覆盖重入顺序、目录错误去重和读取期间释放。在 `apps/server/src/agent/react-agent.ts` 与 `apps/server/src/session/directory.ts` 保持通知有序，在失败轮次退出前补齐公开目录错误，复核 GET 版本覆盖范围和原有聊天跟随契约。
- [ ] 重跑 `pnpm --filter @mharness/web exec vitest run src/mcp-turn-acceptance.test.jsx -t '工具前检查点失败'`，期待原超时设置下通过。按 C 重跑全量验证并固定修复后的候选差异进行两次只读评审。

## E. 复审后的边界覆盖

- [x] 在 SQLite 检查点恢复中使用零锁等待读写，并保持原定触发时间。用连续读取故障和丢失提交回执的用例验证后台只核实已提交批次，释放后仍能完成保存。
- [x] 用 v2 数据库和真实 Agent 覆盖两次清单读取，包括检查点仍落后和仅由 GET 发现的分支。响应不得把遗漏的活动帧算入 `revision`。同时验证真正的存储故障在取消并发时仍发送目录错误，单独取消保持静默。

本轮服务端 697 项、Web 178 项通过，类型检查与 OpenSpec 严格校验通过。候选树为 `b6016fce9162755a96ef5f0b30d909692c4d4561`。项目评审和 Codex 原生评审启动时遇到用量限制，备用独立评审确认两处剩余保存问题。

- 普通批次已提交但回执丢失且同步核实失败时，后台只核实包含 `turn/end` 的批次，普通批次可能漏掉 5 秒或第 200 条触发。
- 到期检查点遇锁后，若其他事件在重试前提交，原候选因计数变化被丢弃，原定保存期限也随之丢失。

## F. 检查点最终回归

- [x] 用真实 SQLite 复现普通批次丢回执后的 5 秒与 200 条触发，包括重开时前 199 条积压且投影读取故障。
- [x] 验证已到期的检查点在锁释放或新句柄继续追加后仍保存，回滚批次不进入检查点，旧会话头的原始 JSON 可参与身份校验。
- [x] 对固定候选 `e8aedc6b2012fbeabf20caf0d5f86d2498182107` 完成全量验证和两路独立复审，随后勾选 OpenSpec 1.3。

最终验证通过。服务端 707 项，Web 178 项，类型检查、OpenSpec 严格校验与固定差异空白检查均通过。MHarness 项目复审和 Codex 原生复审均通过。
