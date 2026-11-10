# Spec Delta

## Purpose

为不绑定业务场景的 Agent 提供会话与 Turn 生命周期，使模型调用、工具循环、取消和失败能够形成可追溯的持久记录，并为前端观察及后续模型上下文重建提供可靠依据。

## ADDED Requirements

### Requirement: 业务模块拥有契约
系统 SHALL 由业务或能力所有者维护其数据定义与调用约定，不使用跨业务的中央协议包或全局类型包。Session 模块 SHALL 维护自身 HTTP 请求、响应、公开记录及 SSE 业务帧，并提供独立的浏览器契约入口与服务端入口。具体功能的定义 SHALL 与其职责共置，公共入口可以选择性重导出，不要求集中所有类型声明。

#### Scenario: 前后端使用消息提交契约
- **WHEN** 服务端接收 Session 消息提交，且浏览器构造请求或解析响应
- **THEN** 双方使用 Session 业务模块维护的同一份公开 Schema 与推导类型，不复制字段定义，也不依赖中央协议包

### Requirement: 浏览器契约依赖隔离
浏览器契约入口的完整运行时及类型依赖链 SHALL 不包含 Fastify、SQLite、Node.js 专有资源或服务端实现。包导出、依赖声明与编译配置 SHALL 支持浏览器契约和服务端能力分别消费；仅使用纯类型导入 SHALL 不作为隔离成立的依据。

#### Scenario: 浏览器消费 Session 契约
- **WHEN** 前端通过公开契约入口导入 Schema 或类型并进行类型检查和构建
- **THEN** 契约可被解析和使用，依赖链不要求服务端资源或声明，浏览器产物不引入服务端实现

### Requirement: 内部事件与公开记录的定义归属
Session 核心 SHALL 维护内部持久事件，持久化接口 SHALL 由会话能力定义，SQLite 专有结构 SHALL 留在存储实现。内部事件 SHALL 不从公开记录类型反向推导，Session 核心 SHALL 不依赖其 API 层。公开记录 SHALL 由业务 API 从已提交日志映射产生；稳定且语义一致的数据定义可以复用，不要求机械复制所有字段。

#### Scenario: 内部日志包含非公开请求事件
- **WHEN** Session 保存 `request/header` 或 `request/prepared` 并生成公开历史或 SSE 记录
- **THEN** 内部日志保留这些事件，公开映射按既定可见性与编号规则生成结果，浏览器无需依赖内部事件定义

#### Scenario: 内部实现使用运行资源
- **WHEN** Agent 或存储实现增加取消控制器、数据库连接或实现专有状态
- **THEN** 相关结构由实现所属模块维护，不加入浏览器契约，也不要求前端消费者引用这些运行资源

### Requirement: 不可变追加日志
会话 SHALL 以只追加事件日志为事实来源，元数据与日志分开保存。事件 SHALL 在接受前校验为可无损保存的 JSON 并取得独立不可变快照，拒绝无效事件时不改变日志。事件序号 SHALL 从 0 连续递增，cursor SHALL 表示事件数及下一事件位置。状态与消息视图 SHALL 能从日志重建。

会话元数据 SHALL 包含 `sessionId`、`createdAt`，分支会话另含 `fork`。内部事件 SHALL 包含 `seq`、`type`、`time` 和 `data`，`data` 的结构由 `type` 决定。`createdAt` 与 `time` SHALL 使用非负安全整数表示 Unix 毫秒，`seq` SHALL 为非负安全整数。持久事件以 `(sessionId, seq)` 唯一定位，事件体可由所属日志取得 `sessionId`。

#### Scenario: 调用方修改原始参数
- **WHEN** 调用方在事件被接受后修改传入对象
- **THEN** 日志及后续派生结果保持接受时的值，读取者不能修改已接受事件

#### Scenario: 无效事件被拒绝
- **WHEN** 候选事件包含循环引用或不可无损保存的值，或违反历史替换约定
- **THEN** 系统拒绝事件，不增加序号、不发布该事件，已有视图保持不变

#### Scenario: 按位置读取日志
- **WHEN** 日志有 N 个事件并读取区间 [a, b)
- **THEN** 返回该区间内已有事件的稳定有序快照，序号范围为 0 至 N-1，cursor 为 N，空日志 cursor 为 0

### Requirement: 通知与持久化分离
系统 SHALL 在内存接受事件后向已注册监听器发布同步通知，不依赖监听器返回值决定业务流程。监听器 SHALL 可解除，单个监听器失败 SHALL 被报告且不撤销已接受事件或阻断其他监听器。内存通知 SHALL 不作为持久化成功证据。

#### Scenario: 一个监听器抛出错误
- **WHEN** 已接受事件的一个监听器抛出错误
- **THEN** 其余本次已选定监听器仍收到通知，错误可被观察，日志不回滚

#### Scenario: 解除监听
- **WHEN** 模块解除注册后系统接受后续事件
- **THEN** 已解除的监听器不再接收后续通知

