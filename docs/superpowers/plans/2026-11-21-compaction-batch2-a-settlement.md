# Compaction Batch 2 · A 8.3 基础结算实施计划

**审查基线** `codex/compaction-batch2-a-settlement`，HEAD `956e1d1502890f87e56ca27355a6b6dc5503e281`。工作树包含 B 8.2 的七份改动文件和 A 8.4 的两份恢复夹具，逐文件与各自工作树对照过。后续开发需要单独取得代码修改授权。此稿供独立计划审查。

**本次修订基线** 已批准输入稿 `8f00149203d4f8fea35e08b602ddd303d8fdfd7c`。

`@openspec/changes/agent-harness-prototype/tasks.md:201`
`@openspec/changes/agent-harness-prototype/design.md:364`
`@openspec/changes/agent-harness-prototype/design.md:384`
`@openspec/changes/agent-harness-prototype/specs/agent-execution/spec.md:342`
`@openspec/changes/agent-harness-prototype/specs/agent-execution/spec.md:429`
`@openspec/changes/agent-harness-prototype/specs/agent-execution/spec.md:468`
`@openspec/changes/agent-harness-prototype/specs/agent-execution/spec.md:489`
`@openspec/changes/agent-harness-prototype/specs/agent-execution/spec.md:771`

基础阶段交付一次摘要的失败、取消、暂存核对与唯一终态，以及启动和在线恢复对自有命令的 `command/done` 补齐。用真实 Agent、已绑定的 SessionWriter 和 SQLite 验收。测试调用现有 `runMaintenance` 和 `preStep` 等待点。8.3 修剪专项、8.4 的生产 fork 和稳定切点及广泛恢复联验、8.6 超限重试、8.11 压力策略和 8.12 `/compact` 生产接线各由原任务交付。D 负责生产命令处理器、异常与取消时尽力写 error done 并传播原异常的 hook，以及正常返回前的 done/flush 和 busy 写入交接。A 的运行中结算返回可靠结果与原错误供 D 消费，启动和在线恢复负责本轮的命令补齐。8.3 整项勾选仍待修剪专项。

## 1. 运行中结算

`@apps/server/src/agent/commit-compaction-summary.ts:25`
`@apps/server/src/agent/compaction-lifecycle.ts:27`
`@apps/server/src/agent/model-turn.ts:112`
`@apps/server/src/model/runtime.ts:168`
`@packages/session/src/session.ts:207`
`@packages/session/src/writer.ts:50`
`@packages/session/src/storage/sqlite-persistence.ts:318`

- [ ] **新增 `settleCompactionSummary`，由占用所有者调用。** 在 `apps/server/src/agent/settle-compaction-summary.ts` 消费真实 `commitCompactionSummary`，维持 B 的结果和关门语义，穷尽处理下表。以区分联合交接 `no-range`、已持久化终态（成功带 `summarySeq`）、已确认无 start 的失败、存储阻塞的未结算结果。确认终态和未结算结果均携带原 attempt（有身份时）及可用原错误。将“无原错误的领域拒绝”和“抛出的值恰为 `undefined`”分开表达。`error` 保留 `Object.is` 同一性，持久化 `reason` 另用安全的 JSON 状态、原因码和文本，避免序列化异常、堆栈、原始 Provider 或 SQLite 内容。收尾写入或核对另失败时，保留首个原错误并单独交接存储故障。先阻止新任务，已有存储门的首个原因也应保持可诊断。

