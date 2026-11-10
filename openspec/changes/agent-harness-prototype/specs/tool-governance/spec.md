# Spec Delta

## Purpose

为通用 Agent 工具调用定义可信的能力声明、审批与操作标识合约，使执行前的用户确认和执行后的不确定结果具有一致语义，并通过工具端去重避免相同操作被重复应用。

## ADDED Requirements

### Requirement: 串行批次与配对结果记录
系统 SHALL 将已提交 assistant 消息中的完整调用按模型顺序串行调度，并为调用保存调度记录与匹配结果。调度记录 SHALL 只表示进入调度，可早于审批，不证明正文已经执行。取消、派发异常或结果未知 SHALL 停止后续派发；成功结果的批次结束意向 SHALL 不提前跳过剩余调用。工具执行与审批 SHALL 不自行推进下一模型步。

同一 Session 内的调用键为 `(turnId, stepId, callId)`。`tool/call.data` SHALL 保存调用键，工具名和原始参数由同一 Step 中正式 assistant 消息的匹配调用取得。调度记录可早于参数校验，此时可尚无 `operationId`。每个已提交的调用 SHALL 最终有一个按该键配对的 `tool/result`。

#### Scenario: 调用正在等待审批
- **WHEN** 调用已进入调度但审批仍未决定
- **THEN** 可以观察到调度记录，但工具效果次数为零，不将其显示或解释为正文已执行

#### Scenario: 后续调用尚未派发
- **WHEN** 前序调用因取消或结果未知触发中止
- **THEN** 不派发后续调用，并为已提交但未执行的调用保存配对结局，结果按模型顺序记录

### Requirement: 工具能力声明与参数校验
工具 SHALL 声明输入 Schema、副作用类型、幂等支持、结果查询能力、审批策略和超时时间。未声明的副作用类型 SHALL 按未知处理。Harness SHALL 从工具注册信息取得策略，不允许模型覆盖。Harness SHALL 在审批与派发前解析并校验模型参数，不隐式转换类型。本地工具的对象默认拒绝未知字段，外部 MCP 工具按远端声明的输入 Schema 校验。

#### Scenario: 能力未知
- **WHEN** 工具未声明副作用类型且没有显式审批覆盖
- **THEN** 系统按未知类型处理并要求审批

#### Scenario: JSON 无法解析或参数无效
- **WHEN** 模型生成的 arguments 不是有效 JSON，或解析后不符合工具输入 Schema
- **THEN** 系统不创建审批、不执行工具，为原 callId 保存可区分解析或校验失败的结构化工具错误，供模型在后续请求中修正参数

#### Scenario: 本地工具收到未知字段或错误类型
- **WHEN** 模型为严格对象传入未声明字段，或传入可转换但与声明类型不同的值
- **THEN** 系统拒绝参数，既不丢弃字段也不自动转换类型

#### Scenario: 外部 MCP 工具定义自己的输入规则
- **WHEN** Harness 接入外部 MCP 工具
- **THEN** 模型看到远端输入 Schema 中可由模型提供的字段，Harness 派发前按远端 Schema 校验完整参数，远端执行入口独立校验收到的参数

### Requirement: 工具结果契约校验
系统 SHALL 在保存工具结果前校验其协议结构和已声明的输出 Schema。无输出 Schema 时仍 SHALL 校验协议结构。结果无效时 SHALL 为原调用保存契约错误，且不得将其视为工具确认未执行或有效成功。

#### Scenario: MCP 成功结果不符合声明的输出 Schema
- **WHEN** MCP 工具声明输出 Schema，但返回的结构化结果缺失或不符合该 Schema
- **THEN** 系统保存该调用的结果契约错误，不把无效数据作为成功结果交给模型

### Requirement: 成功值与展示内容的单向派生
自有结构化工具 SHALL 先返回并校验成功 value，再从已验证参数和值派生模型 content 及可选 presentationMeta，不接受相互独立的两份成功事实。外部 MCP SHALL 允许 content-only 成功，有结构化结果时保留并按已声明的输出 Schema 校验，不将文本伪装为业务值。只有成功结果 SHALL 能携带 concludeTurn。

#### Scenario: 自有工具返回无效值
- **WHEN** 成功候选 value 不符合输出 Schema
- **THEN** 不调用成功渲染、不发布成功结果，记录契约错误；不能据此认定工具没有产生效果

#### Scenario: 只有内容的 MCP 成功
- **WHEN** 外部 MCP 返回有效成功 content，未声明输出 Schema，也没有结构化结果
- **THEN** 接受 content-only 成功，不要求或伪造 value