### Requirement: 会话存储访问
系统 SHALL 提供会话创建、打开、元数据查询及列举，并通过每会话访问句柄执行范围读取、连续批次追加、持久化确认和关闭。已提交事件 SHALL 不被改写。读取 SHALL 不倒退，成功接受追加后同后端开始的新读取 SHALL 至少观察到该前缀。关闭 SHALL 幂等，关闭后的操作 SHALL 被拒绝。

#### Scenario: 创建空会话后确认持久化
- **WHEN** 新建空会话完成持久化确认
- **THEN** 其他进程能查询并打开该空会话，其历史为空

#### Scenario: 批次写入失败
- **WHEN** 连续批次在提交前发生错误
- **THEN** 数据库不暴露半个批次，不推进持久游标，后续重试不产生序号缺口或重复事件

#### Scenario: 只读访问与关闭
- **WHEN** 调用方尝试通过只读句柄追加事件，或通过已关闭句柄执行操作
- **THEN** 操作被拒绝；重复关闭不重复释放资源，写句柄关闭完成前处理待持久化记录

### Requirement: 显式持久化检查点
系统 SHALL 区分内存接受与持久化确认。检查点成功 SHALL 保证此前接受的事件已落盘；失败 SHALL 向调用方报告。创建成功响应、模型请求、工具正文执行及结算完成通知 SHALL 等待各自所需记录的检查点成功。已进入内存日志的事件在缓冲写入失败时 SHALL 保序保留。消息接受的暂存批次 SHALL 走独立的原子提交路径。

#### Scenario: 模型请求前检查点失败
- **WHEN** 包含 `request/prepared` 的模型请求日志前缀未通过持久化检查点
- **THEN** Adapter 的模型生成调用次数为 0

#### Scenario: 已接受尾部尚未落盘
- **WHEN** 事件已被内存接受但尚未完成检查点
- **THEN** 系统不将该尾部展示为持久历史，不发布依赖其持久性的完成通知

#### Scenario: 并发排空与关闭
- **WHEN** 后台排空、显式检查点和关闭发生重叠
- **THEN** 同会话写入保持顺序，不重复提交或丢弃批次，关闭处理剩余记录并释放所有权；失败可被调用方观察

#### Scenario: 持久化连接缺失或事件未入队
- **WHEN** 内存接受了事件，但持久化未连接或通知处理失败，持久前缀未覆盖检查点要求的位置
- **THEN** 检查点失败，不能因缓冲为空而返回持久化成功

### Requirement: 会话单写入所有权
系统 SHALL 在写访问生命周期内为会话保持唯一写入所有权，修复历史前 SHALL 先取得该权利。只读访问 SHALL 不争夺写入权。单次数据库事务 SHALL 不被视为生命周期所有权；活跃所有者 SHALL 不因等待超时而被另一运行者夺取，崩溃退出后所有权 SHALL 可重新取得。

#### Scenario: 两个运行者竞争同一会话
- **WHEN** 一个运行者持有写入权，另一个运行者尝试打开会话进行写入或恢复
- **THEN** 第二个运行者被拒绝，原运行者的活动 Turn、审批和记录不变；只读观察仍可进行

#### Scenario: 所有者崩溃
- **WHEN** 写入所有者进程退出
- **THEN** 后继运行者能重新取得写入权，再读取有效持久前缀并执行修复，不接管仍存活的所有者

### Requirement: 同库单在线后端
在线后端 SHALL 在启动修复和开放 HTTP/SSE 前取得按规范化 SQLite 数据库路径确定的进程间实例锁，并持有至存储关闭。业务写入、启动修复和实时 follow SHALL 由持锁后端负责。独立进程 SHALL 可用只读 handle 查询连续的已提交历史。

#### Scenario: 不同端口尝试在线打开同一库
- **WHEN** 在线后端正在生成，另一个后端尝试在不同端口启动并打开同一库
- **THEN** 第二个后端在修复和开放 HTTP/SSE 前因实例锁冲突启动失败，原 Turn 继续运行。独立只读进程仍可读取连续的已提交前缀

#### Scenario: 在线后端退出后由后继实例恢复
- **WHEN** 在线后端退出，持久日志中仍有未闭合 Turn，后继实例取得实例锁
- **THEN** 后继实例按会话取得写入权，将遗留 Turn 结算为 `interrupted`，模型调用次数不增加

### Requirement: 从有序历史派生模型消息
模型消息 SHALL 从日志中的有序消息视图派生，不维护独立可写的模型历史。历史替换 SHALL 验证来源和完整覆盖范围，只影响后续模型输入，不删除原始事件；人类历史 SHALL 保留原发生事实。非消息事件 SHALL 不因重放额外产生消息。

Session 内的 `surface` SHALL 维护当前模型消息对应的事件序号及其顺序。仅 `user/message`、`assistant/message`、`tool/result` 可进入 surface。每条此类事件 SHALL 声明 `surfaceOp: "append"` 或 `surfaceOp: { op: "replace", start, end }`。追加将新节点放在末尾，替换在所选范围的起点放入以当前事件 `seq` 标识的节点。

#### Scenario: 替换历史片段
- **WHEN** 合法替换覆盖已有消息片段
- **THEN** 后续模型输入使用替换后的有序视图，原事件仍可查询，用户历史不出现作为替换副本的新交互