| B 的真实结果 | A 的结算 |
| --- | --- |
| `no-range` 或 start 前的原值拒绝 | 无压缩终态。无范围原样返回。捕获、准备、本地构建、准入或取消的拒绝继续以同一值传播。触发已关闭的存储准入 guard 时先锁存 hook。 |
| `succeeded` | 直接采用 `summarySeq` 与成功 end。不再检查取消、不再次写 end。 |
| `start-not-confirmed / rolled-back` | 保留原错误，返回确认无 start。零摘要调用、零 end。原占用退出前锁存当前 hook，关闭的门留给在线恢复。 |
| `start-not-confirmed / pending-reconciliation` 或 `commit-checkpoint-failed` 的 `side:start` | 原错误与身份交回，门保持关闭。前者有 writer 的待核对记录，后者是普通检查点或暂存侧抛错，无权把它改判为回滚或声称已有待核对槽。恢复时可靠前缀有 start 且无 end 才补 `interrupted/process_interrupted`，缺 start 不补 end。两种均永不再启动摘要 Provider。 |
| `generation-failed`、`acceptance-failed`、`success-commit-failed` | 已确认 start。按实际错误与显式取消证据写一个 `failed` 或 `cancelled` end。`success-commit-failed` 包含成功侧的本地准入、取消及提交前检查。若 gate 已关或暂存仍占位，将同一终态意图交给在线恢复，并锁存当前 Turn。保留原错误。 |
| `model-not-completed` | `finishReason.kind = error` 写 `failed` 并保留原结构化失败，`aborted` 写 `cancelled` 并保留原 finish 结论及可归因的取消原因。 |
| `rejected`、`selection-changed` | `failed`，分别保留 B 的拒绝值或前缀变更原因。只落终态，保留原 surface、历史和已提交效果。 |
| `success-not-confirmed / rolled-back` | 已确认 start，仍在原占用中走下述单 ID 核对与结算。无已有 end 时写 `failed`，沿用存储原错误。 |
| `success-not-confirmed / pending-reconciliation` 或 `commit-checkpoint-failed` 的 `side:success` | 已确认 start，存储门保持关闭。在线恢复等事务终止并采用可靠前缀。已有 end 优先，否则用本进程保留的失败意图写一次 end。普通检查点抛错也保留其原错误和 side，先完成普通缓冲恢复。 |

- [ ] **在观测点保留终态和取消证据。** `runCompactionAttempt` 在收到 `finish(error/aborted)` 时先保存终态，再退出迭代并等待清理。清理期间的 abort 或清理异常不能覆盖已观察的结论。`runtime.ts` 的 Adapter 归一化也在清理后按当前 signal 生成 finish，真实 Adapter 可能在到达压缩层前就丢失结论。使用仅摘要调用启用的窄选项，在该层同样保存已观察的 `error/aborted` 并仍等清理完成后交付一个 finish。保留业务生成现有默认行为。对尚未观察到失败终态的正常输出，仍允许取消在成功批次提交前生效。

  在确认 start 后的生成前检查、流退出后尚无确定失败终态的取消检查、成功批次构建及 `beforeSubmit` 检查处，当场记录实际触发的本地取消或准入 guard，并通过结果携带分类与原值。摘要专用运行时路径也以执行取消检查的时点为证据，避免普通生成异常在清理后才按 signal 改判。显式模型 `aborted`、生成侧明确的 `AbortError` 或 `LlmError("ABORTED")` 也可作为取消证据。保留结构化模型终态及当时可归因的取消原因，包括任意非 `Error` 值。返回时的 `signal.aborted` 或原值恰与 `signal.reason` 相同都不能作为证据。端口接收后，由原存储结果决定结局，已持久化成功优先于迟到取消。确需修改 `compaction-lifecycle.ts`、`commit-compaction-summary.ts` 及其测试时，只在 A 8.3 工作树的副本修改证据交接和相关断言。保留已审查 B 源工作树、摘要请求与选区契约。