#### Scenario: 成功渲染失败
- **WHEN** 值已校验但模型 content 或展示元数据派生失败
- **THEN** 保存可区分的契约或渲染错误，不把原值伪装为已成功发布的结果，也不推断副作用已撤销

#### Scenario: 非成功结果携带结束意向
- **WHEN** 错误、超时、取消或未知候选结果携带 concludeTurn
- **THEN** 不据此产生成功的批次结束意向，该结局按其错误或中止规则处理

### Requirement: 统一结局与模型可见内容
系统 SHALL 区分成功、工具错误、超时、取消及结果未知，并分别保存原因与可确认的执行事实。所有结局 SHALL 有与事实一致的模型 content，错误另有结构化 error。timeout 或 cancelled SHALL 能作为 unknown 的原因，不能仅据原因推断未执行。最终 content SHALL 随结局持久化，重放不重新生成；展示元数据 SHALL 不自动进入模型上下文。

#### Scenario: 工具业务失败
- **WHEN** 工具返回可确认的业务错误
- **THEN** 保存结构化错误及模型可见错误 content，不同时发布成功值或成功结束意向，不把失败视为无副作用证明

#### Scenario: 远程写操作超时
- **WHEN** 远程副作用调用已发出，等待超时且无最终结果确认
- **THEN** 保存 unknown、timeout 原因、可确认的派发事实及准确 content，不只记录一个丢失未知语义的超时标签

#### Scenario: 重放未知结局
- **WHEN** 历史重建遇到已保存的 unknown 结果
- **THEN** 使用原有 content 与原调用配对，不重新渲染；此前 Turn 已结束时不为解释错误额外请求模型

### Requirement: 工具结算记录的字段
`tool/result.data` SHALL 包含调用键、`outcome`、`execution` 和 `content`。已有对应操作时 SHALL 保存其 `operationId`。`outcome` 取 `success`、`tool-error`、`timeout`、`cancelled` 或 `unknown`。非成功结局 SHALL 另存 `reason`，`tool-error` SHALL 另存结构化 `error`。`success` 可带 `presentationMeta` 和 `concludeTurn`，自有结构化工具的成功结果 SHALL 保存已验证的 `value`。

`execution.dispatch` SHALL 取 `not_started`、`dispatched` 或 `unknown`。只有存在相应证据时 SHALL 写入 `stopConfirmed: true` 或 `resultConfirmed: true`，分别表示执行端停止或最终结果获得确认。

#### Scenario: 参数校验失败时尚无操作标识
- **WHEN** 进入调度后参数校验失败，尚未生成操作
- **THEN** 按原调用键保存 `tool-error`、可区分校验失败的原因、错误与模型内容，记录 `execution.dispatch: not_started` 并省略 `operationId`

### Requirement: 审批绑定确切操作
参数通过校验后 SHALL 写入 `tool/operation`，保存调用键、`operationId`、`toolName`、`toolVersion` 与不可变的 `validatedArgs`。免审批的操作也 SHALL 写入此事件。审批 SHALL 绑定该操作的工具身份、定义版本和参数，执行时 SHALL 使用同一份绑定。

#### Scenario: 用户同意
- **WHEN** 用户批准仍有效的待审批操作
- **THEN** 系统仅执行该操作绑定的工具及参数，重复同意不重复调度

#### Scenario: 参数或工具定义变化
- **WHEN** 待执行操作的参数或工具定义与已批准内容不同
- **THEN** 原审批不适用，新操作使用新的标识并重新审批

#### Scenario: 拒绝或已取消后审批
- **WHEN** 用户拒绝审批，或在对应 Turn 已取消后提交同意
- **THEN** 工具不执行，本轮保持或进入相应终态

### Requirement: 工具执行前策略判断
参数校验并写入 `tool/operation` 后，`pre-execute` SHALL 根据可信工具策略返回 `allow`、`deny` 或 `ask`。只读工具 SHALL 默认允许，有副作用及能力未知的工具 SHALL 默认请求审批，工具配置可显式覆盖。`allow` 进入执行前检查点，`deny` 保存配对的拒绝结果，`ask` 进入审批流程。该判断由普通服务调用提供。

#### Scenario: 策略直接允许或拒绝
- **WHEN** `pre-execute` 返回 `allow` 或 `deny`
- **THEN** 两种情况均不请求审批。允许仍需通过执行前检查点及取消检查，拒绝保存原调用的结果且工具正文调用次数为零

