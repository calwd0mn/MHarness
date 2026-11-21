# Spec Delta

## Purpose

为不绑定业务场景的 Agent 提供会话与 Turn 生命周期，使模型调用、工具循环、取消和失败能够形成可追溯的持久记录，并为前端观察及后续模型上下文重建提供可靠依据。

## ADDED Requirements

### Requirement: 业务模块拥有契约
系统 SHALL 由业务或能力所有者维护其数据定义与调用约定，不使用跨业务的中央协议包或全局类型包。Session 模块 SHALL 维护自身 HTTP 请求、响应及 SSE 传输封装，并提供独立的浏览器契约入口与服务端入口。具体功能的定义 SHALL 与其职责共置，公共入口可以选择性重导出，不要求集中所有类型声明。

#### Scenario: 前后端使用消息提交契约
- **WHEN** 服务端接收 Session 消息提交，且浏览器构造请求或解析响应
- **THEN** 双方使用 Session 业务模块维护的同一份公开 Schema 与推导类型，不复制字段定义，也不依赖中央协议包

### Requirement: 浏览器契约依赖隔离
浏览器契约入口的完整运行时及类型依赖链 SHALL 不包含 Fastify、SQLite、Node.js 专有资源或服务端实现。包导出、依赖声明与编译配置 SHALL 支持浏览器契约和服务端能力分别消费；仅使用纯类型导入 SHALL 不作为隔离成立的依据。

#### Scenario: 浏览器消费 Session 契约
- **WHEN** 前端通过公开契约入口导入 Schema 或类型并进行类型检查和构建
- **THEN** 契约可被解析和使用，依赖链不要求服务端资源或声明，浏览器产物不引入服务端实现

### Requirement: Session 事件与传输封装的定义归属
Session 核心 SHALL 独立定义事件的数据契约。持久化接口 SHALL 由会话能力定义，SQLite 专有结构 SHALL 留在存储实现。会话 API SHALL 复用浏览器可加载的事件数据定义，并维护历史和实时的传输封装。HTTP 历史以已提交日志为源，实时 follow 以 live Session 为源，尚未加载时以已提交日志初始化。

#### Scenario: 日志包含请求事件
- **WHEN** Session 保存 `request/header` 并向浏览器返回该日志前缀
- **THEN** 封装内保留该原始事件及序号，浏览器消费共享的纯数据 Schema，展示仍由视图自行派生

#### Scenario: 内部实现使用运行资源
- **WHEN** Agent 或存储实现增加取消控制器、数据库连接或实现专有状态
- **THEN** 相关结构由实现所属模块维护，不加入浏览器契约，也不要求前端消费者引用这些运行资源

### Requirement: 不可变追加日志
会话 SHALL 以只追加事件日志为事实来源，元数据与日志分开保存。事件 SHALL 在接受前校验为可无损保存的 JSON 并取得独立不可变快照，拒绝无效事件时不改变日志。事件 `seq` SHALL 从 0 连续递增。`session.seq` SHALL 表示事件数及下一条追加分配的位置。快照 `cursor` SHALL 表示对应前缀最后一条事件的位置，空前缀为 `-1`。状态与消息视图 SHALL 能从日志重建。

会话元数据 SHALL 包含 `sessionId`、`createdAt`，分支会话另存谱系和继承数量。内部事件 SHALL 包含 `seq`、`type`、`time` 和 `data`，`data` 的结构由 `type` 决定。`createdAt` 与 `time` SHALL 使用非负安全整数表示 Unix 毫秒，`seq` SHALL 为非负安全整数。持久事件以 `(sessionId, seq)` 唯一定位，事件体可由所属日志取得 `sessionId`。首版事件外壳省略 `ignorable`，遇到未知类型时 SHALL 拒绝重放。

#### Scenario: 调用方修改原始参数
- **WHEN** 调用方在事件被接受后修改传入对象
- **THEN** 日志及后续派生结果保持接受时的值，读取者不能修改已接受事件

#### Scenario: 无效事件被拒绝
- **WHEN** 候选事件包含循环引用或不可无损保存的值，或违反历史替换约定
- **THEN** 系统拒绝事件，不增加序号、不发布该事件，已有视图保持不变

#### Scenario: 按位置读取日志
- **WHEN** 日志有 N 个事件并读取区间 [a, b)
- **THEN** 返回该区间内的稳定有序事件，快照对应的完整前缀 `cursor` 为 `N - 1`，`session.seq` 为 `N`。例如 `[0,1,2]` 的 cursor 为 2，下一事件位置为 3。空日志的 cursor 为 -1，下一事件位置为 0

### Requirement: 通知与持久化分离
系统 SHALL 在内存接受事件后向已注册监听器发布同步通知，不依赖监听器返回值决定业务流程。监听器 SHALL 可解除，单个监听器失败 SHALL 被报告且不撤销已接受事件或阻断其他监听器。内存通知 SHALL 不作为持久化成功证据。

#### Scenario: 一个监听器抛出错误
- **WHEN** 已接受事件的一个监听器抛出错误
- **THEN** 其余本次已选定监听器仍收到通知，错误可被观察，日志不回滚

#### Scenario: 解除监听
- **WHEN** 模块解除注册后系统接受后续事件
- **THEN** 已解除的监听器不再接收后续通知

### Requirement: 会话存储访问
系统 SHALL 提供会话创建、打开及元数据查询。`SessionHandle.read()` SHALL 读取同一次截点的已提交事件数组，且读取 SHALL 不触发 flush。HTTP 持久历史、未加载会话的 fork 和恢复核对 SHALL 使用该入口。实时 follow 和已加载会话的 fork SHALL 使用内存 Session 的已接受前缀。只读句柄不得修改日志。关闭 SHALL 幂等，写句柄关闭时 SHALL 先处理待写事件，失败时也 SHALL 释放写入所有权并报告错误。

#### Scenario: 创建空会话后确认持久化
- **WHEN** 新建空会话完成持久化确认
- **THEN** 其他进程能查询并打开该空会话，其历史为空

#### Scenario: 区分已接受和已提交的前缀
- **WHEN** 已提交 `seq` 为 0 至 9，当前后端已接受 `seq` 为 10 和 11，但尚未确认提交
- **THEN** `handle.read()` 返回已提交的 `0..9`，live Session 快照返回已接受的 `0..11`，读取均不排空缓冲。确认提交后，`handle.read()` 返回 `0..11`。

#### Scenario: 批次写入失败
- **WHEN** 连续批次在提交前发生错误
- **THEN** 数据库不暴露半个批次，不推进持久游标，后续重试不产生序号缺口或重复事件

#### Scenario: 只读访问与关闭
- **WHEN** 调用方尝试通过只读句柄追加事件，或通过已关闭句柄执行操作
- **THEN** 只读句柄的写操作和已关闭句柄的读写操作被拒绝。重复 `close()` 幂等，写句柄关闭前处理待持久化记录

### Requirement: 写句柄的首次提交
`persistence.create(header, options?)` SHALL 校验 ID、取得写入所有权并暂存 header 与继承数量。首次 `handle.append(events)` SHALL 原子提交 header、继承数量和完整初始事件批次。后续 append SHALL 在同一事务内追加连续批次。成功返回即确认整批已持久化。`open(id, access)` SHALL 显式区分 `read`、`write`，查不到已提交会话时返回 `undefined`，已有写入者时写打开 SHALL 报所有权冲突。`stat`、`list` SHALL 返回已提交的 header、继承数量和事件数。 `eventCount` SHALL 包含继承事件及标记。

#### Scenario: 空会话的显式创建
- **WHEN** 调用方显式 flush 尚无事件的空会话写 handle
- **THEN** 空 header 提交后才可由查询看到，HTTP 创建可返回 201

#### Scenario: 首次提交在写入 header 后回滚
- **WHEN** 首次 append 在写入 header 后、提交全部初始事件前失败并确认回滚
- **THEN** stat、list 和 open 均看不到会话。持有写入权的句柄可重试原批次。放弃并关闭句柄时释放写入权，数据库中仍无该会话

### Requirement: 严格读取已提交范围
`read(offset?, length?)` SHALL 默认返回全部已提交事件，给定 `offset` 且省略 `length` 时读到本次截点的末尾。`offset` 与 `length` SHALL 为非负安全整数。`offset` 不得超过观察到的事件数。显式长度要求完整区间 `[offset, offset + length)` 落在此次观察到的已提交前缀内。范围未覆盖时 SHALL 报错且不返回部分结果。返回值为事件数组。

#### Scenario: 已提交前缀尚未到达指定切点
- **WHEN** 已提交事件为 `0..7`，调用方执行 `read(0, 10)`
- **THEN** 报范围未覆盖。`read()` 返回 8 条事件，`read(8, 0)` 返回空数组

### Requirement: 显式持久化检查点
检查点成功 SHALL 保证调用开始时已接受的事件已落盘。创建成功响应、模型请求及工具正文执行 SHALL 等待各自所需的持久化检查点。失败批次 SHALL 保序保留。持久化后端 SHALL 在确认原事务结束后核对不确定的提交结果。仅在确认整批未提交且写所有权有效时可重试原批。无法可靠核对时 SHALL 报错并保持写入阻塞。

#### Scenario: 模型请求前检查点失败
- **WHEN** 模型请求使用的消息前缀及生效配置未通过持久化检查点
- **THEN** Adapter 的模型生成调用次数为 0