- [ ] **统一所有延后结算的写入与阻塞交接。** 失败/取消 end 只含原 `compactionId`、`turn`、可选 `sourceCommandId`、状态和安全原因，采用取消信号不参与的独立 log-only 暂存批次。使用 `commitCompactionBatch` 的提交前准入复查。只有仍持有原占用且 end 已获确认，才交回已结算结果。遇到关闭的 gate、不可用的 start、归属冲突、未核对的暂存、失效的活动内权限，或收尾检查点、端口回滚、未知或抛错而延后结算时，交接前同步调用该次上下文的 `blockStorage`。即使外部门已经关闭，也必须调用 `StepHookContext.blockStorage` 锁存当前 Turn。首次锁存后重复调用对本轮幂等，保留首次 hook 原因和已关闭外部门的首个原因，也保留 primary 原值与单独的存储故障。沿用 `model-turn.ts` 的 `blockHookStorage`，由它在外部门已关时只记录当前 hook 的故障，无需重复调用外层 setter 或推进代数。即使 hook 捕获并返回或同一 hook 中普通排空成功，驱动仍须在开 Step 前停下，拒绝尝试任何 `step/end` 或 `turn/end` 写入，实际范围留给恢复关闭。

- [ ] **解决 B 关门与原占用结算的冲突。** B 对显式 `rolled-back` 也同步 `blockStorage`。`commitCompactionBatch` 会在入口及普通检查点后拒绝关闭的门，`recoverStorage()` 又只接受 idle。直接把现有 recovery 放进 maintenance 会拒绝，替换 `storageOpen` 为常量会失去安全边界。建议保留 B 合同，在 `react-agent.ts` 提供仅供这一调用持有的内部能力。`runMaintenance` 将能力作为第二参数交付，真实 `RunTurn` 通过 `ModelTurnContext` 传给现有 `StepHookContext`。允许旧的直接 driver 调用继续省略能力。没有此能力的调用不得执行关门中的写入。其职责仅为以下三步。

  1. 记录原占用的信号身份以及本次 B 同步关闭的存储故障代数。包装 `blockStorage` 立即交给 hook 锁存。在维护路径只在门开放时委托给 Agent 关门，已有阻塞原因留在 Agent，避免同一交接重报推进代数。独立存储故障仍按现有 Agent 路径推进代数。只有包装调用亲自看到从开放变关闭、且结果为 `success-not-confirmed / rolled-back` 时可申请活动内结算。如果另一个故障先关门、代数变更、占用归属改变、已开始关闭或仍有未知暂存，交给 idle 恢复。管理器在等活动退出期间也不能发起新任务。
  2. 在原占用和关闭的 gate 下调用 `session.flush()`，再用所有者的写 handle 严格 `read()`，校验可靠持久前缀与当前 live 逐条相等。检查原 start 的完整身份与现有 end，已有 end 取其可靠结局。自己的原暂存已确认回滚且 start 存在、end 缺失时，才提交单条失败 end。冻结本次许可，只允许该 end，调用 `Session.commitStaged` 并在 build 和 `beforeSubmit` 处重新检查占用、代数、原身份及序号。该单条提交仍由原 SessionWriter 串行，失败即停止。此内部权限不给任意回调、Provider、普通 append 或第二次摘要使用。
  3. 确认 end 后返回持久失败，原占用方可退出。闭门及 hook 的首次故障记录继续有效，直到 idle `recoverStorage()` 核验、修复、检查点成功并校验代数。待核对的 start、成功批次或 end 必须走 idle 恢复。活动退出交接为 `idle + storageBlocked`，外部取得不了执行权。健康的领域失败、内容拒绝或取消可在原占用完成 end，Turn 是否继续由现有驱动及调用方决定。

  *审查取舍*。备选是一处经 B 认可的窄契约调整，让显式确认回滚继续保持已开放的 gate，再走普通 end 暂存。它会改变已审查 B 的结果交接和当前 hook 观察语义。仅将确认回滚交给 idle 恢复会让正常具备存储能力的维护在 end 确认前退出。建议采用上述窄权限。假定 B 的关门语义继续作为公开交接，已确认的存储回滚结束当前 Turn 的继续执行，遗留 Turn 由在线恢复关闭。若产品要求该 Turn 在确认回滚后立即继续业务，需共同审查 B 的显式回滚分类和现有 hook 的黏性阻塞。禁止简单清除存储门或 `hookStorageFailure`。