#### Scenario: 重放并重复派生
- **WHEN** 重新读取同一有效日志并多次派生模型消息
- **THEN** 消息顺序和内容一致，日志及共享消息不可变，调用方修改结果数组不影响后续派生

### Requirement: 历史替换的范围与来源校验
替换 SHALL 在事件进入日志前验证。起止序号 SHALL 指向当前节点，按 surface 顺序取连续范围，包含两端。两端相同表示替换单节点。`sourceEventSeqs` SHALL 无重复，引用同一日志中更早且存在的事件，并包含全部被覆盖节点。替换 SHALL 保持工具调用与结果的配对。用 `tool/result` 替换时，目标 SHALL 为单个当前工具结果，且只允许改变模型可见的 `content`。

#### Scenario: 当前消息顺序与日志序号顺序不同
- **WHEN** 当前节点按视图顺序为 `[12, 5, 9]`，在日志位置 15 追加声明 `surfaceOp: { op: "replace", start: 12, end: 5 }` 的有效消息事件
- **THEN** 新视图为 `[15, 9]`

#### Scenario: 替换引用或工具配对无效
- **WHEN** 替换遗漏被覆盖节点、引用已离开当前视图的端点，或会拆散工具调用与对应结果
- **THEN** 系统拒绝替换，日志及消息视图保持原状

### Requirement: 派生消息与替换计数
`deriveMessages()` SHALL 从 surface 节点按顺序提取消息。普通追加只扩展派生缓存，替换使 `replaceGeneration` 加一并使缓存失效。每次调用 SHALL 返回独立数组，允许复用冻结的消息对象。`replaceGeneration` 只统计已接受的 surface 替换，与公开记录位置及实时帧版本分别维护。

#### Scenario: 重放替换前后的历史
- **WHEN** 分别重放替换事件之前和包含该事件的日志前缀
- **THEN** 两个前缀派生出各自截点的模型消息。包含替换的前缀恢复替换后的顺序，调用方修改返回数组不改变后续派生结果

### Requirement: 稳定前缀分支
系统 SHALL 从稳定前缀创建独立子会话。分支元数据 `fork` SHALL 包含 `parentSessionId`、`parentEndSeq` 和 `inheritedEventCount`。截点 SHALL 是已提交的 `turn/end` 或独立的 `compaction/end`，且该前缀中没有未闭合的 Turn 或压缩。

子会话 SHALL 复制包含截点的前缀，保留内部序号和真实用户消息的原始 `requestId`。`inheritedEventCount = parentEndSeq + 1`，也是首个自有事件的 `seq`。分支后父子会话追加 SHALL 互不影响。

#### Scenario: 创建并重开分支
- **WHEN** 从已完成历史创建子会话并完成持久化，再重新打开
- **THEN** 继承前缀、消息视图与 lineage 保持一致，后续父会话追加不改变子会话

#### Scenario: 独立压缩后分支
- **WHEN** 父会话独立压缩已成功提交，且以对应的 `compaction/end` 为截点创建分支
- **THEN** 子会话继承已替换的模型视图和原始日志，重开后得到相同结果

#### Scenario: 分支落在未闭合的执行范围内
- **WHEN** 指定分支前缀含未闭合的 Turn 或压缩
- **THEN** 创建被拒绝，不产生可见的半成品子会话

### Requirement: 会话创建与单个活动 Turn
系统 SHALL 在创建会话时仅保存会话元数据，不调用模型。每次接受消息时 SHALL 在同一持久批次保存用户消息与新 Turn 的开始事实。同一会话最多有一个活动 Turn，等待审批的 Turn 也计入。成功响应 SHALL 以持久化确认为前提。

接受批次 SHALL 先写入含 `turnId` 的 `turn/start`，再写入含同一 `turnId`、`requestId` 与校验后 `text` 的 `user/message`。真实用户消息 SHALL 使用 `data.source.kind: "user"` 和 `surfaceOp: "append"`。`step/start` 和 `step/end` SHALL 分别记录 `turnId`、`stepId`。`turn/end` SHALL 包含 `turnId`、`status` 和与终态匹配的 `reason`。终态只取 `succeeded`、`truncated`、`failed`、`cancelled` 或 `interrupted`。

#### Scenario: 创建空会话
- **WHEN** 用户创建会话
- **THEN** 返回会话标识，历史为空，未发起模型请求

#### Scenario: 并发提交消息
- **WHEN** 同一会话已有活动 Turn 时使用尚未接受的 `requestId` 提交消息
- **THEN** 系统拒绝新提交，不将其保存为已接受的用户消息，也不启动第二个 Turn

#### Scenario: 等待审批或取消尚未结算
- **WHEN** 会话正在等待审批或当前 Turn 的取消尚未完成结算，用户使用尚未接受的 `requestId` 提交新消息
- **THEN** 返回 409 turn_active，不保存新消息、不排队