#### Scenario: 已接受尾部尚未落盘
- **WHEN** 事件已被内存接受但尚未完成检查点
- **THEN** 实时 follow 可以展示该尾部，HTTP 持久历史和重启恢复只读取已确认前缀。依赖该尾部的模型请求或工具正文仍须通过各自的检查点

#### Scenario: 并发排空与关闭
- **WHEN** 后台排空、显式检查点和关闭发生重叠
- **THEN** 同会话写入保持顺序，不重复提交或丢弃批次，关闭处理剩余记录并释放所有权；失败可被调用方观察

#### Scenario: 持久化连接缺失或事件未入队
- **WHEN** 内存接受了事件，但持久化未连接或通知处理失败，持久前缀未覆盖检查点要求的位置
- **THEN** 检查点失败，不能因缓冲为空而返回持久化成功

### Requirement: 会话写入缓冲与排空
写入器 SHALL 将所属 Session 新发布的事件复制到所属写入器的缓冲，并按序写入。首个待写事件启动固定批处理窗口，后续事件不重置期限。在途写入期间到达的事件进入下一批。显式 Session 检查点 SHALL 取消窗口等待，按序排空待写事件并确认持久位置覆盖目标。构造种子事件 SHALL 不发布追加通知。

后端统一 `flush()` SHALL 捕获调用时的活跃写入器，逐个排空缓冲并执行持久性屏障。某个会话失败后 SHALL 继续处理其余会话，最后以一个 `AggregateError` 汇总各 `sessionId` 和错误。

#### Scenario: 写入窗口内追加及写入期间追加
- **WHEN** 后续事件在固定窗口内到达，另有事件在当前批次写入时到达
- **THEN** 前者加入当前待写批次且不延长窗口，后者留到下一批。所有事件按原序号写入。受理的 Turn 和用户消息可分属不同批次，Step 开始记录在 pre-step 后另行追加

#### Scenario: 后台写入失败后显式排空
- **WHEN** 后台写入失败后调用 flush、关闭写入器或关闭后端
- **THEN** 保留原批次并暂停自动定时排空，显式操作立即按序重试。仍失败时向调用方报告

#### Scenario: 发布 Session 前写入种子
- **WHEN** 发布 Session 前已将种子写入 handle，并用它构造内存日志
- **THEN** 种子加载不触发追加通知，也不重复进入写入缓冲

#### Scenario: 统一 flush 遇到多个写入失败
- **WHEN** 调用后端统一 flush，其中两个活跃 writer 分别失败，另一个可正常提交
- **THEN** 可提交的会话照常提交，末尾抛出包含两个失败会话标识及原错误的 `AggregateError`

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

Session 内的 `surface` SHALL 维护当前模型消息对应的事件序号及其顺序。仅 `user/message`、`assistant/message`、`tool/result` 可进入 surface。每条此类事件 SHALL 声明 `surfaceOp: "append"` 或 `surfaceOp: { op: "replace", start, end }`。追加将新节点放在末尾，替换在所选范围的起点放入以当前事件 `seq` 标识的节点。`user/message.data` SHALL 直接保存消息本体。Assistant 成功消息和工具结果的消息本体 SHALL 位于 `data.message`。

#### Scenario: 替换历史片段
- **WHEN** 合法替换覆盖已有消息片段
- **THEN** 后续模型输入使用替换后的有序视图，原事件仍可查询，用户历史不出现作为替换副本的新交互

#### Scenario: 重放并重复派生
- **WHEN** 重新读取同一有效日志并多次派生模型消息
- **THEN** 消息顺序和内容一致，日志及共享消息不可变，调用方修改结果数组不影响后续派生

### Requirement: 历史替换的范围与来源校验
替换 SHALL 在事件进入日志前验证。起止序号 SHALL 指向当前节点，按 surface 顺序取连续范围，包含两端。两端相同表示替换单节点。`sourceEventSeqs` SHALL 无重复，引用同一日志中更早且存在的事件，并包含全部被覆盖节点。替换 SHALL 保持工具调用与结果的配对。用 `tool/result` 替换时，目标 SHALL 为单个当前工具结果，且只允许改变工具结果块中模型可见的 `content`。替换事件 SHALL 保存完整的新结果，保留原 `message.id` 和调用关联。

#### Scenario: 当前消息顺序与日志序号顺序不同
- **WHEN** 当前节点按视图顺序为 `[12, 5, 9]`，在日志位置 15 追加声明 `surfaceOp: { op: "replace", start: 12, end: 5 }` 的有效消息事件
- **THEN** 新视图为 `[15, 9]`

#### Scenario: 替换引用或工具配对无效
- **WHEN** 替换遗漏被覆盖节点、引用已离开当前视图的端点，或会拆散工具调用与对应结果
- **THEN** 系统拒绝替换，日志及消息视图保持原状

### Requirement: 派生消息与替换计数
`deriveMessages()` SHALL 从 surface 节点按顺序提取消息。普通追加只扩展派生缓存，替换使 `replaceGeneration` 加一并使缓存失效。每次调用 SHALL 返回独立数组，允许复用冻结的消息对象。`replaceGeneration` 只统计已接受的 surface 替换，与日志游标及实时帧版本分别维护。

#### Scenario: 重放替换前后的历史
- **WHEN** 分别重放替换事件之前和包含该事件的日志前缀
- **THEN** 两个前缀派生出各自截点的模型消息。包含替换的前缀恢复替换后的顺序，调用方修改返回数组不改变后续派生结果

### Requirement: 稳定前缀分支
fork SHALL 接收 `{ sessionId, atSeq? }`。父会话已加载时用内存快照，否则读已提交前缀。锚点在 Turn 内选其 `turn/end`，轮间归到上一轮。缺省或超过已观察末尾时选最近闭合 Turn。候选尾部延伸至下一 `turn/start` 前。遇到未闭合 Turn、Step 或独立压缩 SHALL 回退到最近稳定前缀。缺少 `command/done` 不影响截点。无稳定闭合 Turn 或锚点位于未闭合 Turn 时 SHALL 返回 `session/fork-unavailable`。

`cut` SHALL 为排他的结束位置和 `inheritedEventCount`。子会话 SHALL 保留原事件的序号及标识，header 保存 `parentSession` 和 `isSeeded: true`。本次 fork 的 `session/end-seed { inherited: true }` SHALL 位于 `seq=cut`。嵌套分支按当前会话的继承数划界。

#### Scenario: 父会话的结算尚未落盘
- **WHEN** 父内存日志已接受 `seq=7` 的 `turn/end`，父数据库只确认到 `seq=6`，子会话初始化提交后进程重启
- **THEN** 子会话独立恢复继承事件 `0..7`、结束标记 `seq=8` 和谱系。下一条执行事件的序号为 9，父会话的恢复结果不改变子日志

#### Scenario: 独立压缩后分支
- **WHEN** 稳定候选前缀包含独立压缩已提交的 `compaction/end`，且该压缩没有命令关联或关联命令尚无 `command/done`
- **THEN** 子会话保留压缩终态。成功时一并继承摘要、checkpoint 和替换后的模型视图。重开后结果一致，子会话不补写父命令的终态

#### Scenario: 锚点落在未结束的 Turn 内
- **WHEN** `atSeq` 指向正在执行且没有 `turn/end` 的 Turn
- **THEN** 返回 `session/fork-unavailable`，没有可见的半成品子会话

#### Scenario: 两轮之间的锚点与未结束的压缩
- **WHEN** Turn 1 在 `seq=5` 结束，两轮间的独立压缩从 `seq=6` 开始，`atSeq=7` 指向压缩期间的事件
- **THEN** 若压缩在 `seq=9` 完成，则复制 `0..9`，后续 Turn 是否完成不影响锚点归属。若压缩尚未结束，则复制 `0..5`

#### Scenario: 两轮之间的命令只有运行记录
- **WHEN** Turn 结束后的候选前缀包含 C1 的 `command/run`，没有对应终态或未闭合压缩，且包含 C2 的完整命令记录
- **THEN** 子会话继承 C1 的 run 和 C2 的完整记录，保留原事件序号和标识

#### Scenario: busy 命令的运行记录和终态跨 Turn
- **WHEN** 候选前缀包含 T1 内的 busy 命令 `command/run`，其 `command/done` 位于候选边界之后
- **THEN** 子会话继承完整的 T1 和该 `command/run`，不延伸到下一 Turn。父会话之后写入的终态不改变这份子会话历史

### Requirement: 分支会话的准备与发布
系统 SHALL 先准备未发布的子 Session。子写 handle 的首次 `append()` SHALL 提交 header、继承数量、seed、结束标记及初始化期间新增的事件。成功后 SHALL 绑定后续写入监听，再发布子 Session 与 Agent，发出 `session/created`。初始化事件经初始快照交付。

#### Scenario: 观察子会话创建
- **WHEN** 子会话的首次 append 成功，观察者收到 `session/created`
- **THEN** 可从快照读取完整初始日志，后续自有追加进入子写入器。初始化事件不重复发布或入队

#### Scenario: 子会话初始化失败
- **WHEN** 子 handle 的首次 append 失败
- **THEN** 不发布子 Session 或 Agent。确认回滚后关闭准备句柄，不暴露空 header

### Requirement: 会话创建与单个活动 Turn
系统 SHALL 在创建会话时仅保存会话元数据，不调用模型。同一会话最多有一个活动 Turn，等待审批的 Turn 也计入。