- [ ] **保存待结算意图与唯一终态。** 在实际 Agent 的进程内为当前会话保存按 `compactionId` 索引的结构化意图（完整 attempt、阶段、预期 `failed`/`cancelled` end、内存原错误）。首次故障已同步关门，交接在释放占用前完成。只登记确实有已知 end 意图的分支。仍未知或修复提交失败保留意图，已核验完成后删除。发现已有持久 end 优先采用，绝不补写或再次执行摘要。启动/重新打开不假造已丢失的进程内错误。单次占用、暂存位置和全前缀检查共同约束唯一性。B 的手动固定 ID 进入 A 前同步防复用（包括已在日志里的继承记录）。加入 Session 新终态接受边界的重复 end 校验，普通追加与暂存同规则，优先利用既有接受入口。恢复发现与本次 ID/归属有冲突的旧日志时维持阻塞。兼容不含 `sourceCommandId` 的旧记录与已有孤立终态，保留旧日志重放，勿借此改造全局生命周期 Schema 或 fork 校验。

- [ ] **RED → GREEN。** 在 `apps/server/src/agent/settle-compaction-summary.test.ts` 驱动真实 B 服务，参考 `commit-compaction-summary.test.ts` 的固定路由、事件前缀和流夹具，配实际 `SessionWriter` 的可控端口。在 `apps/server/src/agent/model-turn.test.ts` 使用真实 `ReActAgent` 与 `createModelTurnDriver({ preStep })`。切片在启动和在线修复代码加入前即可运行。先写以下可观察的失败断言。

  - 无范围、start 前抛错/取消，start 确认回滚，以及 start 确认但在生成前取消。分别断言无 start/无 end、零模型，和有 start/单个 `cancelled` end、零模型。测试异常对象以及 `throw undefined` 的精确身份，区分检查点异常与未触发端口的提交前取消。
  - 分别让生成层抛原错误、发 `finish(error/aborted)`、截断或返回空摘要。用接受阶段权重函数异常和生成暂停期间的合法中间节点变更覆盖接受抛错与选区冲突。普通失败一次 end、原身份、无替换。此前已提交的成功摘要由一次真实成功建立，比较完整前缀和替换代数。
  - **清理闩锁 RED。** Adapter 先 yield 带固定 failure 的 `finish(error)`，进 `finally` 后用 `entered/release` 闩锁暂停。等 `entered` 后用异于原错误的自定义值 abort，再释放清理。经真实 `LlmRuntime` 验证清理完成后只交付原结构化终态，A 仅写一个 `failed` end，保留该 failure，零替换。以 `finish(aborted)` 对照，保留已观察到的取消结论和当时可用的原因。用直接注入的 `PreparedModel` 流复跑同一时序，覆盖生命周期自己的迭代关闭，另使 cleanup 抛异于终态的错误。显式本地 guard 对照在生成前或成功端口调用前触发自定义取消值，断言原值身份和 `cancelled` end；普通错误后迟到 abort 仍为失败。
  - **外部门先关 RED。** pre-step 摘要确认 start 后在生成/成功提交前暂停，通过外层 `agent.blockStorage(firstError)` 模拟另一来源关门，此时当前 hook 尚未收到 `blockStorage`。释放后由测试 hook 捕获或接收延后结果并返回。用真正的业务 Adapter 计数和 Session append 调用记录，断言业务 Adapter 为零、未尝试写 `step/start`、`step/end`、`turn/end`，无候选替换，原 Turn 留待恢复。可在 hook 返回前完成普通 `session.flush()` 再验证锁存。重复阻塞保持首个 hook 原因，随后新编号返回原外层故障作为 cause。对照待核对未解/已普通排空，以及健康成功或领域失败的持久结算先于业务调用。业务检查点故障时 Adapter 为零。
  - 在成功批次交给端口前后分别取消。前者验证给取消 end 且成功端口零调用，后者按 committed、rolled-back、pending 三种结果验证成功优先或原存储错误保留。用已接收但暂未兑现的 end 端口挂住维护/Turn，确认新 prompt/maintenance 为 busy、旧 requestId 确认、读取可用、`recoverStorage` 拒绝活动期调用。释放后核对 SQLite 终态先于健康占用退出。成功/失败各一次结束。尝试用同 ID 再进结算不能写第二个 end。
  - 在唯一 end 的 checkpoint、端口抛错、显式回滚和 pending 注入故障。验证 primary 与 settlement 故障分开、idle 仍关门、未知时无普通补写，并把同一意图留给第 3 节验证。注入不同故障代数或故障发生时并发 `beginStop()`，确认活动内权限失效。由测试调用方拟态 D 读取交接结果，记录 `Object.is` 原异常。生产 error done hook 由 D 使用同样的双故障场景验收。