### Requirement: 会话级运行对象与按需加载
同一会话在后端加载期间 SHALL 只有一个运行对象，跨多个 Turn 复用。创建空会话、读取历史和建立订阅 SHALL 不创建该对象或触发模型请求。首次提交时 SHALL 在取得写入权及完成必要修复后加载；并发加载 SHALL 不产生重复对象。Turn 结束 SHALL 回到空闲，显式关闭 SHALL 停止输入、等待活动退出并释放存储资源。

#### Scenario: 连续两个 Turn
- **WHEN** 一个 Turn 已结算，用户在同一会话提交下一条消息
- **THEN** 复用已加载运行对象，创建新 Turn，不因上一 Turn 结束而释放会话写入所有权

#### Scenario: 只观察历史
- **WHEN** 用户创建空会话、读取历史或订阅 SSE
- **THEN** 不创建 Agent、不调用模型，订阅断开不销毁已有运行对象

#### Scenario: 显式关闭运行对象
- **WHEN** 管理者关闭已加载会话运行对象
- **THEN** 新任务不再被接受，活动取消并等待退出，待写记录被处理，写入权和内存注册被释放，持久历史保留

### Requirement: 独立压缩的执行占用
Agent 运行状态 SHALL 为 `idle`、`running` 或 `maintenance`。`running` 表示活动 Turn 占用，包含 Turn 内压缩、审批等待及取消收尾。独立压缩 SHALL 在串行区内确认会话可接收任务，并在异步工作开始前从 `idle` 切换到 `maintenance`。新 Turn 与独立压缩 SHALL 共用准入检查。生成摘要期间释放 Session 串行区，Agent 继续保持占用。

存储准入 SHALL 独立于 Agent 运行状态。结果待核对、修复待提交或存储故障时 SHALL 阻止新任务，等待期间可释放串行区。会话只有在占用已释放且存储准入开放时才可对外表示能够接收新任务。

#### Scenario: 独立压缩与新 Turn 竞争
- **WHEN** 独立压缩先取得空闲会话的执行权，随后收到使用新 `requestId` 的消息或另一项独立压缩
- **THEN** 后到的任务不进入执行。新编号消息返回 `409 {code: "session_busy"}`，不保存或排队。历史与 follow 仍可读取已确认的会话事实

#### Scenario: 独立压缩期间重发已提交消息
- **WHEN** 独立压缩正在执行，客户端以相同编号和正文重发已提交消息
- **THEN** 返回 `200` 和原 `turnId`，不重新调度

### Requirement: 压缩的开始与选区校验
`compaction/start` SHALL 保存 `compactionId` 与 `turn`，独立压缩使用 `turn: null`，Turn 内压缩使用所属 `turnId`。系统 SHALL 确认开始记录提交后才调用摘要模型。系统 SHALL 在生成前记录待替换节点序列，并在提交前回到串行区重新定位选区、比较完整节点序列及校验工具调用配对。

#### Scenario: 摘要生成期间选区变化
- **WHEN** 摘要返回时，待替换的节点已变化，即使起止节点仍存在
- **THEN** 本次压缩不产生 surface 替换，保留其他已提交操作造成的变化，并写入失败结算

#### Scenario: 摘要生成期间选区之外追加消息
- **WHEN** 选区之外出现新节点，所选范围的节点及其顺序保持一致，替换仍满足配对规则
- **THEN** 系统可以提交选区的摘要替换，保留选区之外的新节点

### Requirement: 压缩摘要与替换的原子提交
成功批次 SHALL 按 `compaction/summary`、替换 `user/message`、成功的 `compaction/end` 顺序整体校验并原子提交。摘要事件 SHALL 保存 `compactionId`、`summary`、`shadowedRange: { start, end }`、按 surface 排列的 `shadowedSeqs`、摘要模型 `route` 及可用的 `usage`。摘要事件只记录事实。

替换消息 SHALL 携带摘要 `text`、`data.source: { kind: "compact", compactionId }` 和 `surfaceOp: { op: "replace", start, end }`，`sourceEventSeqs` 至少引用摘要事件及全部被覆盖节点。只有该消息改变 surface。确认成功批次提交后，系统才可更新内存 surface 并发布成功结果。

#### Scenario: 成功批次提交
- **WHEN** 摘要生成成功且替换校验通过
- **THEN** 持久历史同时包含摘要、替换消息和成功终态。重放只从替换消息派生摘要节点，原始消息事件保留

### Requirement: 压缩结算与提交核对
`compaction/end` SHALL 保存 `compactionId`、与开始一致的 `turn`、`status` 以及非成功时的 `reason`。`status` 取 `succeeded`、`failed`、`cancelled` 或 `interrupted`。同一会话每个 `compactionId` 最多提交一个终态。取消与提交竞争时 SHALL 以已提交结果为准。

提交结果未知时，系统 SHALL 保持任务阻塞，先确认原事务已终止，再可靠读取持久日志。若已有终态则采用该终态，只有确认原写入未提交且确实缺少终态时才可补写。无法核对或结算时 SHALL 保持阻塞或进入存储故障状态。

#### Scenario: 开始记录确认未提交
- **WHEN** `compaction/start` 确认未提交
- **THEN** 系统释放占用并报告失败，不调用摘要模型或补写结束记录