受理 prompt SHALL 依次追加 `turn/start` 和 `user/message`，首个 `step/start` SHALL 由驱动在 pre-step 完成后追加。`turn/start.data` 为 `{ turn }`，Step 边界为 `{ turn, step }`。真实用户消息 SHALL 在 `data` 保存同一 `turn`、`requestId`、稳定 UUID、`role: "user"`、`source.kind: "user"` 及校验后的文本块，事件外层使用 `surfaceOp: "append"`。`turn/end.data` SHALL 为 `{ turn, reason }`，以 `reason.kind` 表达结算。

#### Scenario: 创建空会话
- **WHEN** 用户创建会话
- **THEN** 返回会话标识，历史为空，未发起模型请求

#### Scenario: 并发提交消息
- **WHEN** 同一会话已有活动 Turn 时使用尚未接受的 `requestId` 提交消息
- **THEN** 系统拒绝新提交，不将其保存为已接受的用户消息，也不启动第二个 Turn

#### Scenario: 等待审批或取消尚未结算
- **WHEN** 会话正在等待审批或当前 Turn 的取消尚未完成结算，用户使用尚未接受的 `requestId` 提交新消息
- **THEN** 返回 `409 { code: "agent_busy" }`，不接受新消息或占用该编号

### Requirement: 会话级运行对象与按需加载
同一会话在后端加载期间 SHALL 只有一个运行对象，跨多个 Turn 复用。创建空会话、读取历史和建立订阅 SHALL 不创建该对象或触发模型请求。首次提交或显式手动压缩命令 SHALL 在取得写入权及完成必要修复后按需加载；并发加载 SHALL 不产生重复对象。Turn 结束 SHALL 回到空闲，显式关闭 SHALL 停止输入、等待活动退出并释放存储资源。

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
- **THEN** 后到的任务不进入执行。新编号消息返回 `409 { code: "agent_busy" }`，不接受或排队。HTTP 历史可读取已提交前缀，follow 可读取 live Session

#### Scenario: 独立压缩期间重发已受理消息
- **WHEN** 独立压缩正在执行，客户端重发已受理的 `requestId`
- **THEN** 返回 `{ accepted: true }`，不重新调度

### Requirement: Step 配置快照与非持久化 pre-step
系统 SHALL 在每个 Step 开始前固定本步实际路由、system、tools 和生效生成参数，等待可取消的 pre-step 运行 hook 完成后才追加 `step/start`。pre-step SHALL 不作为持久化事件，不以同步事件通知代替等待。本 Step 的业务请求及同 Step 超限重试 SHALL 使用同一配置快照，消息 SHALL 从更新后的 surface 重新派生；中途配置变化 SHALL 在下一 Step 生效。

#### Scenario: 首次受理后等待 pre-step
- **WHEN** 新用户消息已受理而 pre-step 仍在等待摘要
- **THEN** live Session 已包含依次追加的 `turn/start` 和用户消息，受理可返回，首个 `step/start` 尚未追加，也没有 pre-step 持久事件；新编号仍被拒绝

#### Scenario: Step 打开前取消或失败
- **WHEN** 当前 Turn 在 pre-step 期间取消，或后续无法打开本 Step
- **THEN** 系统只结算实际打开的执行范围，不补造本 Step 的开始或结束，业务模型不在取消后启动

#### Scenario: 压缩期间切换模型
- **WHEN** Step 在路由 A 固定配置后开始压缩，期间配置切换到路由 B
- **THEN** 当前预算、摘要路由及本 Step 的业务请求仍使用 A；压缩后的消息重新派生，B 从下一 Step 生效

### Requirement: 实际路由模型容量与输出预留
系统 SHALL 从本 Step 实际路由的模型信息取得显式声明的 `contextWindow`，不使用最近历史请求的旧路由容量。输出预留 SHALL 优先使用本次生效的 `maxTokens`，缺省时使用模型声明的默认输出预算。容量和默认值 SHALL 来自 LLM 服务的本地注册或配置，不通过生成或 usage 猜测。预算信息缺失时，自动压力检查 SHALL 告警并跳过，不猜测窗口或将未知输出预留算作零，后续业务请求仍须通过正常检查点与取消检查。

#### Scenario: 没有请求历史或本步切换路由
- **WHEN** 空会话首次请求，或历史请求属于 A 而本 Step 实际路由为 B
- **THEN** 使用本步路由的容量及输出预算，不要求先存在持久请求，也不沿用 A 的窗口

#### Scenario: 缺少容量或默认输出预算
- **WHEN** 模型容量未知，或生效 maxTokens 与模型默认输出预算均缺失
- **THEN** 自动压力检查告警后跳过，不以虚构值决定压缩；正常准备失败、取消或检查点失败仍可阻止业务请求

### Requirement: 确定性上下文估算
基础计量 SHALL 使用 JavaScript `.length` 的 UTF-16 code unit 数、每 4 个长度单位约 1 token、每块 4 tokens 和每消息角色 4 tokens 的开销。文本和 reasoning 块 SHALL 计 `ceil(length / 4) + 4`；工具调用 SHALL 分别对名称与参数字符串向上取整后相加再加 4；工具结果 SHALL 递归累计内部块再加 4；其他块 SHALL 计 `ceil(JSON.stringify(block).length / 4) + 4`。消息 SHALL 累计各块并加 4，多块不合并后再计费。是否计入 reasoning 等内容 SHALL 对应该路由实际发送的消息投影。

#### Scenario: 文本及嵌套工具结果的开销
- **WHEN** 一条消息只有长度 100 的文本块，另一条只有包含该文本块的工具结果块
- **THEN** 两条消息分别估算为 33 和 37 tokens；工具结果的外层块开销不能省略

#### Scenario: 工具调用分别取整
- **WHEN** 一条消息仅有名称长度 12、参数字符串长度 100 的工具调用块
- **THEN** 工具块估算为 32 tokens，整条消息为 36 tokens

#### Scenario: 不同字符串长度单位
- **WHEN** 文本分别含汉字和 emoji，工具修剪器同时检查同一文本
- **THEN** token-meter 按 UTF-16 code unit 计长度，工具修剪按 Unicode 码点计长度，不混用两种单位

### Requirement: 请求 envelope 与完整压力估算
system 存在时 SHALL 计 `ceil(length / 4) + 4`，不存在为 0；tools 非空时 SHALL 计 `ceil(JSON.stringify(tools).length / 4) + 4`，否则为 0。请求压力 SHALL 为 system、tools、模型可见消息估算与业务输出预留之和。该值 SHALL 作为启发式而非 Provider 精确计数。

#### Scenario: 包含系统提示、工具和输出预留
- **WHEN** system 长度为 4000、tools JSON 长度为 8000、surface 合计为 10000 tokens，业务输出预留为 2000
- **THEN** 输入估算为 13008，压力为 15008；缺少 system 或空 tools 不增加对应开销

### Requirement: pre-step 压力压缩
默认 `thresholdRatio` SHALL 为 0.8、`retainRatio` 为 0.16。压力达到或超过 `floor(contextWindow × 0.8)` 时，系统 SHALL 先按工具结果修剪契约修剪当前 surface 的大工具结果，再重新计量。低于阈值 SHALL 结束本次压缩；仍达到阈值 SHALL 以 `floor(contextWindow × 0.16)` 选择安全前缀并摘要。

默认 `compactionRetries: 1` SHALL 表示单次 pre-step 最多两次摘要模型调用；额外一次仅用于首次摘要成功替换后压力仍达到阈值。摘要调用或校验失败 SHALL 退出，不自动重试、拆分或修复。每个后续 Step SHALL 重新检查；80% SHALL 是收敛目标，不阻止首次有效摘要提交。系统 SHALL 不新增压缩总时长限制，请求级超时和取消仍生效。

#### Scenario: 正好达到阈值
- **WHEN** 窗口为 100000、完整压力为 80000
- **THEN** 触发修剪与重新计量，尾部保留预算为 16000，而不是当前使用量的 16%

#### Scenario: 修剪已充分降压
- **WHEN** 修剪提交后压力低于阈值
- **THEN** 保留修剪结果，不调用摘要模型，也不补造摘要事件

#### Scenario: 两次收敛机会
- **WHEN** 第一次摘要已成功替换而压力仍达到阈值
- **THEN** 可以在当前 surface 上再摘要一次；第一次调用失败则不使用该额外机会。两次成功后仍未达目标时保留已提交结果、告警并继续后续流程，不增加第三次摘要

#### Scenario: 压缩异常后请求检查点决定能否继续
- **WHEN** pre-step 压缩在生成、校验或提交阶段抛出错误
- **THEN** 外层记录警告并继续后续流程，不因错误类别在此直接跳过下一流程；实际业务请求前仍检查取消与持久化，存储结果待核对或 flush 失败时下游 Adapter 调用次数为 0，已成功提交的修剪和摘要保留

### Requirement: 保留尾部与安全摘要前缀
系统 SHALL 对完整消息节点从最新向前累计模型可见估算，达到保留预算后停止；跨过预算的整节点 SHALL 保留，不截断。随后 SHALL 校验工具调用与全部配对结果，边界拆开配对时继续向更旧方向移动。预算为 0 时 SHALL 先纳入末尾节点，因此仍至少保留一个节点及必要配对。候选 SHALL 为剩余连续旧前缀，可包含当前 Turn 已完成的旧 Step，不包含未结算交互。无安全头部时 SHALL 返回未压缩且不调用摘要模型。