## 2. 启动与恢复投影

`@apps/server/src/agent/manager.ts:128`
`@apps/server/src/app.ts:224`
`@packages/session/src/recovery.ts:14`

- [ ] **复用 `packages/session/src/recovery.ts` 的修复投影。** 保留 `projectInterruptedSession` 与 `recoverInterruptedSession` 的分工。读取和校验 restore seed、继承计数和原始前缀，再以同一份按序扫描验证压缩及命令关联。完整校验后，依次生成缺漏的压缩 end、所有本会话自有的未闭合命令 done、既有未结算工具结果及实际打开的 Step/Turn 结束。已有 end 和 done 原样保留。`turn:null` 与实际 Turn 均取自 start，恢复发生在 pre-step 时不补造 Step。8.4 复用此扫描完成广泛的遗留范围、已修剪历史、稳定尾部、fork/reopen 与三入口交叉联验。

  - 以 `compactionId`、`turn`、可选 `sourceCommandId` 的完整身份匹配唯一 start/end，要求 start 在 end 之前。待核对 start 后来确实提交且没有 end，或冷启动时只见自有 start，补 `interrupted` 并以 JSON reason 保存 `process_interrupted`。在线读到原成功批次或原 end 已提交时采用现存结果。确认缺 end 后才可应用同身份的进程内意图。父前缀中未闭合的记录原样保留。未关联命令的旧压缩或孤立终态继续重放，不能成为命令结算证据。
  - 对每个缺 done 的自有命令，验证全前缀中该 `commandId` 只有一个 run 且 `run.seq >= inheritedEventCount`。用唯一自有的关联 start 锚定尝试，要求 `run.seq < start.seq < end.seq < done.seq`。start/end 的 `sourceCommandId` 等于该 run 的 `commandId`，两者的 `compactionId` 和 `turn` 完全一致。扫描全部相关记录，允许不同命令交错。成功还须有唯一的持久 summary，其 `compactionId`、`sourceCommandId` 均匹配，满足 `start.seq < summary.seq < end.seq`；summary 无 `turn` 字段，由匹配的 start/end 定位。以该 summary 的 seq 作为 `sourceEventSeq`。可靠的 `failed` 或 `cancelled` 分别补对应语义的安全 error done，无成功引用。已有或修复产生的 `interrupted` 补中断 error done。已有 done 原样保留。即使继承 run 之后出现子会话自己的压缩记录，也绝不为该继承 run 补 done。
  - 可靠前缀里干净的 run-only，或唯一匹配的自有 start 未结算，按中断事实修复。出现关联证据却不能证明唯一合法链时，视为前缀完整性故障。包括同一命令的竞争尝试（即使其中只有一个已有 end）、重复 run/start/end、逆序 start/end/summary、关联 end/summary 找不到匹配 start、身份或 Turn 冲突、成功的 summary 缺失或不唯一。投影报出命令和压缩身份及相关 seq，整批停止，禁止选择第一条或最后一条、猜测成功引用或把有冲突的证据降级成 run-only。启动拒绝 ready/load，在线保持关门，均无修复写入或 Adapter。区分确实缺少结局的可靠历史与无法可靠解释关联的前缀。
  - 启动复用 `apps/server/src/app.ts` 的 `onReady` 临时 write handle 和 `apps/server/src/agent/manager.ts` 的 `AgentManager.#load` 持写恢复。沿用未绑定 handle 的一次原子 `append`、严格读取及关闭。恢复失败时 app 未 ready 或 manager 不发布 Agent。关闭重开时只见 start 且缺 end，按 `interrupted/process_interrupted` 修复；若收尾或成功批次已持久化，就保留其结局。只读投影保留真实游标，不写入或开放任务。