#### Scenario: 摘要失败、取消或成功批次确认回滚
- **WHEN** 摘要失败、取消阻止成功提交，或成功批次确认未提交
- **THEN** 系统提交对应的失败或取消终态，确认后释放占用。本次压缩不产生 surface 替换，保留其他已提交操作造成的变化

#### Scenario: 原事务仍可能提交
- **WHEN** 暂时读不到压缩记录，且原事务尚未确认终止
- **THEN** 系统继续阻塞新任务，不补写终态，不更新 surface 或发布成功结果

#### Scenario: 成功提交后收到取消
- **WHEN** 成功批次已提交，随后收到取消或在核对时发现已提交的成功终态
- **THEN** 采用已提交的成功结果，不追加第二条终态

### Requirement: 持久接受后由后端接管执行
系统 SHALL 在会话串行区内校验并暂存携带 `requestId` 的用户消息和 Turn 开始事件，将二者、去重索引及游标一起原子提交。暂存事件 SHALL 在确认提交后才发布到 Session 一次并交给调度器。首次接受消息时，接口 SHALL 在运行对象加载成功、取得写入权、批次持久化且后端接管调度后返回 `202` 及 `sessionId`、`turnId`，无需等待 Provider 响应。系统 SHALL 仅在确认批次未提交时将其报告为未接受。若提交结果暂时未知，系统 SHALL 在继续处理该会话前依据持久日志核对。响应连接关闭 SHALL 不撤销已接受任务。

#### Scenario: Provider 尚未响应
- **WHEN** 消息已经持久接受且后端接管调度，Provider 尚未产生首个输出
- **THEN** 接口可以返回 202，后续错误归入返回 turnId 的结算，浏览器断开不取消该任务

#### Scenario: 接受前加载或取得写入权失败
- **WHEN** 运行对象加载或取得写入权失败，接受批次尚未提交
- **THEN** 接口返回失败，历史和游标保持原值，模型未被调用

#### Scenario: 接受事务确认回滚后重新提交
- **WHEN** 空会话首次提交事务确认回滚，存储恢复并完成后台排空后，用户以相同 `requestId` 和正文重试，由无工具模拟模型正常回答
- **THEN** 首次提交在连接可响应时返回 `503 {code: "submission_not_accepted"}`。回滚和排空之后原用户消息、Turn 和模型调用数均为 0，历史和游标保持原值。同编号重试返回 `202`，用户消息、Turn 和模型调用数各为 1

#### Scenario: 提交成功后内存发布或调度交接失败
- **WHEN** 接受事务已提交，随后内存发布或调度交接失败
- **THEN** 若连接仍可响应，返回 `200 {sessionId, turnId}` 确认已提交。系统按持久日志恢复会话，只保留一条用户消息和对应 Turn，无法安全接管的 Turn 按故障路径结算，进程退出后遗留 Turn 按中断修复。客户端从历史或 SSE 取得 Turn 结局

### Requirement: 同一消息提交可安全重试
消息提交接口 SHALL 接收客户端生成的 `requestId` 和正文，先查 `(sessionId, requestId)`，再判断会话是否可接受新任务。已提交且校验后的正文一致时 SHALL 返回 `200` 及原 `{sessionId, turnId}`，只确认已有提交。已提交且正文不同时 SHALL 返回 `409 submission_conflict`。SQLite SHALL 对 `(sessionId, requestId)` 施加唯一约束。去重索引 SHALL 可从会话自身接受的用户消息重建，fork 继承的消息 SHALL 不占用子会话的提交编号。重复请求 SHALL 不重复写入用户消息、创建或调度 Turn。

#### Scenario: 响应丢失后重试原提交
- **WHEN** 首次提交已落盘但客户端未收到响应，并以相同 `requestId` 和正文重试，原 Turn 仍在运行或已结束
- **THEN** 返回 `200` 和原 `turnId`，历史及模型调用次数不因重试增加。重新打开数据库后重试结果一致

#### Scenario: 并发重发同一提交
- **WHEN** 同一会话并发收到相同 `requestId` 和正文，且会话起初空闲，提交及调度均成功
- **THEN** 仅一份请求返回首次接受的 `202`，其他请求返回 `200` 和同一 `turnId`，只保存一份用户消息与 Turn，并只调度一次

#### Scenario: 复用已提交编号但正文不同
- **WHEN** 请求使用该会话已接受的 `requestId`，校验后的正文与原提交不同
- **THEN** 返回 `409 submission_conflict`，原提交保持原状，历史和模型调用次数不增加

#### Scenario: 使用新编号再次发送相同正文
- **WHEN** 原 Turn 已结束，客户端使用新的 `requestId` 发送相同正文
- **THEN** 接受新提交并返回 `202` 和新的 `turnId`

#### Scenario: 提交结果暂时未知
- **WHEN** 首次请求或同编号重发需要响应时，后端仍无法确认原事务是否提交
- **THEN** 连接可响应时返回 `503 {code: "submission_pending"}`。后端阻止该会话的新任务和外部效果，不因重发再次写入或调度。确认原事务已终止并按 `(sessionId, requestId)` 核对可靠的持久记录后，才继续处理该会话