#### Scenario: 整节点跨过尾部预算
- **WHEN** 节点估算从旧到新为 `[8000,6000,7000,5000,6000]`，尾部预算为 16000
- **THEN** 从右累计为 6000、11000、18000，保留后三个完整节点，候选为前两个节点

#### Scenario: 工具配对跨越边界
- **WHEN** 初选边界将 Assistant 工具声明与其结果分到两侧
- **THEN** 向旧方向移动边界并保留更多节点，直到配对完整；若退到开头则不摘要

#### Scenario: 零预算仍保留末尾
- **WHEN** 手动命令或超限恢复以 0 作为尾部预算
- **THEN** 不将所有消息清空为摘要，至少保留末尾节点及必要配对

### Requirement: 摘要请求参数与输入范围
摘要 SHALL 只读取所选当前前缀，不读取保留尾部，也不恢复已修剪原文。一次调用 SHALL 直接处理整个安全前缀，不分块、不拆长文本、不分层合并。摘要 SHALL 沿用固定实际路由，设置独立的 `maxTokens: 8192`、专用摘要指令且不提供业务工具；模型允许时关闭推理，否则使用合法配置。该预算 SHALL 不被解释为正文长度保证，推理可消耗预算。

#### Scenario: 候选前缀超出摘要模型输入能力
- **WHEN** 直接摘要请求返回输入超限
- **THEN** 本次摘要失败，不拆分源文本或分块合并；自动入口告警后继续至请求检查点，手动入口报告失败

### Requirement: 摘要提示词与先前检查点合并
系统 SHALL 要求摘要按 Primary Request and Intent、Key Technical Concepts、Files and Code、Errors and Fixes、Pending Jobs、Current Work、Next Step、Critical Context 八节依次输出 Markdown，空节为 `(none)`，使用简短英文条目，保留精确指令、路径、命令、错误、标识、数值及用户纠正。当前工作及下一步 SHALL 以所选前缀截点为准。已有 `<compacted-summary>` 检查点 SHALL 被要求合并更新，保留仍有效事实并删除过时内容，不原样复制。

#### Scenario: 再次摘要包含先前检查点
- **WHEN** 候选前缀包含既有检查点及更新的交互，保留尾部另有新指令
- **THEN** 摘要提示词要求合并前缀中的仍有效事实和新信息、去除过时内容；不推断未提供的尾部，后续原文中的新指令继续生效

### Requirement: 摘要输出接受条件
接受输出 SHALL 只检查非空文本、未因输出上限截断、没有不支持的图片输出，以及包装后的摘要消息估算严格小于被替换历史。系统 SHALL 不校验章节完整性、顺序或格式，不发起格式修复调用。调用或校验失败 SHALL 不提交该次替换并退出摘要循环。

#### Scenario: 摘要章节不完整但通过接受检查
- **WHEN** 摘要非空、未截断、无不支持图片且包装后更小，但缺少某一提示词要求的章节
- **THEN** 不因章节缺失拒绝或修复，继续选区复验与原子提交

#### Scenario: 包装后未缩小或输出截断
- **WHEN** 摘要加包装后不比原范围小，或生成达到输出上限而截断
- **THEN** 不提交替换，退出本次循环，不用额外收敛机会重新生成；保留已有结果，手动入口向用户报告失败

### Requirement: 手动压缩命令
用户 SHALL 可运行 `/compact`，通过按会话定位的独立维护 HTTP 入口 `POST /api/sessions/:sessionId/compact` 执行，不作为普通 prompt 发送，不创建真实用户消息或 Turn。命令 SHALL 明确按需加载运行对象、完成恢复并取得空闲维护占用；忙碌时拒绝压缩，不排队执行，并按命令事件契约记录已识别命令的错误结算。手动压缩 SHALL 不检查压力阈值、不先修剪，以零保留预算选择最大安全前缀，最多一次摘要。响应 SHALL 区分摘要成功、无安全范围、取消和失败，正常完成 SHALL 显式等待持久化及 flush，不只确认受理。

#### Scenario: 低压力会话执行手动命令
- **WHEN** 用户在空闲会话运行 /compact，压力低于 80% 但存在安全前缀
- **THEN** 仍可摘要该前缀，不先修剪工具结果，不追加 Turn 或普通用户消息，完成持久化后报告结果

#### Scenario: 手动命令没有安全范围
- **WHEN** 保留末尾及工具配对后不存在可摘要前缀
- **THEN** 返回未压缩结果，摘要模型调用次数为 0；命令以 `success` 和 `No compactable history yet.` 结算，不生成压缩摘要或 checkpoint。正常 200 保留 `compactionId`、`status` 并携带服务端 `commandId`

#### Scenario: 手动命令响应丢失
- **WHEN** 维护操作已开始，浏览器断开或 HTTP 响应丢失
- **THEN** 操作不因断线取消，客户端不自动重发；可以通过 follow 中的压缩开始和终态恢复状态，用户再次明确运行命令才发起新操作

### Requirement: 手动压缩请求入口校验
`/compact` SHALL 在命令识别前校验请求。入口 SHALL 接受 `application/json` 及其合法媒体类型参数。畸形或空 JSON、无效路径参数或正文结构 SHALL 返回 400，超出正文大小限制 SHALL 返回 413，不支持的媒体类型 SHALL 返回 415。三者的响应体均为 `{ commandId: null, result: { kind: "error", text } }`，`text` 提供对应拒绝原因的安全说明。

#### Scenario: 入口拒绝不进入会话日志
- **WHEN** `/compact` 收到畸形或空 JSON、无效路径或正文、超限正文或不支持的媒体类型（包括 Fastify 能解析的 `text/plain`）
- **THEN** 返回对应的 400、413 或 415 及约定错误体；不分配命令 ID、不调用命令执行器或摘要模型、不写任何 Session 事件

#### Scenario: 意外异常保留脱敏错误
- **WHEN** `/compact` 遇到非上述入口校验失败的未分类内部异常
- **THEN** 返回脱敏 500，不把异常标记为明确的请求拒绝，不暴露内部错误细节

### Requirement: 共享命令生命周期事件
执行器识别命令后 SHALL 生成 `commandId`，记录 log-only `command/run` 和 `command/done`，沿用 `type`、Session 分配的 `seq` 和 Unix 毫秒 `time`。`run.data` 含 `commandId`、无斜杠的 `name`、可选 `args` 和 `source: { kind: "user" }`。`args` 保留分隔空白，`recordInput: false` 时 SHALL 省略。

`done.data` SHALL 包含相同 `commandId`、`kind: "success" | "error"`、可选 `text` 和仅成功可选的 `sourceEventSeq`。该引用属于同一命令且满足 `run.seq < sourceEventSeq < done.seq`，压缩成功时指向 `compaction/summary`。不同命令允许交错。同一 Session 日志（含继承前缀）的 ID SHALL 只有一个 `run`、至多一个 `done`。识别前的拒绝不生成记录。

#### Scenario: 无范围命令成功结算
- **WHEN** 识别 `/compact` 且确认没有安全可压缩范围
- **THEN** 记录同一命令的 `run` 和 `done`，后者为 `success` 和 `No compactable history yet.`；不记录摘要引用，也不调用摘要模型

#### Scenario: 重复命令 ID 或无效摘要引用
- **WHEN** 追加、暂存或重放包含重复 `command/run`，或成功 done 引用发生在对应 run 之前、位于 done 及之后或属于其他命令的摘要
- **THEN** 拒绝该不合法记录或批次，不合并两次命令，不让无效关联进入会话卡片

#### Scenario: 忙碌命令在共享日志结算
- **WHEN** 命令执行器识别 `/compact` 后发现会话有活动任务，且日志可可靠写入
- **THEN** 将同一命令的 `run` 和带 busy 文本的 `done(error)` 作为一个连续批次提交，向发起请求返回 `409` 及 `{ commandId, result: { kind: "error", text } }`。原活动继续，后到压缩不排队、不执行

#### Scenario: 异常结算事件追加失败
- **WHEN** 已识别命令的处理器抛错或取消，且追加错误 `command/done` 失败
- **THEN** 保留并向上传递原错误，不将追加错误替换为原错误，不声称错误终态已经持久化；不保证该异常调用留下 `done`

#### Scenario: 暂存占位与 busy 竞争
- **WHEN** 原活动的压缩暂存写入占用会话，另一个已识别命令发现 busy
- **THEN** 只协调拒绝记录的安全写入，不重新判断并执行后到压缩，不破坏原活动及其原子提交；存储结论不可靠时不绕过准入或伪称记录已持久化

#### Scenario: 活动任务在 busy 记录暂存期间准备继续写入
- **WHEN** busy 记录正在安全的让渡点提交，原活动准备追加事件或启动下一批暂存写入
- **THEN** 两方按同会话写入顺序协调，原活动不因 busy 记录占位而报写入竞争。正常提交时两条 busy 记录连续可见，原活动可继续结算。待核对或存储故障时依原存储规则阻塞

### Requirement: 压缩的开始与选区校验
`compaction/start` SHALL 保存 `compactionId` 与 `turn`，独立压缩使用 `turn: null`，Turn 内压缩使用所属数字轮次。由手动命令产生的开始、摘要、终态及 checkpoint SHALL 关联原 `sourceCommandId`；自动压缩和既有历史不要求该字段。系统 SHALL 确认开始记录提交后才调用摘要模型。系统 SHALL 在生成前记录待替换节点序列，并在提交前回到串行区重新定位选区、比较完整节点序列及校验工具调用配对。