- [ ] **RED → GREEN。** 在 `packages/session/src/recovery.test.ts` 写只读投影和持写修复断言，原样导入 `packages/session/src/compaction-recovery-fixtures.ts` 的 I、P、S、K 三态、G 和 O。K 成功引用 `sourceEventSeq: 9`，失败/取消给对应文本且无引用。O 仅补自有命令，保留继承 G1、G2 done 和种子，根 G 则给 G1 补一次。I 先 end 后 done，P 先 end 再关闭 Turn、零 Step，S 保留第一次成功的 summary/checkpoint、原 surface 和替换代数。断言原前缀逐条保留、只读游标不前移、重复恢复零增量。测试内构造反例覆盖错序 run/start、end 在 start 前、summary 在 start 前或 end 后、缺失或重复 summary、错 ID/Turn、关联孤立 end、竞争 start 及重复 run/end。两种恢复入口都须拒绝且持久前缀不变。加入合法交错命令和继承 run 带后续关联记录的对照。R 及 `crossTurnBusy` 的修剪/稳定切点专项留后续。
  - 在 `apps/server/src/event-session-app.test.ts` 预写 SQLite 后调用 `createEventSessionApp` 和 `app.ready()`，验证启动修复、零 Agent 启动或 `RunTurn`、重开幂等。在 `apps/server/src/agent/manager.test.ts` 走真实 `AgentManager.load`，确认修复持久化早于 `onLoaded`。用歧义前缀验证拒绝，再定向注入修复 `append` 异常验证原错传播及写入权释放。可靠前缀上的健康重试只修复一次。此切片用预写历史，独立于运行中结算和在线恢复改动。

## 3. 在线修复

`@apps/server/src/agent/react-agent.ts:67`
`@packages/session/src/session.ts:269`

- [ ] **真实 `ReActAgent.recoverStorage()` 顺序。** 在 `apps/server/src/agent/react-agent.ts` 保留 idle/closing 守卫、并发合并和 `#storageGeneration`。先 `session.flush()`，由 `packages/session/src/writer.ts` 的 `SessionWriter.#checkpoint` 先终止并核对暂存事务。已提交安装和发布整个批次一次，回滚释放占位，仍未知则拒绝。随后用严格读取逐条比较 live 与持久前缀，再使用第 2 节投影。可给 `projectInterruptedSession` 增加窄的在线选项，在同一次可靠读取中比较预期前缀并采用已知的终态意图。含压缩或命令修复时用受保护的 `Session.commitStaged` 原子提交整段修复，串行校验故障代数和序号，确认前 end/done 不进入 live。只有既有工具/Turn 修复时沿用 append/flush。恢复重试先核对原修复批次，再从可靠日志计算缺漏。最后 `session.flush()` 和严格前缀检查通过、代数未变且未关闭才清理对应意图、开门。沿用草稿 `abandoned` 清理，恢复不运行 Adapter 或工具。

- [ ] **共用 SQLite 故障注入。** 新增测试辅助 `apps/server/src/session/compaction-settlement-sqlite-fixture.ts`，供本节和第 4 节使用。沿用 `apps/server/src/session/compaction-summary-acceptance.test.ts` 的事务内识别方法，限定目标库写连接、会话、压缩 ID、批次类型和连续序号，再拦一次 `COMMIT`。成功批次同时核查 summary/checkpoint/end 及来源序号，终态批次单独识别 log-only end。保留独立 read handle、目标提交与核对计数、live 通知和可释放闩锁。可切换以下两种故障并保持任一种未解，用同一注入器覆盖 start、完整成功批次及终态。

  - **已提交但返回未知。** 先执行真实 `COMMIT`，再抛原错误并暂阻目标连接的核对读取（`SELECT header_json, inherited_count, event_count …`）。独立读者可见全批，live 未安装。放行读取后可确认提交。
  - **未提交但返回未知。** 在目标 `COMMIT` 前抛原错误，初次暂阻 `ROLLBACK`，原事务仍可能提交。保持故障时计数验证未在事务结束前读取核对结果；放行后由原连接真实回滚并可靠确认。独立读取的暂不可见不能证明回滚。测试结束恢复 mock、闩锁、连接和临时目录。