### Requirement: 请求审批与持久化决定
当策略返回 `ask`，系统 SHALL 确认 `tool/operation` 和 `approval/asked` 已提交，再通过普通服务调用 `approval/request` 向审批渠道发起请求并等待答复。等待 SHALL 释放 Session 串行区，Turn 保持活动。系统 SHALL 提交 `approval/decided` 后才按决定继续。仅 `allowed-once` 可以进入执行前检查点，其余结局 SHALL 保存配对的错误或取消结果。用户明确拒绝 SHALL 结束本轮。

`approval/asked.data` SHALL 保存 `id`、`operationId`、`toolName`、`reason`，以及可用时的 `callId`。`approval/decided.data` SHALL 保存同一 `id`、`outcome` 和适用时的 `reason`。`outcome` 取 `allowed-once`、`rejected`、`cancelled` 或 `unavailable`。同一会话中每个审批 `id` 最多提交一个决定。

#### Scenario: 审批记录写入失败
- **WHEN** `approval/asked` 或 `approval/decided` 未通过持久化检查点
- **THEN** 前者不发起审批交互，后者不进入工具派发，两者的工具正文调用次数均为零

#### Scenario: 无可用审批渠道
- **WHEN** 持久化审批请求后发现没有可用审批渠道
- **THEN** 提交 `approval/decided`，其 `outcome` 为 `unavailable`，保存配对的工具错误且不执行工具

#### Scenario: 重复或迟到的答复
- **WHEN** 对已有持久化决定的审批再次提交答复
- **THEN** 保留该审批原决定，工具正文不会因重复答复再次执行

### Requirement: 工具执行前持久化检查点
系统 SHALL 在工具正文执行前确认对应 assistant 调用、操作信息及调度调用记录已持久化。需审批时还 SHALL 确认对应的 `approval/decided` 已持久化且为 `allowed-once`。检查点失败 SHALL 阻止工具执行。检查点完成后 SHALL 再次检查取消，再通过原子状态门进入派发。

#### Scenario: 调度调用记录无法落盘
- **WHEN** 调度调用已被内存接受，但持久化确认失败
- **THEN** 工具效果次数为零，不报告工具已执行，不把内存记录当作外部效果的证据

#### Scenario: 等待检查点时取消
- **WHEN** 等待工具执行前检查点期间用户取消，检查点随后成功
- **THEN** 工具仍不执行，系统保存对应调用的未执行取消结果；若在结果保存前崩溃，恢复根据持久调度记录保守结算为未知

### Requirement: 按工具调用结算取消
系统 SHALL 原子协调取消与工具派发。取消成功阻止派发时，系统 SHALL 按原调用标识保存结构化结果 `outcome: cancelled`、`execution.dispatch: not_started`。调用已发出时 SHALL 发送取消请求并按已确认结果结算，无法确认结果时记为 unknown。多个调用 SHALL 分别结算，已确认结果保留并与原调用配对。

#### Scenario: 等待审批时用户取消
- **WHEN** 用户取消尚未获得派发资格的工具调用
- **THEN** 工具不执行，持久结果标明「用户取消，工具未执行」，下一轮模型可读取原调用及其取消结果

#### Scenario: 审批通过与取消竞争
- **WHEN** 审批通过与用户取消同时发生
- **THEN** 后端以原子状态转换结果为准。只有取消成功阻止派发才保存确认未执行，即使审批刚通过仍可在派发前取消

#### Scenario: 已派发工具的取消结果未确认
- **WHEN** 用户取消已发出的调用，但工具未确认停止或最终结果
- **THEN** 系统保留已请求取消的事实，工具结算为结果未知，不标记为确认未执行

### Requirement: 稳定操作标识
Harness SHALL 为每个逻辑操作生成并持久化稳定的 operationId，并关联模型 toolCallId。相同操作的重复传输 SHALL 复用原标识；模型重新生成调用 SHALL 不被默认判定为原操作。幂等操作的相同标识 SHALL 绑定相同工具和参数。

#### Scenario: 模型生成新的相似调用
- **WHEN** 模型生成参数相同但无法确认属于原操作的调用
- **THEN** Harness 将其作为新操作处理，不声称已经通过参数相同实现去重

### Requirement: 工具端幂等合约
声明支持幂等的工具 SHALL 持久化操作记录，并原子地协调相同标识的执行；重复请求 SHALL 返回已有状态或结果，不重复产生效果；相同标识绑定不同工具或参数 SHALL 被拒绝。Harness SHALL 不将自身调用日志视为外部工具已具备幂等保证。