### Requirement: 标识来源与关联范围
sessionId、turnId、stepId、attemptId SHALL 由后端生成，`requestId` SHALL 由消息提交方生成并在所属会话内使用。operationId SHALL 在参数校验后由后端生成并绑定确切操作。callId SHALL 保留模型提供的值，并结合所属 Step 关联，不作为全局唯一标识。前端引用服务端生成的标识时 SHALL 使用服务端已返回的值，模型 SHALL 不能指定 operationId。

#### Scenario: 不同 Step 使用相同 callId
- **WHEN** 两个 Step 的模型输出使用相同 callId
- **THEN** 结果和审批按所属 Session、Turn、Step 正确关联，不因 callId 相同而相互覆盖或合并

### Requirement: 统一模型与工具循环
系统 SHALL 通过统一模型合约处理文本、工具调用、结束原因、用量及错误。只有完整且参数通过校验的调用才能进入工具执行。Step SHALL 包含同一次模型决策的 Attempt 及该决策产生的工具批次。需要模型续答时，系统 SHALL 在该批次结果持久化后创建新 Step，其第一次模型请求是新 Step 的第一个 Attempt。系统 SHALL 以有限步数限制循环。

#### Scenario: 工具参数仍在生成
- **WHEN** 模型只返回部分工具参数
- **THEN** 系统仅展示生成状态，不执行工具

#### Scenario: 模型输出结束并请求工具
- **WHEN** 当前 Attempt 以 tool_calls 结束并提交完整且通过校验的工具调用
- **THEN** 系统在当前 Step 处理该批工具，Turn 保持活动

#### Scenario: 工具批次结束后需要续答
- **WHEN** 当前 Step 的工具结果已保存，且没有结束 Turn 的条件
- **THEN** 下一次模型请求属于新 Step，并包含此前提交的 assistant 文字、对应工具调用与工具结果

#### Scenario: 循环预算耗尽
- **WHEN** Turn 达到配置的最大模型步数
- **THEN** 系统结束本轮并记录预算耗尽原因，不再调用模型或工具

### Requirement: 模型接入的序列化与鉴权
模型接入层 SHALL 将统一消息、工具定义和生成参数转换为 Provider 请求，并将响应转换为统一流及结束原因。端点与鉴权 SHALL 从后端配置取得，从请求准备到发送和生成期间使用一致的配置快照。凭据 SHALL 不进入历史、前端或普通日志。接入层 SHALL 不修改会话事实、不执行工具或自行推进 Turn。

#### Scenario: Provider 请求格式不同
- **WHEN** 相同的统一请求交给不同 Provider 接入实现
- **THEN** 各自序列化为 Provider 支持的字段，执行层无需依赖其 HTTP 或流协议细节

#### Scenario: 请求期间配置改变
- **WHEN** 请求准备完成后、发送前或生成期间，端点或凭据配置发生变化
- **THEN** 本次请求继续使用准备时确定的端点和凭据，后续请求可使用新配置

### Requirement: 模型请求错误与资源清理
模型接入层 SHALL 区分鉴权、限流、网络、协议、请求超时和上游取消，保留安全诊断而不泄露秘密。请求级超时 SHALL 与 Turn 总预算分别执行；取消 SHALL 传播至实际请求和流读取。提前停止消费 SHALL 释放底层流、计时器和监听器。初期 SHALL 不自动重试，包括关闭所用 SDK 的隐式重试。

#### Scenario: 用户取消流式请求
- **WHEN** 上游取消当前模型请求
- **THEN** 实际网络请求和读取被中止，执行层收到取消类别而非普通 Provider 失败，不再收到清理后的迟到输出

#### Scenario: 请求等待或流空闲超时
- **WHEN** 已配置的请求等待或流空闲预算耗尽
- **THEN** 接入层传播取消并报告可区分的超时，释放资源，不自行重新发起请求

#### Scenario: 调用方提前停止消费
- **WHEN** 调用方在流自然结束前退出迭代
- **THEN** 接入层取消底层请求并完成流清理，不留下后台持续读取或未处理异常

### Requirement: Turn 驱动按原因结算
Turn 驱动 SHALL 根据当前 Attempt 的结束原因与 Step 的批次结果决定续答或结算。正常模型回答与工具批次请求结束 SHALL 分别记录成功原因。截断、取消和请求失败 SHALL 保留各自的结束原因。

正常模型回答的 Turn SHALL 结算为 `succeeded / model_completed`，工具批次请求正常结束的 Turn SHALL 结算为 `succeeded / tool_concluded`，输出达到上限的 Turn SHALL 结算为 `truncated / output_limit`，崩溃修复关闭的 Turn SHALL 结算为 `interrupted / process_interrupted`。

#### Scenario: 模型正常回答且没有工具调用
- **WHEN** Attempt 正常结束且未请求工具
- **THEN** 系统保存 assistant 消息并以正常模型完成结算 Turn

#### Scenario: 工具批次结算后无需模型续答
- **WHEN** 当前 Step 的工具批次已完成，至少一个成功结果请求结束 Turn，且未触发取消或其他中止条件
- **THEN** 系统以工具批次结束为原因结算 Turn，不再创建下一 Step，也不发起模型请求生成总结