#### Scenario: 摘要生成期间选区变化
- **WHEN** 摘要返回时，待替换的节点已变化，即使起止节点仍存在
- **THEN** 本次压缩不产生 surface 替换，保留其他已提交操作造成的变化，并写入失败结算

#### Scenario: 摘要生成期间选区之外追加消息
- **WHEN** 选区之外出现新节点，所选范围的节点及其顺序保持一致，替换仍满足配对规则
- **THEN** 系统可以提交选区的摘要替换，保留选区之外的新节点

### Requirement: 压缩摘要与替换的原子提交
成功批次 SHALL 按 `compaction/summary`、替换 `user/message`、成功的 `compaction/end` 顺序整体校验并原子提交。摘要事件 SHALL 保存 `compactionId`、`summary`、`shadowedRange: { start, end }`、按 surface 排列的 `shadowedSeqs`、摘要模型 `route` 及可用的 `usage`。摘要事件只记录事实。

替换消息 SHALL 携带摘要文本块、新消息 ID 和 `role: "user"`、`data.source: { kind: "compact", compactionId }` 和 `surfaceOp: { op: "replace", start, end }`，`sourceEventSeqs` 至少引用摘要事件及全部被覆盖节点。只有该消息改变 surface。确认成功批次提交后，系统才可更新内存 surface 并发布成功结果。

#### Scenario: 成功批次提交
- **WHEN** 摘要生成成功且替换校验通过
- **THEN** 持久历史同时包含摘要、替换消息和成功终态。重放只从替换消息派生摘要节点，原始消息事件保留

### Requirement: 合成 user 检查点的包装与尾部保留
摘要替换 SHALL 是合成 user 消息，不是 system 或 assistant 消息。内容 SHALL 按顺序包含自动检查点说明及 `<compacted-summary>` 开标记、摘要正文、`</compacted-summary>` 闭标记，正文可有多个文本块，适配器可转换最终格式。说明 SHALL 要求将摘要当作既有背景、从后续消息直接继续而不确认该检查点。system、tools、保留消息的角色、内容和顺序 SHALL 不被改写。

#### Scenario: 摘要替代旧前缀但不重复发送原文
- **WHEN** 安全前缀 A、B、C 被检查点 S 替换，尾部为 D、E
- **THEN** 后续业务 messages 为合成 user S、原 D、原 E，不同时发送 A、B、C 原文；system 和 tools 保持本 Step 的固定值，原交互仍保留在日志中

### Requirement: 压缩结算与提交核对
`compaction/end` SHALL 保存 `compactionId`、与开始一致的 `turn`、`status` 以及非成功时的 `reason`。`status` 取 `succeeded`、`failed`、`cancelled` 或 `interrupted`。同一会话每个 `compactionId` 最多提交一个终态。取消与提交竞争时 SHALL 以已提交结果为准。

提交结果未知时，系统 SHALL 保持任务阻塞，先确认原事务已终止，再可靠读取持久日志。若已有终态则采用该终态，只有确认原写入未提交且确实缺少终态时才可补写。无法核对或结算时 SHALL 保持阻塞或进入存储故障状态。

#### Scenario: 开始记录确认未提交
- **WHEN** `compaction/start` 确认未提交
- **THEN** 系统释放占用并报告失败，不调用摘要模型或补写结束记录

#### Scenario: 摘要失败、取消或成功批次确认回滚
- **WHEN** 摘要失败、取消阻止成功提交，或成功批次确认未提交
- **THEN** 系统提交对应的失败或取消终态；独立维护在确认后释放占用，Turn 内由驱动决定继续或结算。该次摘要不产生替换，先前已提交的工具修剪或摘要不回滚

#### Scenario: 原事务仍可能提交
- **WHEN** 暂时读不到压缩记录，且原事务尚未确认终止
- **THEN** 系统继续阻塞新任务，不补写终态，不更新 surface 或发布成功结果

#### Scenario: 成功提交后收到取消
- **WHEN** 成功批次已提交，随后收到取消或在核对时发现已提交的成功终态
- **THEN** 采用已提交的成功结果，不追加第二条终态

### Requirement: 暂存批次在排空关闭与在线恢复中的隔离
压缩暂存批次 SHALL 与普通已接受事件的待写重试分开。普通 flush、关闭排空或在线恢复 SHALL 不隐式重提已确认回滚的暂存批次，也不把它放入普通队列；普通已接受批次的既有重试语义 SHALL 保留。已确认提交的暂存结果 SHALL 至多安装和发布一次，不重复追加。原事务未终止或持久读取不可靠时 SHALL 保持相关存储准入和依赖模型阻塞。在线恢复 SHALL 先核对并采用暂存结果，再检查 live 与持久前缀及修复遗留范围；关闭失败 SHALL 按原关闭合约报告错误并释放资源，不伪称成功压缩。

#### Scenario: 普通 flush 核对到暂存回滚
- **WHEN** 摘要开始、成功摘要或工具修剪的暂存批次曾返回结果待核对，后续 Session、handle 或统一存储 flush 确认原批次未提交
- **THEN** 不重新提交原暂存批次，不把它放入普通缓冲，不增加其事件、替换代数或成功通知；由原压缩流程按可靠结论处理失败，普通已接受批次仍按原约定排空或显式重试

#### Scenario: 已提交暂存结果的重复排空与恢复
- **WHEN** 原暂存提交的确认响应丢失，后续 flush 或在线恢复可靠读到整个原批次已提交
- **THEN** 采用原持久结果，仍加载的 Session 只安装发布一次；重复 flush 或恢复不再次 append、分配序号或重复推进替换代数

#### Scenario: 关闭时确认暂存回滚
- **WHEN** writer、handle 或存储关闭引发最后排空，暂存批次被确认已经回滚
- **THEN** 不因关闭重新写入该批次，不暴露半个摘要或修剪结果；按原关闭合约释放资源及报告必要错误，原已提交历史保持不变

#### Scenario: 在线恢复前 live 尚未安装已提交暂存结果
- **WHEN** 运行对象的存储准入关闭，原暂存批次实际已提交而 live 前缀尚未包含它，开始在线恢复
- **THEN** 先核对并安装原提交，再比较前缀和修复遗留范围，不把该差异直接当作普通历史损坏；修复检查点成功前不开放 prompt 或手动维护准入

#### Scenario: 排空关闭或在线恢复仍无法核对
- **WHEN** 这些路径中原事务尚未终止或持久读取仍不可靠
- **THEN** 不以暂时查不到当作回滚、不重提或补终态、不发布替换；未关闭的运行对象保持准入关闭且不调用依赖 Adapter，关闭路径报告失败并按关闭合约释放资源，不报告压缩完成

### Requirement: live Session 受理 prompt
Session 命令入口 SHALL 明确各命令是否需要激活 Agent。`prompt` SHALL 在完成必要的恢复校验并取得写入权后，受理空闲 Agent 的输入。Turn 开始事件及用户消息依次进入内存日志且执行循环接管后，接口 SHALL 返回 `202 { accepted: true }`，不等待 pre-step 或 Step 开始。响应只确认受理，首次模型请求 SHALL 等待相应的持久化检查点。

#### Scenario: 内存已受理但尚未调用模型
- **WHEN** Turn 开始事件及用户消息已进入 live Session，执行循环已接管
- **THEN** 接口可立即确认受理，连接断开不取消该 Turn。若首次请求前的检查点失败，Provider 调用次数为 0

#### Scenario: 受理前加载或取得写入权失败
- **WHEN** 新请求尚未被受理，Agent 加载、恢复校验或写入权取得失败
- **THEN** 返回受理错误，不登记请求编号，不产生用户消息或新 Turn

### Requirement: 重发已受理的 prompt
系统 SHALL 在同一 Session 的串行区内先按 `requestId` 查重，再检查 Agent 是否空闲并受理新编号。命中时 SHALL 返回 `202 { accepted: true }`，保留首次受理的内容。去重 SHALL 基于会话自身已接受的消息，重启时从已提交前缀重建。fork 继承消息 SHALL 不占用子会话的提交编号。

#### Scenario: 并发重发同编号
- **WHEN** 同一会话并发收到相同编号的请求，第一份已受理，其他请求的内容可相同或不同
- **THEN** 均确认原受理，只追加一份消息和一个 Turn，只调度一次

#### Scenario: 重试时 Agent 正忙
- **WHEN** 客户端因响应丢失重发原编号，Agent 当前处于非 idle 状态
- **THEN** 命中原编号后返回受理成功。若提交的是新编号，则返回 `agent_busy` 且该编号仍可重试

#### Scenario: 重启后重发
- **WHEN** 进程重启，客户端重发原编号
- **THEN** 若该编号可从已提交日志恢复，则确认原受理。否则按新编号的受理规则处理

### Requirement: 标识来源与关联范围
`turn` SHALL 在所属 Session 内从 1 递增，`step` SHALL 在所属 Turn 内从 1 递增。重开和 fork 根据各自已有前缀继续分配。新消息 SHALL 生成 UUID，继承及工具结果替换保留原消息 ID。`requestId` 由提交方生成并在同一 Session 的自有用户消息中查重。`attemptId` 只用于 Agent 生命周期内的实时流关联。`callId` SHALL 保留模型原值，按 `(turn, step, callId)` 关联。`operationId` 在参数校验后由后端生成并绑定确切操作。