- [ ] **RED → GREEN。** 在 `apps/server/src/session/compaction-settlement-recovery.test.ts` 通过真实 `AgentManager`、Agent、已绑定 writer 和 SQLite 验证，先持久化自有 `command/run` 或受理前缀。每个测试自行建立前缀和目标故障。用实际行为断言，比对独立持久读取、live 游标及通知、surface 与替换代数。

  - **start 与成功批次。** 覆盖两个目标的已提交、确认回滚和仍未知。start 已提交时安装一次，零摘要调用，补 interrupted end 后再补自有 done。start 回滚时无 start/end、零模型，只按可靠 run-only 补中断 done。成功批次已提交时在真实 `COMMIT` 后触发取消，核对仍先安装一次再比前缀，采用原成功 end 和原 summary 引用。成功批次回滚时以原 ID 和存储错误结算失败，零候选替换和重提。仍未知时零补写、零候选发布、零依赖 Adapter，新 prompt 和维护仍阻塞。
  - **失败/取消 end 已提交但未知。** 让真实摘要失败或在提交前取消，造成原 log-only end 已物理提交、live 仍待核对。门关闭且持久/live 均零 done。放行后验证只安装并采用原 seq、状态和原因一次，随后只补一个语义匹配的自有 error done。原 end 提交命中仅一次，重复 recover 无新增 end、done、发布或模型调用。
  - **失败/取消 end 回滚但未知。** 尚不可核对时零持久/live end 或 done。确认回滚后以同一 attempt 和进程内原意图修复一次，包括状态、原因及内存原错误身份，依次确认 end/done；零替换，普通排空零重提。分别用失败和取消意图验证两条链路合计覆盖两种结局。重复 recover 零新增或重复发布。可在已修复但最后检查点失败时再试，仍采用已有 end/done。
  - **普通排空后的恢复。** 用普通 `session.flush()` 先核对已提交成功批次，用绑定的 `handle.flush()` 先核对已回滚的终态批次。两者排空后 gate 仍关、零 done。再调 `recoverStorage()`，分别采用原成功 end 或以保留的原意图补一次 end，最后各补一次自有 done。
  - **开门条件。** 在实际 handle 可靠 `read()` 前用闩锁验证并发共享同一 Promise、新 prompt/维护被拒。分别验证持久读取失败、live 与持久前缀不一致、第 2 节的歧义命令链均零修复并保持阻塞。单独阻断最后修复检查点，验证开门严格晚于核验成功。用真实 pre-step 外部门先关的交接样本，确认恢复才关闭实际 Turn，一条 `turn/end`、零 Step，且恢复之前和期间业务 Adapter 为零。

## 4. 普通排空与关闭