#### Scenario: 模型达到输出上限
- **WHEN** 当前 Attempt 因输出上限结束
- **THEN** 系统保存 Attempt 的截断记录和 output_limit 原因，随后以截断结算 Turn。本次 Attempt 输出的工具调用均不派发

### Requirement: Turn 记录与上下文持久化
系统 SHALL 保存用户消息、每个成功 Attempt 的 assistant 消息、工具结果和 Turn 终态。凭据 SHALL 不进入会话日志。

成功结算 SHALL 写入 `assistant/message`，包含 `turnId`、`stepId`、`attemptId`、`finishReason`、`text`、`toolCalls`、`stream`、`includeInModelContext: true`，以及 Adapter 提供时的 `usage`。`toolCalls` SHALL 按模型顺序保存完整的 `{ callId, name, arguments }`，同一消息内 `callId` 唯一，`arguments` 保留模型输出的完整字符串，供工具层解析和校验。每个 Attempt 最多有一条结算事件。

#### Scenario: 中间消息包含文字和工具调用
- **WHEN** 当前 Attempt 成功产生文字及完整工具调用
- **THEN** 系统先将文字和调用一起保存为一条 assistant 消息，再进入工具阶段。该消息留在会话历史，Turn 继续处理工具

#### Scenario: 中间消息未能提交
- **WHEN** 含工具调用的 assistant 消息保存失败
- **THEN** 系统不将该消息结算为已提交，关联工具不进入审批或执行

#### Scenario: 检查一次工具回答
- **WHEN** 读取已结束的 Turn 记录
- **THEN** 能关联实际模型、Prompt、工具定义、生成参数和进入模型的工具结果，不依赖当前可变配置推断过去输入

### Requirement: 按 Attempt 重建模型请求输入
系统 SHALL 保存不可变的 `request/header`，包含渲染后的 Prompt、工具定义、有效生成参数（含 Adapter 默认值）和实际选定的非敏感路由。首次请求、重新装载、配置变化和消息系列边界 SHALL 写入新快照，同一系列内未变化的后续请求 SHALL 复用上一份。模型生成前，系统 SHALL 为该 Attempt 追加 `request/prepared`，包含 `turnId`、`stepId`、`attemptId` 和 `headerSeq`。`headerSeq` SHALL 指向同一 Session 日志中位置更早的 `request/header`，准备事件自身的 `seq` SHALL 定义消息派生的日志前缀 `[0, seq)`。系统 SHALL 在检查点成功后使用准备时确定的消息和配置启动 Adapter 生成。

#### Scenario: 配置不变时发起下一次请求
- **WHEN** 同一消息系列内先后准备两次模型请求，期间追加了聊天消息，但有效配置和路由未变
- **THEN** 两次请求各有自己的准备事件和历史截点，并引用同一 `headerSeq`

#### Scenario: 历史和配置在请求后发生变化
- **WHEN** 记录请求 A 后替换 `surface`、变更配置和路由并发出请求 B，再重新打开会话
- **THEN** 按各自的 `attemptId` 重建的消息、Prompt、工具定义、有效生成参数和路由分别与 A、B 准备时的输入一致

#### Scenario: 请求已准备但生成尚未启动时崩溃
- **WHEN** `request/prepared` 已落盘，进程在启动 Adapter 生成前崩溃
- **THEN** 重开后仍可按 `attemptId` 查回准备好的输入，恢复关闭遗留 Step 和 Turn，并保留 Attempt 已准备但没有结算记录的事实

### Requirement: 请求配置快照的字段
`request/header.data` SHALL 包含 `route`、`systemPrompt`、`tools`、`effectiveParams` 和 `reason`。`route` SHALL 包含 `provider` 和 `model`；同一 Provider 与模型可经不同端点访问时 SHALL 另存能稳定区分本次非敏感路由的 `endpointId`。`tools` SHALL 按请求顺序保存模型可见的 `name`、可选 `description` 与 `inputSchema`。`reason` 取 `initial`、`resume`、`change` 或 `series`；配置变化同时开启消息系列时 SHALL 保存 `startsSeries: true`。

#### Scenario: 模型相同但切换端点
- **WHEN** 两次请求使用同一 Provider 与模型，但选择不同端点
- **THEN** 两个 Attempt 各自引用能区分实际端点的快照，重建得到各自原有的路由

### Requirement: 已结算 Attempt 的流记录
系统 SHALL 在 Attempt 结算时保存对应的紧凑带时序流，用于重建和诊断。该流 SHALL 不重复派生模型消息，失败流 SHALL 不作为正式回答展示。未结算草稿 SHALL 不被承诺在进程硬崩溃后恢复，不要求逐 token 单独持久化。

结算事件中的 `stream` SHALL 保留统一 chunk 的边界、顺序和相对时序，供重放与诊断。

#### Scenario: 读取已结算流
- **WHEN** 重新打开包含已结算 Attempt 的会话
- **THEN** 能恢复其流内容和顺序，但模型历史中只出现按结算规则选择的消息，不因回放流重复添加消息