#### Scenario: 不同 Step 使用相同 callId
- **WHEN** 两个 Step 的模型输出使用相同 callId
- **THEN** 结果和审批按所属 Session、Turn、Step 正确关联，不因 callId 相同而相互覆盖或合并。Provider 要求同一请求内工具调用 ID 唯一时，Adapter SHALL 在发送时同步转换相关调用和结果的引用

### Requirement: 统一模型与工具循环
系统 SHALL 通过统一模型合约处理文本、Provider 提供的 reasoning、工具调用、结束原因、用量及错误。每次业务模型请求 SHALL 具有独立的 Attempt。Step SHALL 包含该 Step 的模型决策及其工具批次。只有完整且参数通过校验的调用才能进入工具执行。需要模型续答时，系统 SHALL 在工具结果和当前 `step/end` 持久化后，固定下一步配置并等待 pre-step，再开启新 Step、以新 Attempt 生成。系统 SHALL 以有限步数限制循环；摘要调用和同 Step 恢复重试 SHALL 不创建额外 Step。

#### Scenario: 工具参数仍在生成
- **WHEN** 模型只返回部分工具参数
- **THEN** 系统保留工具分片，页面显示整体忙碌状态。工具调用卡片在进入调度后建立

#### Scenario: 模型输出结束并请求工具
- **WHEN** 当前 Attempt 收到 `tool-calls`，且至少有一个工具块，所有工具块已由 `block-end` 关闭并具有完整的调用标识、工具名和原始参数
- **THEN** 系统结算并持久化 Assistant 消息，在当前 Step 按参数 Schema 和权限策略处理该批调用，按需请求审批。工具正文须通过执行前检查点和取消检查，Turn 保持活动

#### Scenario: 结束原因与工具块矛盾
- **WHEN** `stop` 伴随工具块，或 `tool-calls` 缺少工具块或包含未关闭或结构不完整的工具块
- **THEN** Agent 以 `PROTOCOL` 结算失败的 `assistant/attempt`，保存诊断流。正式 Assistant 消息、审批请求和工具正文调用的新增数量均为零

#### Scenario: 空响应正常停止
- **WHEN** Agent 收到 `stop`，且 Attempt 完全没有内容块
- **THEN** Agent 以 `EMPTY_RESPONSE` 结算失败的 `assistant/attempt`，流记录保留已交付的用量。`stop` 带有可用正文或推理等允许的内容块时可结算为正式消息

#### Scenario: 工具批次结束后需要续答
- **WHEN** 当前 Step 的工具结果和 `step/end` 已持久化，且没有结束 Turn 的条件
- **THEN** 系统先等待下一步的 pre-step，再开启新 Step、准备 Attempt；请求从压缩后的当前 surface 派生，未被合法替换的 Assistant 文字、调用与结果按原顺序保留

#### Scenario: 循环预算耗尽
- **WHEN** Turn 达到配置的最大模型步数
- **THEN** 系统结束本轮并记录预算耗尽原因，不再调用模型或工具

### Requirement: 统一模型运行入口
`LlmRuntime` SHALL 解析、校验调用配置并选择 Adapter。Adapter SHALL 将统一消息、工具定义和生成参数转换为 Provider 请求，并将响应转换为统一流及结束原因。每个 Provider 配置一个服务入口，入口与鉴权从后端配置取得。准备、发送和生成期间 SHALL 使用一致的配置快照。凭据 SHALL 不进入历史、前端或普通日志。接入层 SHALL 不修改会话事实、不执行工具或自行推进 Turn。

#### Scenario: Provider 请求格式不同
- **WHEN** 相同的统一请求交给不同 Provider 接入实现
- **THEN** 各自序列化为 Provider 支持的字段，执行层无需依赖其 HTTP 或流协议细节

#### Scenario: 请求期间配置改变
- **WHEN** 请求准备完成后、发送前或生成期间，凭据或生成配置发生变化
- **THEN** 本次请求及同 Step 恢复重试继续使用该步快照；新配置从下一 Step 生效并由 `request/header` 记录，模型输入包含从同一会话当前前缀派生的历史

### Requirement: DeepSeek 流的结束边界

DeepSeek Adapter SHALL 暂存 Provider 的结束原因及最新用量，在 `[DONE]` 到达时按开启顺序交付 `block-end`、可用的最新 `usage`，最后交付唯一的 `finish`。`finish` 优先采用 Provider 明确给出的结束原因。缺少原因时，有至少一个工具块且所有工具块均结构完整则补为 `tool-calls`，其余情况补为 `stop`。在 `[DONE]` 前提前结束的流 SHALL 以 `STREAM_CLOSED` 失败。

#### Scenario: 缺少结束原因且工具块完整
- **WHEN** DeepSeek 交付了完整的工具标识、名称和原始参数字符串，随后发送 `[DONE]`，期间未给出结束原因
- **THEN** Adapter 先关闭内容块，交付可用的最新用量，再交付 `finish: tool-calls`。执行层继续执行工具校验和治理流程

#### Scenario: 缺少结束原因且响应为空
- **WHEN** DeepSeek 未生成内容块，未发送结束原因即发送 `[DONE]`
- **THEN** Adapter 交付可用的最新用量及 `finish: stop`，Agent 以 `EMPTY_RESPONSE` 结算失败 Attempt

#### Scenario: Provider 请求工具后在结束标记前断流
- **WHEN** DeepSeek 交付了工具参数和 `finish_reason: tool_calls`，在 `[DONE]` 前提前结束流
- **THEN** Adapter 报 `STREAM_CLOSED`，Agent 保存已收到的分片及失败原因。正式 Assistant 消息、审批请求和工具正文调用的新增数量均为零

### Requirement: 统一内容块流与结算记录

Adapter、Runtime 和执行层 SHALL 共用 `StreamChunk`。内容起止及文本、推理、工具增量 SHALL 按一次请求内的内容块索引关联。Attempt 结算 SHALL 从同一份分片数据组装 Assistant 内容并保存可安全记录的紧凑流。紧凑流 SHALL 可恢复原顺序、分片边界和相对时序。现有记录 SHALL 按原值读取。

#### Scenario: 文本、推理和工具分片交错到达
- **WHEN** 同一模型请求的不同内容块交错产生 `block-start`、增量与 `block-end`，随后交付 `usage` 及 `finish`
- **THEN** 结算内容按块首次出现顺序组装，每块的首次 `block-end.block` 确定该块最终内容，工具参数保留原始字符串。展开紧凑流可恢复该次分片边界、顺序和时序

#### Scenario: 块关闭携带完整内容
- **WHEN** 同一内容块的首次 `block-end.block` 与此前累积的增量不同，或关闭后继续收到该块的增量或重复关闭
- **THEN** 组装结果采用首次关闭携带的完整内容，正常结束时据此写入正式消息。紧凑流保留可安全记录的实际分片

#### Scenario: 完整内容块之后仍在生成
- **WHEN** 当前请求发出工具块的 `block-end`，但尚未收到模型 `finish`
- **THEN** Attempt 保持活动，工具正文的调用次数仍为零

#### Scenario: 重开包含两种紧凑流表示的历史
- **WHEN** 会话同时包含旧分片表示和统一内容块分片的结算记录，随后重新打开
- **THEN** 两种紧凑流均按原值读取并可用于诊断，模型历史依据正式消息与工具配对重建

### Requirement: 模型流失败归一化
Adapter SHALL 将厂商协议或传输失败表示为带稳定代码的 `LlmError`。缺少协议要求的结束标记用 `STREAM_CLOSED`，网络异常用 `TRANSPORT`，请求等待或流空闲超时用 `TIMEOUT`，调用方取消用 `ABORTED`。

`LlmRuntime` SHALL 将 Adapter 异常归一为一个终止 `finish` chunk。失败使用 `reason.kind: "error"` 和 `failure: { code, message }`，调用方取消使用 `reason.kind: "aborted"`。失败可附 HTTP 状态、Provider 请求 ID 或建议重试间隔。诊断信息 SHALL 排除凭据及敏感数据。

#### Scenario: 流提前结束且缺少必需结束标记
- **WHEN** Adapter 已收到部分文本，但 Provider 流提前结束且缺少协议要求的结束标记
- **THEN** Agent 收到 `STREAM_CLOSED` 错误终止，保存失败的 `assistant/attempt` 和紧凑流，结束本轮，不追加正式回答或自动重试。追加成功后实时 `end: committed` 引用该失败事件

### Requirement: 模型请求错误与资源清理
模型接入层 SHALL 区分鉴权、限流、网络、协议、请求超时、上游取消及明确的输入上下文超限，后者使用稳定分类 `CONTEXT_WINDOW_EXCEEDED`，不与输出截断混同。诊断 SHALL 不泄露秘密。请求级超时 SHALL 与 Turn 步数预算分别执行，不新增压缩总时长限制；取消 SHALL 传播至实际请求和流读取。提前停止消费 SHALL 释放底层流、计时器和监听器。Runtime 和 Adapter 的单次调用 SHALL 只发起一次请求，并关闭 SDK 的隐式重试。

#### Scenario: 用户取消流式请求
- **WHEN** 上游取消当前模型请求
- **THEN** 实际网络请求和读取被中止，执行层收到取消类别而非普通 Provider 失败，不再收到清理后的迟到输出