- [ ] **按入口覆盖代表性三态。** 在 `apps/server/src/session/compaction-settlement-drain.test.ts` 复用第 3 节注入器。辅助代码仅依赖既有 SQLite、Agent/SessionWriter 入口，可随任一切片先加入。用既有 `commitCompactionSummary` 生成 start/成功候选，用 `commitCompactionBatch` 提交已确认 start 的单条终态。每次首次排空或关闭创建独立故障样本，本节的断言在既有写入和关闭入口即可运行。复跑 `apps/server/src/session/staged-commit-admission.test.ts`、`apps/server/src/session/session-writer.test.ts` 和 `packages/session/src/storage/sqlite-persistence.test.ts` 的既有绑定与核对回归。共享检查点用这些用例覆盖，以下样本验证真实调用边界。

  | 入口 | 代表样本及断言 |
  | --- | --- |
  | `agent.session.flush()` | 成功批次已提交但未知。放行后安装并发布一次，重复 flush 无新序号或代数，gate 仍关，零 done。 |
  | 绑定的 `handle.flush()` | 终态批次回滚但未知。核对后释放暂存，持久/live 都无该 end 或 done，gate 仍关，原批次零重提。 |
  | `store.flush()` | start 仍未知时拒绝，零补写或模型，继续阻塞。放行确认回滚后可排空，原 start 从未重提，gate 仍关。 |
  | `AgentManager.close()` | 成功批次已提交但未知，首轮核对在关闭中发生。关闭只排空，零 done 或重激活。重新取得写入权并直接读日志，保留原成功批次一次。用另一个持续未知样本验证关闭报告原错误层次、释放写入权；用新的存储实例重开读取可靠历史。重开时的 done 由第 2 节测试验证。 |
  | `SessionWriter.close()`、`handle.close()`、`store.close()` | 在 `apps/server/src/session/session-writer.test.ts` 与 `packages/session/src/storage/sqlite-persistence.test.ts` 分别复用或补充共享检查点覆盖。writer 用确认回滚，handle 用持续未知，store 用已提交或回滚，断言一次核对、零重提，按各自关闭契约报告与释放。 |

  另在 `apps/server/src/session/session-writer.test.ts` 保留实际 SQLite 普通缓冲回滚对照。普通 `Session.append` 已通知后，首次 flush 报原错误，第二次精确重试原 seq 和载荷并按序提交下一批，通知只发一次。运行 `packages/session/src/storage/sqlite-persistence.test.ts` 的 1.7 准备句柄首批回滚和显式重试用例。第 3 节锁定真实 Agent 行为 RED，本节可独立复验现有排空与关闭契约。

## 5. 实施后的验证与交付检查

- [ ] 第 1 节与第 2 节可分别开发和运行，第 3 节接合两者，第 4 节可用既有暂存入口先复验排空，完成后再验证与在线修复的交接。每个新增行为先有可执行 RED，再实现最小改动并跑 GREEN。RED 断言可观察行为缺失。记录失败断言、GREEN 和任何无法复验的路径。
- [ ] 从目标工作树根用 `pwsh.exe` 运行对应切片命令。新增路径与上文一致，各自完成后可独立执行。

```powershell
# 1. 运行中结算
pnpm --filter @mharness/server exec node --import tsx --test src/agent/settle-compaction-summary.test.ts src/agent/commit-compaction-summary.test.ts src/agent/compaction-lifecycle.test.ts src/agent/model-turn.test.ts src/model/runtime.test.ts src/session/compaction-summary-acceptance.test.ts
# 2. 启动与恢复投影
pnpm --filter @mharness/server exec node --import tsx --test ../../packages/session/src/recovery.test.ts ../../packages/session/src/compaction-recovery-fixtures.test.ts src/event-session-app.test.ts src/agent/manager.test.ts
# 3. 在线修复
pnpm --filter @mharness/server exec node --import tsx --test src/session/compaction-settlement-recovery.test.ts
# 4. 普通排空与关闭
pnpm --filter @mharness/server exec node --import tsx --test src/session/compaction-settlement-drain.test.ts src/session/staged-commit-admission.test.ts src/session/session-staged-commit.test.ts src/session/session-writer.test.ts ../../packages/session/src/storage/sqlite-persistence.test.ts
# 基础阶段整体验证
pnpm --filter @mharness/server test
pnpm typecheck
git diff --check
```

- [ ] 对照本次修改的声明检查中文 JSDoc（行为、错误身份、取消与时序、占用归属、恢复失败契约），使用 UTF-8，TypeScript 不使用 `any`。审查工作树基线 diff，确认夹具、B 的提交边界、事件 Schema、OpenSpec、生产入口和分支范围与已授权边界一致。独立计划审查使用当前计划路径、基线与草稿 hash。实施须另获授权，本轮只修改计划。