### Requirement: 取消与故障结算
系统 SHALL 支持显式取消，停止后续调度并向当前模型或工具传播取消信号。用户取消与 Provider 失败 SHALL 分别结算。Turn SHALL 有明确终态，进程重启后遗留的活动 Turn SHALL 标记为中断且不自动续跑。

#### Scenario: 生成期间取消
- **WHEN** 用户在模型生成期间取消 Turn
- **THEN** 系统中止模型请求、停止后续工具调度并保存取消记录。有可展示的非空部分文字时随记录保存，刷新后标记为「已取消，回答未完成」。没有可展示文字时只保存终态，未完成工具参数不执行

#### Scenario: Provider 失败
- **WHEN** 当前模型请求失败
- **THEN** 系统保存失败原因并结束本轮，不将失败流作为可展示回答或模型历史，不自动重试该请求

#### Scenario: 绑定 Turn 的幂等取消
- **WHEN** 用户通过指定 sessionId 与 turnId 的入口取消活动 Turn，或重复发送该请求
- **THEN** 接口成功只承诺接受取消请求，信号传给当前活动；重复请求不重复产生效果，取消收敛前仍不接受新 Turn

#### Scenario: 旧 Turn 的迟到取消
- **WHEN** 已结算 Turn 的取消请求迟到，而会话已有新 Turn
- **THEN** 不取消或改变新 Turn，原 Turn 的终态不被改写

#### Scenario: 启动阶段修复但不加载 Agent
- **WHEN** 服务启动发现未闭合的持久 Turn 或压缩
- **THEN** 取得临时写入权后修复并持久化，释放临时资源，不创建 Agent、不续跑；查询历史无需先发送新消息，其他进程持有的会话不被修改

#### Scenario: 恢复未闭合压缩
- **WHEN** 系统取得会话写入所有权并核对已提交日志后，发现 `compaction/start` 没有对应终态
- **THEN** 按原 `compactionId` 写入 `compaction/end`，记录 `interrupted / process_interrupted`，再依次关闭实际打开的 Step 和 Turn。没有活动 Step 时不补造 Step。确认修复提交后重建 surface 和运行状态，再开放新任务

#### Scenario: 重启读到已结算的成功压缩
- **WHEN** 成功批次在进程退出前已提交，或对已修复会话再次执行恢复
- **THEN** 采用原终态及其持久日志，不重复追加结束事件或调用摘要模型

#### Scenario: 重启时存在遗留工具调用
- **WHEN** 后端重启发现未结算的 Turn 及已发出但未确认结果的工具
- **THEN** Turn 标记为中断，工具标记为结果未知，不重新执行

#### Scenario: 工具请求已保存但尚未开始
- **WHEN** 取得写入权后，发现未闭合 Turn 中的 assistant 工具调用无结果且没有进入调度的调用记录
- **THEN** 保存匹配调用标识的 cancelled / not_started 及进程中断原因，关闭遗留 Step 和 Turn，不执行工具

#### Scenario: 调度调用已保存但工具正文可能尚未执行
- **WHEN** 发现进入调度的调用记录而无结果，即使可能仍在等待审批，无法确认最终结局
- **THEN** 保存 `unknown / process_interrupted`，仅记录有证据的执行事实。若尚未生成操作则省略 `operationId`

#### Scenario: 恢复未决审批
- **WHEN** 持久日志有未闭合 Turn 及没有对应决定的 `approval/asked`
- **THEN** 用原审批 `id` 追加 `approval/decided`，保存 `outcome: cancelled` 和 `reason: process_interrupted`，然后关闭遗留执行范围。工具结果仍按持久调度与结果记录独立结算

#### Scenario: 重复恢复与已有结果
- **WHEN** 再次加载已修复会话，或遗留 Turn 的部分工具已有结果
- **THEN** 已有结果保持原样，不重复追加修复；修复批次持久化失败时不发布恢复成功的会话

### Requirement: 按 Attempt 结算筛选模型上下文
Attempt 结算 SHALL 区分 completed、cancelled、failed、truncated。持久记录 SHALL 以 includeInModelContext 明确是否允许该 Attempt 的输出进入模型上下文，并结合有序历史统一派生。正式消息可纳入；取消或截断的非空部分文字仅用于展示。失败只展示终态，诊断流不进入模型输入或正式回答。

非成功 Attempt SHALL 用 `assistant/settled` 保存 `turnId`、`stepId`、`attemptId`、`outcome`、`reason`、`stream` 和 `includeInModelContext: false`。`outcome` 只取 `cancelled`、`truncated` 或 `failed`。仅取消或截断可另带非空的 `text`，其中截断的 `reason` 为 `output_limit`。

#### Scenario: 截断后刷新
- **WHEN** Attempt 达到输出上限且已有可展示的部分文字，用户随后刷新会话
- **THEN** 从持久结算记录恢复文字，标记为「输出截断」，其上下文属性为 false

#### Scenario: 取消或截断后提交新一轮输入
- **WHEN** 系统为取消或截断后的下一轮构建模型上下文
- **THEN** 排除该 Attempt 的部分输出，保留此前正式提交的 assistant 消息及与其工具调用配对的结算结果