#### Scenario: 请求等待或流空闲超时
- **WHEN** 已配置的请求等待或流空闲预算耗尽
- **THEN** 接入层传播取消并报告可区分的超时，释放资源，不自行重新发起请求

#### Scenario: 调用方提前停止消费
- **WHEN** 调用方在流自然结束前退出迭代
- **THEN** 接入层取消底层请求并完成流清理，不留下后台持续读取或未处理异常

### Requirement: 持久化检查点失败的 Turn 结算
后台排空写入失败时，系统 SHALL 记录服务端警告并保留原缓冲批次。执行检查点的 `flush()` 失败并传播到 Agent 时，Agent SHALL 将其归一为 `AgentError`，发出 `agent/error`，并在 Turn 的 `finally` 追加一个失败的 `turn/end`。失败记录 SHALL 保存 `reason: { kind: "error", error: { code, message } }`，无稳定分类时使用 `UNKNOWN`。

#### Scenario: 首次模型请求前检查点失败
- **WHEN** 当前 Turn 的 `flush()` 失败
- **THEN** Agent 阻止模型请求，发出错误事件并追加失败终态。终态进入普通持久化缓冲，存储仍不可用时保留供后续排空

### Requirement: Turn 驱动按原因结算
Turn 驱动 SHALL 根据模型尝试与 Step 批次结果决定续答或终结。Turn 的持久终态由 `reason.kind` 表达。

正常模型回答和工具批次主动结束均 SHALL 写入 `{ kind: "completed" }`。输出上限对应 `max-tokens`，用户取消对应 `aborted` 并携带取消原因，策略阻止对应 `blocked`，失败对应带结构化错误的 `error`，崩溃修复对应 `interrupted`。

#### Scenario: 模型正常回答且没有工具调用
- **WHEN** Attempt 正常结束且未请求工具
- **THEN** 系统保存 assistant 消息并以正常模型完成结算 Turn

#### Scenario: 工具批次结算后无需模型续答
- **WHEN** 当前 Step 的工具批次已完成，至少一个成功结果请求结束 Turn，且未触发取消或其他中止条件
- **THEN** 系统写入 `reason.kind: "completed"`，不再创建下一 Step 或发起模型请求生成总结

#### Scenario: 模型达到输出上限
- **WHEN** 当前 Attempt 因输出上限结束
- **THEN** 系统保存 Attempt 的截断记录和 output_limit 原因，随后以截断结算 Turn。本次 Attempt 输出的工具调用均不派发

### Requirement: Turn 记录与上下文持久化
系统 SHALL 保存用户消息、每个成功 Attempt 的 assistant 消息、工具结果和 Turn 终态。凭据 SHALL 不进入会话日志。

成功结算 SHALL 写入 `assistant/message.data`，包含 `turn`、`step`、`message`、`finishReason`、`stream`、`includeInModelContext: true` 及可用的 `usage`。消息 SHALL 携带稳定 UUID、有序内容块及模型来源。可展示的 reasoning SHALL 以独立内容块保存。完整 tool-call block 包含 `id`、`name` 和原始 `arguments`，同一消息内调用 ID 唯一。

#### Scenario: 中间消息包含文字和工具调用
- **WHEN** 当前 Attempt 成功产生文字及完整工具调用
- **THEN** 系统先将文字和调用一起保存为一条 assistant 消息，再进入工具阶段。该消息留在会话历史，Turn 继续处理工具

#### Scenario: 中间消息未能提交
- **WHEN** 含工具调用的 assistant 消息保存失败
- **THEN** 系统不将该消息结算为已提交，关联工具不进入审批或执行

#### Scenario: 检查一次工具回答
- **WHEN** 读取已结束的 Turn 记录
- **THEN** 能关联实际模型、Prompt、工具定义、生成参数和进入模型的工具结果，不依赖当前可变配置推断过去输入

### Requirement: 从 Assistant 结算前缀重建模型输入
每次请求 SHALL 重新从 surface 派生独立消息快照，再与生效的 `request/header` 合成输入。开始模型调用前 SHALL 确认这份配置及消息前缀已落盘。对已结算请求 SHALL 可以重放该 Assistant 结算位置之前的持久日志，派生消息并折叠生效 header，重建该次模型输入。

#### Scenario: 配置不变时发起下一次请求
- **WHEN** 同一消息系列内先后准备两次请求，期间只追加了消息，生效配置未变
- **THEN** 两次请求复用最近的 header，分别从各自的 surface 取得消息快照

#### Scenario: 历史和配置在请求后发生变化
- **WHEN** 记录请求 A 的结算后替换 surface、变更生成配置并结算请求 B，再重新打开会话
- **THEN** 按各自 Assistant 结算前的日志重新派生，得到与 A、B 各自构造时一致的消息、系统提示词、工具定义和生效参数

#### Scenario: 生成尚未启动时崩溃
- **WHEN** 生效配置和消息前缀已落盘，模型调用启动前进程崩溃
- **THEN** 重开后恢复已有配置和消息历史，关闭遗留执行范围，后端不会续跑该 Turn

### Requirement: 请求配置快照的字段
`request/header.data` SHALL 为 `{ header, reason, startsSeries? }`。`header` 包含 `config` 和可选 `adapterDefaults`、`system`、`tools`。`config` 保存 `provider`、`model` 及生效的可选 `reasoningEffort`、`temperature`、`maxTokens`、`stop`，来自 Adapter 模型信息的默认值另记入 `adapterDefaults`。`reason` SHALL 取 `initial`、`resume`、`change`、`series`。配置变化同时开启新系列时 SHALL 保存 `startsSeries: true`。

#### Scenario: 默认值与生效配置
- **WHEN** 调用方省略 `maxTokens` 和 `reasoningEffort`，Adapter 的模型信息提供可用默认值
- **THEN** 在 `config` 和 `adapterDefaults` 中保存补入的对应值。`temperature`、`stop` 保持原有取值或缺省。显式选择不支持的 `reasoningEffort` 时生成前报错

#### Scenario: 恢复或 fork 后的首次请求
- **WHEN** 新 Agent 从已有日志恢复或由 fork 创建，即使已有 header 与当前配置相同
- **THEN** 首次请求记录 `resume`，随后的相同配置在同一系列可复用

#### Scenario: 配置变化或开始新消息系列
- **WHEN** 已运行的 Agent 在下一次请求前观察到配置、系统提示词或工具 schema 变化，或发现 surface 替换开启新系列
- **THEN** 配置类变化记 `change`，同时开启新系列时附 `startsSeries: true`。配置保持相同时，新系列记 `series`

### Requirement: 已结算 Attempt 的流记录
系统 SHALL 在 Attempt 结算时保存对应的紧凑带时序流，用于重建和诊断。该流 SHALL 不重复派生模型消息，失败流 SHALL 不作为正式回答展示。未结算草稿 SHALL 不被承诺在进程硬崩溃后恢复，不要求逐 token 单独持久化。

结算事件中的 `stream` SHALL 保留统一 chunk 的边界、顺序和相对时序，供重放与诊断。

#### Scenario: 读取已结算流
- **WHEN** 重新打开包含已结算 Attempt 的会话
- **THEN** 能恢复其流内容和顺序，但模型历史中只出现按结算规则选择的消息，不因回放流重复添加消息

### Requirement: 取消与故障结算
系统 SHALL 支持按会话取消处理请求时的当前任务。`POST /api/sessions/:sessionId/cancel` SHALL 仅查找已挂载的 Agent。已挂载时返回 `202 { accept: true }`，并向活动 Turn 或手动压缩传播取消信号。已挂载但空闲时直接确认。未挂载时 SHALL 返回 `404 { code: "session/not-found" }`。

#### Scenario: 生成期间取消
- **WHEN** 用户在模型生成期间取消 Turn
- **THEN** 系统中止模型请求、停止后续工具调度并保存取消记录。有可展示的非空部分文字时随记录保存，刷新后标记为「已取消，回答未完成」。没有可展示文字时只保存终态，未完成工具参数不执行

#### Scenario: Provider 失败
- **WHEN** 当前模型请求失败
- **THEN** 系统保存失败结算。普通失败结束本轮，失败流不作为正式回答或模型历史

#### Scenario: 停止会话当前任务
- **WHEN** 已挂载 Agent 正在生成、处理工具或执行独立手动压缩，收到会话取消请求
- **THEN** 取消信号传给处理请求时的当前任务，接口返回 `202 { accept: true }`，最终结算由历史和 SSE 提供

#### Scenario: 取消空闲会话
- **WHEN** 已挂载 Agent 当前空闲
- **THEN** 返回 `202 { accept: true }`

#### Scenario: 会话没有已挂载 Agent
- **WHEN** 取消请求对应的会话没有已挂载 Agent
- **THEN** 返回 `404 { code: "session/not-found" }`，不为该请求创建 Agent

### Requirement: 输入上下文超限后的压缩重试
Adapter 明确报告输入上下文超限时，系统 SHALL 先保存失败的 `assistant/attempt`，再在原 Step 内保持 running 执行 context-overflow 恢复：直接尝试修剪，重测后仍不检查 80% 阈值，以 `retainTokens: 0` 选择安全前缀，存在范围时最多调用一次摘要。恢复前后的替换代数前进、未取消且检查点通过时 SHALL 才授权重试；修剪成功但后续摘要失败仍可满足替换条件。无替换时 SHALL 保留原业务请求错误，不重试。