#### Scenario: 相同请求并发到达
- **WHEN** 相同 operationId 与相同参数的请求并发到达
- **THEN** 工具最多产生一次效果，其余请求取得已有执行状态或结果

#### Scenario: 已成功但响应丢失
- **WHEN** 工具已保存成功结果但响应丢失，随后通过合约验证再次发送原操作
- **THEN** 返回原成功结果且效果次数仍为一次；该验证不要求 Harness 自动重试

#### Scenario: 同一标识参数冲突
- **WHEN** 相同 operationId 携带不同参数再次请求
- **THEN** 工具返回冲突且不产生第二次效果

### Requirement: 工具批次结束意向
系统 SHALL 在当前 Step 的工具批次结算完毕后汇总成功结果中的 concludeTurn。明确的工具错误 SHALL 作为已知结局保存，已存在的成功结束意向仍然有效。用户取消、派发异常及结果未知等中止条件 SHALL 优先按各自的规则结算。

#### Scenario: 前序工具请求结束且后续工具明确失败
- **WHEN** 同一批次中工具 A 成功返回 concludeTurn=true，随后工具 B 返回明确错误
- **THEN** B 照常执行，A 的成功结果和 B 的错误均保存，Step 将结束意向交给 Turn 驱动，不再请求模型续答

#### Scenario: 请求结束后发生副作用工具超时
- **WHEN** 本批已有成功结果请求结束，但后续副作用工具超时且结果未知
- **THEN** Turn 按工具结果未知结算，不标记为工具批次正常完成

### Requirement: 超时按副作用分类结算
只读工具超时 SHALL 记录 timeout 及模型 content，允许在有限模型步数及只读超时预算内继续。有副作用或能力未知的工具在超时后无法确认最终结果时 SHALL 记 unknown、原因 timeout 并结束本轮，不自动重试、不等待核实、不恢复执行；仅确认停止不能证明此前效果撤销。幂等或结果查询声明 SHALL 不改变此策略。

#### Scenario: 只读调用超时
- **WHEN** 只读工具超时且继续预算尚未耗尽
- **THEN** 模型收到明确超时结果，可选择继续；Harness 不自行重发原调用

#### Scenario: 只读超时预算耗尽
- **WHEN** 本轮只读超时次数达到配置上限
- **THEN** 本轮以明确预算耗尽原因结束，不再调用模型或工具

#### Scenario: 幂等写工具超时
- **WHEN** 声明支持幂等与状态查询的副作用工具超时且最终结果未确认
- **THEN** 调用仍记为 unknown，本轮结束，不查询状态、不自动重试、不继续其他工具

#### Scenario: 超时后迟到结果
- **WHEN** 本轮因副作用工具超时结束后收到迟到响应
- **THEN** 系统不自动恢复本轮，不在第一版将该响应作为核实结果推进后续执行

### Requirement: 执行边界与取消能力分离
工具执行位置与取消后退出保证 SHALL 分别由受信任注册信息提供，模型 SHALL 不可覆盖。MCP 调用 SHALL 默认按远程边界处理，包括 localhost 和本机子进程。只有明确保证取消后等待执行端退出的适配器 SHALL 能采用等待清理策略；本地位置本身 SHALL 不构成此保证。

#### Scenario: 本机 MCP 不保证停止
- **WHEN** 工具通过 localhost 或本机子进程 MCP 调用，适配器未保证取消后退出
- **THEN** 超时按停止等待策略处理，不因本机位置声称已停止或没有副作用

### Requirement: 超时与取消的资源收束
保证协作取消后退出的本地工具 SHALL 在超时或取消时传播信号，等待正文退出与清理再结算。远程或无此保证的工具 SHALL 传播取消并按等待预算停止等待，按已确认事实结算，不声称执行端已停止。确认停止 SHALL 不等同于副作用撤销；迟到回调 SHALL 不改变已结算结果或产生未处理异常。

#### Scenario: 本地工具正在清理
- **WHEN** 支持协作退出的本地工具已收到取消，但清理尚未完成
- **THEN** 系统继续等待，该 Turn 仍活动且拒绝新消息，不提前关闭其运行资源

#### Scenario: 远程取消没有停止确认
- **WHEN** 已派发远程调用收到取消请求，但无法确认停止或最终结果
- **THEN** 记录 unknown、cancelled 原因及模型 content，不标记确认未执行，不自动重试