默认 `maxOverflowRetries: 1` SHALL 限制一次连续超限期间最多一次业务请求重试，成功助手响应或 idle 后重置，不按整个 Turn 累计。立即重试 SHALL 留在同一 Step，重新派生消息并沿用本步配置，按请求 header 契约记录新系列且通过检查点，不再次运行 pre-step、不消耗新 Step。输出截断和普通请求失败 SHALL 不触发该恢复。

#### Scenario: 压缩后重试成功
- **WHEN** 初次模型请求因输入上下文超限失败，压缩成功并完成重试
- **THEN** 首次结算前缀重放出原消息，重试结算前缀重放出带摘要的消息。两次 Assistant 结算属于同一 Step，重试前不再次运行 pre-step。若两次都发出 `start`，其 `attemptId` 不同

#### Scenario: 估算低于阈值但 Provider 超限
- **WHEN** 窗口为 100000、估算压力为 70000，但 Provider 返回规范化输入超限
- **THEN** 仍直接尝试修剪，再按零保留预算选择安全前缀；有范围就摘要，不因估算低于 80000 跳过

#### Scenario: 修剪成功而摘要失败
- **WHEN** 恢复中的工具结果替换已提交，但后续摘要失败
- **THEN** 已有替换保留；未取消、预算尚有机会且检查点通过时，允许使用更新后的 surface 重试业务请求

#### Scenario: 没有替换或连续重试再次超限
- **WHEN** 恢复没有任何 surface 替换，或已授权的一次业务重试仍返回输入超限
- **THEN** 无替换时保留原请求错误，连续重试耗尽时按实际错误结束本轮，不无限恢复或再次运行 pre-step

#### Scenario: 同一 Turn 的后续 Step 再次超限
- **WHEN** 某 Step 的业务请求恢复重试成功并产生正常工具调用响应，随后进入新 Step 又遇到输入超限
- **THEN** 成功助手响应已经重置连续超限计数，新 Step 可取得自己的一次恢复重试机会；新 Step 的正常 pre-step 检查照常执行

### Requirement: 启动恢复的写入边界
系统 SHALL 持写入权结算中断的已持久化活动范围。启动修复 SHALL 保留既有结局，提交修复后才开放新任务准入。

#### Scenario: 启动阶段修复但不加载 Agent
- **WHEN** 服务启动发现未闭合的持久 Turn、压缩或本会话自有命令
- **THEN** 取得临时写入权后修复并持久化，释放临时资源，不创建 Agent、不续跑；查询历史无需先发送新消息，其他进程持有的会话不被修改

#### Scenario: 恢复未闭合压缩
- **WHEN** 系统取得会话写入所有权并核对已提交日志后，发现 `compaction/start` 没有对应终态
- **THEN** 按原 `compactionId` 写入 `compaction/end`，记录 `interrupted / process_interrupted`，再依次关闭实际打开的 Step 和 Turn。没有活动 Step 时不补造 Step。确认修复提交后重建 surface 和运行状态，再开放新任务

#### Scenario: pre-step 中断且下一 Step 尚未打开
- **WHEN** 已提交 Turn 和用户消息，或前一 Step 已关闭，pre-step 摘要开始后进程退出而下一 `step/start` 尚未追加
- **THEN** 先结算未闭合摘要，再只关闭实际打开的 Turn；不补造下一 Step。已有修剪及前一次成功摘要保持原样，恢复不请求模型

#### Scenario: 重启读到已结算的成功压缩
- **WHEN** 成功批次在进程退出前已提交，或对已修复会话再次执行恢复
- **THEN** 采用原终态及其持久日志，不重复追加结束事件或调用摘要模型

#### Scenario: 已提交压缩但命令终态缺失
- **WHEN** 本会话自有手动命令的压缩成功批次已可靠提交，但 `command/done` 尚未提交
- **THEN** 恢复采用已提交的成功压缩事实结算对应命令并引用摘要；不再次压缩或覆盖已有终态，修复不能可靠提交时保持存储阻塞

#### Scenario: 已提交压缩失败或取消但命令终态缺失
- **WHEN** 启动或在线恢复确认本会话自有命令的 `compaction/end` 已持久化为 `failed` 或 `cancelled`，但该命令尚无 `command/done`
- **THEN** 保留原压缩终态，按已知失败或取消补写一次 `command/done(kind: "error")`，结果文本表达对应结局，且不带成功事件引用。不重复执行压缩

#### Scenario: 命令尚无可靠结局
- **WHEN** 本会话自有的 `command/run` 已提交但没有 `command/done`，且没有可靠的关联压缩结局
- **THEN** 不推断命令成功或重新执行；在存储与原事务结论可靠后按中断事实修复，重复恢复不重复结算

#### Scenario: 子会话恢复遇到继承的命令运行记录
- **WHEN** 启动或在线恢复在继承前缀（`run.seq < inheritedEventCount`）看到缺少 `command/done` 的命令
- **THEN** 原样保留继承记录。子会话不补写父命令终态、不重新执行命令，也不将其视为自身的活动任务

#### Scenario: 重启时存在遗留工具调用
- **WHEN** 后端重启发现未结算的 Turn 及已发出但未确认结果的工具
- **THEN** Turn 标记为中断，为缺少结果的已声明调用补齐工具失败记录，不重新执行

#### Scenario: 工具请求已保存但尚未开始
- **WHEN** 取得写入权后，发现未闭合 Turn 中的 assistant 工具调用无结果且没有进入调度的调用记录
- **THEN** 按原调用标识保存 `isError: true` 的工具结果，`error.code` 为 `TOOL_NOT_STARTED`，模型内容说明进程中断且工具尚未派发，关闭遗留 Step 和 Turn，不执行工具

#### Scenario: 调度调用已保存但工具正文可能尚未执行
- **WHEN** 发现进入调度的调用记录而无结果，即使可能仍在等待审批，无法确认最终结局
- **THEN** 保存 `isError: true` 的工具结果，`error.code` 为 `TOOL_OUTCOME_UNKNOWN`。模型内容说明进程中断及结果未确认，已有调度记录不足以断定是否执行。若尚未生成操作则省略 `operationId`

#### Scenario: 重启时只保存了 Turn 或 Step 的开始
- **WHEN** 已提交前缀止于 `turn/start` 或 `step/start`，用户消息尚未落盘
- **THEN** 只关闭已经打开的范围，若 Step 已打开则先关闭 Step。Turn 结算为中断，不补写用户消息或登记其请求编号

#### Scenario: 恢复未决审批
- **WHEN** 持久日志有未闭合 Turn 及没有对应决定的 `approval/asked`
- **THEN** 恢复补齐对应工具结果并关闭实际打开的执行范围，保留 `approval/asked`。对应工具结果或 Turn 终态关闭待审批状态，迟到答复返回 `409 { code: "approval_not_active" }`

#### Scenario: 重复恢复与已有结果
- **WHEN** 再次加载已修复会话，或遗留 Turn 的部分工具已有结果
- **THEN** 已有结果保持原样，不重复追加修复；修复批次持久化失败时不发布恢复成功的会话

### Requirement: 遗留 Turn 的恢复与只读视图
系统 SHALL 以持久化 `assistant/message` 为工具调用声明，按 `(turn, step, callId)` 匹配调度和结果。持写入权的恢复 SHALL 按模型声明顺序补齐缺失结果，再关闭实际打开的 Step 和 Turn，作为一次写 handle 的 `append()`。只读查询可临时推导相同结局，`handle.read()`、HTTP 持久历史及其游标反映真实已提交前缀。

#### Scenario: 工具结果引用了未声明的调用
- **WHEN** 已持久化的 `tool/result` 在对应 Step 中找不到匹配的 assistant 调用声明
- **THEN** 报错并停止加载该会话，不补造调用、不写入修复记录

#### Scenario: 只读查看遗留 Turn 后执行写恢复
- **WHEN** 只读查询从已持久化前缀推导出中断状态，之后运行者取得会话写入权
- **THEN** 只读查询不产生持久事件或推进游标。写恢复仍从真实前缀计算并提交一次修复，重复恢复不再追加

### Requirement: 按 Attempt 结算筛选模型上下文
Attempt 结算 SHALL 区分 completed、cancelled、failed、truncated。持久记录 SHALL 以 includeInModelContext 明确是否允许该 Attempt 的输出进入模型上下文，并结合有序历史统一派生。正式消息可纳入；取消或截断的非空部分文字仅用于展示。失败只展示终态，诊断流不进入模型输入或正式回答。

非成功 Attempt SHALL 用 `assistant/attempt` 保存 `turn`、`step`、`outcome`、`reason`、`stream` 和 `includeInModelContext: false`。`outcome` 只取 `cancelled`、`truncated` 或 `failed`。仅取消或截断可另带非空的 `text`，其中截断的 `reason` 为 `output_limit`。

#### Scenario: 截断后刷新
- **WHEN** Attempt 达到输出上限且已有可展示的部分文字，用户随后刷新会话
- **THEN** 从持久结算记录恢复文字，标记为「输出截断」，其上下文属性为 false

#### Scenario: 取消或截断后提交新一轮输入
- **WHEN** 系统为取消或截断后的下一轮构建模型上下文
- **THEN** 排除该 Attempt 的部分输出，保留此前正式提交的 assistant 消息及与其工具调用配对的结算结果
