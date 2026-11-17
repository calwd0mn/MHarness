# Spec Delta

## Purpose

让用户通过前端观察 Agent 的文本生成、工具执行、审批及终态，并在刷新、重连或切回会话后恢复在线会话记录与仍活跃的回答草稿，明确区分暂态输出、最终记录与连接状态。

## ADDED Requirements

### Requirement: Turn 的流式展示
系统 SHALL 通过 SSE 展示与 `turn` 关联的文本增量、工具状态、审批请求和 Turn 终态。未结算的文本 SHALL 作为暂态展示。原始 `event` 帧 SHALL 交付 live Session 已接受的事件，可先于落盘交付。首版 SSE SHALL 不传递逐条保存状态或持久化游标。

#### Scenario: 追加完整回答后显示正式消息
- **WHEN** 完整回答已进入 live Session，持久化仍未确认
- **THEN** 前端根据结算帧和原始事件替换暂态文本，HTTP 持久历史仍只返回已确认前缀

#### Scenario: 工具批次结束后无模型续答
- **WHEN** Turn 因工具批次的 concludeTurn 意向而完成
- **THEN** 前端展示已有的 assistant 消息、工具结果和 Turn 终态，无需等待额外的 assistant 消息

#### Scenario: 输出达到上限
- **WHEN** Turn 以输出截断结算
- **THEN** 前端从原始结算事件展示可用的部分文字及「输出截断」标记，同进程重连可从快照恢复

### Requirement: 订阅与 Turn 生命周期独立
系统 SHALL 由持有数据库实例锁的在线后端通过会话级 SSE 订阅提供实时 follow。成功的订阅先发送全量 snapshot，再按序交付原始 `event`、通用 `agent/error` 及封装于 `assistant-stream` 的 start、chunk、end。订阅同步故障通过终止 `error` 报告。建立或关闭订阅 SHALL 不启动或取消 Turn。独立只读进程 SHALL 仅查询已提交历史。

#### Scenario: 浏览器断开
- **WHEN** Turn 仍在进行时，会话的 SSE 连接关闭
- **THEN** 后端继续处理该 Turn，用户可重新读取历史和 Turn 状态并订阅后续事件

#### Scenario: 活动草稿仅由在线后端提供
- **WHEN** 在线后端仍在生成，客户端重新连接该后端，同时有独立只读进程查询同一会话
- **THEN** 重连快照包含当前活动草稿，只读查询仅返回已提交前缀，不提供实时订阅或草稿基线

#### Scenario: 只订阅尚未加载运行对象的会话
- **WHEN** 用户仅查看持久历史并建立订阅，没有提交新消息
- **THEN** 系统不为订阅创建 ReActAgent 或请求模型，创建观察连接也不取得 Agent 的运行职责。初始快照从只读持久化句柄读取已提交前缀

#### Scenario: 断线期间已经完成
- **WHEN** 用户重新打开会话，断线时的活动 Turn 已结束
- **THEN** 前端从 follow 快照重建 Turn 的结果与终态，不依赖曾经收到 SSE 完成事件

#### Scenario: 独立压缩期间观察会话
- **WHEN** Agent 处于 `maintenance` 并等待摘要结果
- **THEN** 历史查询与 follow 可继续读取已确认的会话事实，观察操作不会改变维护任务的执行占用

### Requirement: 快照初始化与当前会话订阅
首次打开、重连及切回会话时，实时页面 SHALL 建立 follow，以首帧 snapshot replace 重建视图后顺序消费后续帧，不额外 GET 首屏历史，不将旧草稿与新快照拼接。第一版 SHALL 只订阅当前选中会话；切走关闭订阅，切回重新订阅，不取消后端 Turn。快照 SHALL 包含完整原始事件前缀，分页后置。

#### Scenario: 切回已关闭订阅的会话
- **WHEN** 用户切回此前已释放订阅的会话
- **THEN** 新建 follow，以新快照重建历史及活动草稿，不使用旧连接游标或旧草稿拼接接续，不额外请求首屏历史

#### Scenario: 等待新快照
- **WHEN** 新订阅尚未成功安装 snapshot
- **THEN** 可显示该会话旧缓存并标明正在同步，但不将缓存作为新连接基线；成功后整体以新快照为准

### Requirement: 通过响应或会话原始事件确认受理

前端首次发送 SHALL 生成 `requestId`，同一次提交重发 SHALL 复用，修改内容或主动再发 SHALL 使用新编号。前端 SHALL 以 `{ accepted: true }` 或当前订阅中同编号的本会话自有用户追加事件确认受理。fork 继承消息保留原编号，只有 `event.seq >= inheritedEventCount` 的真实用户追加事件可用于子会话受理确认。正式消息 SHALL 替换其发送占位。

#### Scenario: 响应丢失后重发原编号
- **WHEN** 后端已在 live Session 受理，浏览器未收到响应并重发原编号
- **THEN** 响应或对应的自有用户消息可确认受理，页面只显示一条正式消息，Turn 只启动一次

#### Scenario: 自有消息先于响应
- **WHEN** 同编号的自有用户消息先到达，之后才收到受理响应
- **THEN** 页面用正式消息替换占位，迟到的响应不再添加消息或撤销受理

#### Scenario: 继承消息与子会话提交复用同一 requestId
- **WHEN** 子会话的继承前缀中含某个 requestId，并以该编号提交子会话自己的消息
- **THEN** 客户端按本子会话的 inheritedEventCount 排除继承事件的受理确认，子会话自有的同编号消息仍可确认提交

#### Scenario: Agent 非空闲时收到新编号
- **WHEN** 提交新编号收到 `agent_busy`
- **THEN** 页面提示等待或在可取消时取消当前 Turn，不把新提交显示为已受理

### Requirement: 订阅代次隔离
前端 SHALL 为每次订阅和自动重连分配新 subscriptionGeneration，回调捕获代次及 sessionId。切换、重连或释放 SHALL 先使旧代次失效再取消连接。所有回调 SHALL 先验证代次和会话再检查状态，异步等待后及状态提交前再次验证。旧代次 SHALL 只能清理自身资源，不修改新订阅状态或发起重连。代次 SHALL 与 cursor、revision 分开。

#### Scenario: A 的快照在切换 B 后迟到
- **WHEN** 用户已切换到 B，而 A 的 snapshot 此后才到达或完成异步构建
- **THEN** A 的回调不提交窗口、草稿或基线，不改变 B 的画面和同步状态

#### Scenario: 新连接建立后旧连接报错
- **WHEN** 新代次连接已建立，旧代次随后触发错误或关闭
- **THEN** 旧回调直接忽略，不清空新订阅、不覆盖错误状态，不触发当前订阅重连

#### Scenario: 旧定时器或延迟任务触发
- **WHEN** 已失效代次的重连定时器、延迟渲染或异步回调恢复执行
- **THEN** 任务不修改当前状态、不创建连接，也不清理新代次持有的资源

### Requirement: 串行业务帧处理与原子快照安装
业务帧 SHALL 按接收顺序进入单一串行消费流程，不能仅保证接收有序而并行修改状态。snapshot SHALL 先完成校验和新窗口、cursor、revision、Attempt、nextIndex 构建，再一次提交，失败时保留旧缓存。只有安装成功后 SHALL 消费增量。心跳注释 SHALL 不算业务帧，终止 `error` 可以是首帧。

#### Scenario: 快照正在异步安装
- **WHEN** snapshot 已是本代次先到的业务帧，处理尚未完成时增量到达
- **THEN** 增量排队等候，快照成功整体安装后按序处理，不误判为首帧异常

#### Scenario: 增量确为首个业务帧
- **WHEN** 忽略心跳注释后，本代次收到的首个业务帧是普通增量
- **THEN** 判定协议异常，先使代次失效再关闭连接，按退避与上限重新 follow，不把增量应用到旧缓存

#### Scenario: 快照构建部分失败
- **WHEN** 窗口或任一基线字段的校验、构建失败
- **THEN** 不发布任何部分安装状态，不应用排队增量，保留旧画面并进入受限恢复流程

### Requirement: 有界退避重连

客户端发现协议缺口或连接意外断开时，自动重连 SHALL 使用集中配置的退避和有限次数。每次重连 SHALL 创建新代次并安装新快照。分配代次或建立连接 SHALL 不重置本次恢复的失败预算。达到上限 SHALL 保留现有画面、停止自动重连并显示同步失败。服务端明确发送终止错误时按终止错误规则处理。

#### Scenario: 服务端持续先发普通增量
- **WHEN** 服务端在每次连接都先发普通增量，未提供合法快照或终止错误
- **THEN** 每次异常在退避后才重试，达到次数上限后停止

#### Scenario: 重连已经建立但快照未安装
- **WHEN** 新连接已建立，且尚无成功安装的快照
- **THEN** 保留现有画面并标明正在同步，建立连接不重置失败预算

### Requirement: 活跃回答草稿恢复

快照 SHALL 包含会话 ID、`inheritedEventCount`、完整原始事件前缀、游标和 Assistant 实时基线。有活动 Attempt 时 SHALL 提供其 ID、Turn、Step、完整 chunk 前缀和 `nextIndex`。`nextIndex` SHALL 等于 chunk 数。安装快照和消费增量时 SHALL 校验事件顺序、实时版本、Attempt 身份和分片顺序。

#### Scenario: 切回仍在生成的会话
- **WHEN** 用户切离正在生成回答的会话，后端生成更多文本后用户切回
- **THEN** 页面从快照恢复当前草稿，后续增量按分片序号接续，结算后只显示一条正式回答

#### Scenario: 快照截点前后都有更新
- **WHEN** 建立订阅时，快照截点前后均产生 Session 事件或 Assistant 实时帧
- **THEN** 截点前的数据由快照代表，截点后的更新有序跟随

#### Scenario: 客户端收到序号或实时帧不匹配
- **WHEN** 客户端发现事件序号缺口、实时版本缺口或 Attempt 的身份、范围、分片序号、结束序号不匹配
- **THEN** 当前有效代次保留画面并在关闭连接前失效，按有界退避重新 follow，以合法全量快照原子替换窗口

### Requirement: 原始事件传输与日志游标

HTTP 历史、SSE 快照和增量 SHALL 使用同一 `{ type: "event", event }` 封装。`event` SHALL 保留日志中的 `type`、`seq`、`time`、`data` 及实际存在的 `surfaceOp`、`sourceEventSeqs`。`time` 为 Unix 毫秒。HTTP 读取已提交前缀，follow 读取 live Session 已接受的前缀，未加载时取已提交前缀。首版历史与快照 SHALL 从 0 返回完整前缀，`cursor` 为末条原始事件的序号，空为 `-1`。

#### Scenario: 收到首条事件
- **WHEN** 客户端从空快照的 `cursor=-1` 收到 `event.seq=0`
- **THEN** 接受该事件并推进游标到 0。后续按同一规则接受 `cursor + 1`，已接收序号去重

#### Scenario: 原始请求和 fork 事件
- **WHEN** 历史包含 `request/header` 或 `session/end-seed`，并通过 HTTP 或 follow 读取同一前缀
- **THEN** 这些事件保留原字段及日志序号，后续事件在两处使用同一编号。父子会话按各自继承边界识别自有消息

#### Scenario: 压缩后重新打开会话
- **WHEN** 用户读取已提交摘要替换的会话或连接 follow
- **THEN** 同步窗口包含压缩和替换事件，聊天继续显示原始问答，模型历史可按 surface 派生摘要

### Requirement: Attempt 实时帧
每次模型请求 SHALL 拥有 Agent 生命周期内唯一的 `attemptId`。对外实时帧 SHALL 按实际发布顺序分配连续递增的 `revision`。`start`、`chunk`、`end` 均携带两者，`start` 和 `end` 还携带 `turn`、`step`。取得异步流对象并检查取消后，读取首个模型分片前发送 `start`。草稿的 `chunk.index` 从 0 开始，`end.index` 等于已发送草稿分片数。每次 `start` 后均有对应 `end`，包括零分片。发出 `end` 后停止该次增量。

#### Scenario: 按序交付模型增量
- **WHEN** Attempt 发出 `start` 后产生两个增量
- **THEN** 两个 `chunk` 的 `index` 分别为 0、1，随后 `end.index` 为 2，实时 `revision` 连续

#### Scenario: 内部事件穿插在草稿分片之间
- **WHEN** 统一流在两个草稿增量之间交付内容块边界，或在结尾交付 `usage` 与 `finish`
- **THEN** 实时订阅与快照活动草稿采用相同投影。实时 `revision` 和草稿 `index` 只按对外帧推进，`end.index` 及快照中的 `nextIndex` 等于各自已包含的草稿分片数

#### Scenario: 开始发布之前的失败或取消
- **WHEN** 输入准备或持久化检查点失败、取得流对象时同步抛错，或在 `start` 前已取消
- **THEN** 此次尝试没有实时 `start`、`chunk` 或 `end` 帧。若已发出 `start`，即使首个 chunk 前停止，也发送对应 `end`

### Requirement: Attempt 实时终结的追加结果
结算事件经 `Session.append()` 接受后，系统 SHALL 发送 `end`，其 `outcome` 为 `{ kind: "committed", eventType, seq }`。`eventType` 为 `assistant/message` 或 `assistant/attempt`，`seq` 是追加返回的内部事件位置，0 为有效引用。实时流结束且没有成功追加结算事件时，系统 SHALL 发送 `{ kind: "abandoned" }` 作为 `end.outcome`，该分支没有事件引用或具体失败原因。两种分支只结算当前实时流，Turn 终态由自己的日志事件表达。

#### Scenario: 内存追加返回事件位置
- **WHEN** `Session.append()` 返回结算事件的内部序号，持久化检查点仍在等待
- **THEN** 立即发送引用该事件的 `end: committed`，后续不再发送该 Attempt 的 chunk

### Requirement: Assistant 实时流与原始事件交接

已开始实时流的结算被 Session 接受后，follow SHALL 交付其原始事件及 `end: committed`。客户端 SHALL 用 `attemptId` 定位草稿，按 `end.outcome` 引用的事件类型和 `seq` 与原始事件匹配，并核对 Turn 和 Step。两帧任一先到均可暂存，齐备后只替换一次草稿并保留 UI 节点身份。快照已有结算时直接从事件恢复，实时基线覆盖截点前的 `end`。

#### Scenario: 内存追加后先结束实时流
- **WHEN** 含正文和工具调用的 Assistant 消息已追加，且 `end: committed` 先送达
- **THEN** 前端暂存结束信息，收到其引用的原始事件后替换草稿。工具执行仍遵循检查点

#### Scenario: 原始结算事件先到
- **WHEN** 与活动草稿同范围的 Assistant 结算事件先到
- **THEN** 事件按其 `seq` 推进游标，页面等待同序号、同类型的 `end` 交接。下一次 `start` 或所属 `turn/end` 到达仍缺一帧时，客户端按协议缺口处理

#### Scenario: 未追加结算事件
- **WHEN** 已开始实时发布的 Attempt 未能追加结算事件
- **THEN** 服务端发送无引用的 `end: abandoned`，客户端清除暂态草稿

#### Scenario: 开始发布前结算或同进程重连
- **WHEN** Attempt 在 `start` 前结算，或同进程重连的快照已覆盖该次结算
- **THEN** 客户端直接使用原始事件构建视图

### Requirement: 执行检查点失败的通知

持久化检查点失败 SHALL 阻止依赖该检查点的后续执行。已经接受的事件及 `end: committed` SHALL 保持有效。检查点失败导致 Turn 停止时，后端 SHALL 发出 `{ type: "agent/error", turn, message }`，其中 `message` 是安全文案，再追加失败 `turn/end`。即时通知 SHALL 不推进日志游标或 Assistant revision。后台写入失败只记录服务端告警并保留缓冲。

#### Scenario: 完整回答已展示后执行检查点失败
- **WHEN** 前端已收到结算事件，随后模型请求或工具正文前的检查点失败
- **THEN** 后续请求或工具正文不启动。已展示答案仍可从同进程 live Session 读取。前端显示 `agent/error` 的即时反馈和 `turn/end` 的失败终态，订阅继续工作

#### Scenario: 压缩提交结果待核对或会话存储故障
- **WHEN** 压缩写入尚未确认或存储仍无法完成核对和修复
- **THEN** 前端可继续展示旧画面，后端不发布压缩成功或会话可接收新任务的状态

### Requirement: follow 终止错误

服务端检测到无法构建一致快照或待发送事件缺号时，SHALL 发送 `{ type: "error", error: { code: "follow_sync_failed", message, details } }` 并结束订阅。`message` SHALL 可安全展示。缺号的 `details` SHALL 包含 `expectedSeq`、`actualSeq`，快照失败时为 `{}`。客户端 SHALL 结束该代次，保留已有窗口并等待用户主动重试。

#### Scenario: 快照构建失败
- **WHEN** 已进入 follow，但服务端无法取得一致快照
- **THEN** 终止错误是该连接唯一的帧，客户端报告会话打开失败

#### Scenario: 服务端发现实时事件缺号
- **WHEN** 已发送至 `cursor=10`，下一条来源事件为 `seq=12`
- **THEN** 发送终止错误，details 为 `{ expectedSeq: 11, actualSeq: 12 }`。缺号事件未送达，客户端保留已有窗口和游标

#### Scenario: 客户端首先发现实时事件缺号
- **WHEN** 客户端已同步至 `cursor=10`，但直接收到 `event.seq=12`
- **THEN** 跳过该帧，游标留在 10，使当前代次失效，按有限退避重新订阅以获取全量快照

### Requirement: 审批与工具失败展示

前端 SHALL 从原始事件派生工具卡片及审批状态。`tool/call` 建立「准备调用」卡片并展示完整原始参数摘要，`tool/operation` 提供已校验参数。调用按 `(turn, step, callId)` 配对。`approval/asked` 通过 `operationId` 关联操作及确切参数，显示等待审批。相同 `approval/decided`、关联 `tool/result` 或所属 `turn/end` 关闭待审批状态。工具结果按 `isError`、模型可见内容、可用的错误码和 `meta` 重放。

#### Scenario: 等待审批
- **WHEN** Turn 进入等待审批状态
- **THEN** 用户能查看绑定操作的工具名、版本及完整已校验参数并同意或拒绝，刷新后从关联的原始事件恢复

#### Scenario: 刷新后展示工具超时
- **WHEN** 已提交的工具结果包含 `isError: true` 与 `TOOL_TIMEOUT`，用户刷新页面
- **THEN** 前端根据已保存内容重放工具超时，所属 Turn 终态从对应日志事件读取

#### Scenario: 调用进入调度但尚未执行
- **WHEN** 已收到 `tool/call`，或该调用正等待审批
- **THEN** 页面展示「准备调用」或「等待审批」，参数从对应调用或操作记录读取

#### Scenario: 恢复出尚未开始的工具调用
- **WHEN** 某条 Assistant 调用声明尚无 `tool/call`，恢复后收到匹配的 `TOOL_NOT_STARTED` 结果
- **THEN** 页面读取声明的工具名并建立「未开始」卡片

### Requirement: 模型分片与聊天展示

SSE SHALL 将模型增量投影为 `assistant-stream` 的 `text`、`reasoning` 和 `tool-call-delta`，活动草稿快照 SHALL 使用同一投影。工具的 `toolIndex` SHALL 按工具块首次出现的顺序从 0 分配。内容块边界、`usage` 和模型 `finish` 通过原始结算记录交付。Web SHALL 分别处理正文和 reasoning，reasoning 可折叠或隐藏。工具参数分片 SHALL 在数据层保留和累积。工具卡片和结算正文从原始事件派生。

#### Scenario: 模型生成工具参数
- **WHEN** 模型在正文、推理等内容块之后生成工具参数分片
- **THEN** 首个工具的 `toolIndex` 为 0，数据层按该工具索引累积，页面保留忙碌提示，直到 `tool/call` 到来才建立工具卡片

#### Scenario: 成功消息含 reasoning 或只有工具声明
- **WHEN** Assistant 消息带 reasoning 块，或内容仅包含工具调用声明
- **THEN** 前者可从正式消息恢复独立的 reasoning 展示，后者只保留调用关联数据

### Requirement: 一致且可访问的会话工作区

前端 SHALL 随系统明暗偏好提供一致的中性色工作区，使用清晰的文字层级、用户消息气泡、平面助手正文和紧凑工具展开行。控件 SHALL 提供可访问名称、清晰键盘焦点与文字状态反馈，状态变化不改变尺寸或圆角；必要操作在触屏可达，并遵循减少动态效果偏好。

#### Scenario: 系统切换明暗模式
- **WHEN** 系统从浅色切换为深色，或用户以键盘聚焦、禁用或提交控件
- **THEN** 页面和控件采用同一语义主题，常态、悬停、按下、聚焦、禁用、进行中和失败状态清晰，状态不只靠颜色表达

#### Scenario: 窄屏与低高度
- **WHEN** 页面位于窄屏、低高度或浏览器放大场景，且参数、代码或标签很长
- **THEN** 导航可折叠，正文、输入和审批操作仍可到达，长内容换行或在自身区域滚动，页面允许必要的滚动

### Requirement: 页面存活期间的会话编辑草稿

前端 SHALL 按会话隔离普通编辑草稿与待受理提交，在页面存活期间切换后恢复。流式更新 SHALL 不覆盖已输入内容或使输入框失去节点身份和焦点。刷新后的未发送草稿恢复不属于首轮保证。

#### Scenario: 切换后继续编辑
- **WHEN** 用户在 A 输入未发送文字，切到 B 编辑，再切回 A
- **THEN** A 恢复自己的普通编辑草稿，B 的草稿和待受理提交不被覆盖

#### Scenario: 编辑时收到模型增量
- **WHEN** 输入框正在编辑或输入法组合期间到达新的流式正文
- **THEN** 输入内容、焦点与输入节点保持稳定，提交继续遵循既有 requestId 受理规则

### Requirement: 安全的基础 Markdown 与代码复制

助手正文 SHALL 支持段落、标题、列表、引用、链接、行内代码与围栏代码；用户消息 SHALL 保持原文。原始 HTML SHALL 不执行，链接只允许 HTTP(S)、mailto 和页内锚点，其他目标与文件路径作为可读文字。未闭合流式结构 SHALL 保持可读且不使消息流崩溃，代码复制 SHALL 保留代码内容并反馈成功或失败。

#### Scenario: 不安全内容与链接
- **WHEN** 消息含原始 HTML、脚本链接、非允许协议或文件路径
- **THEN** 页面不执行 HTML 或脚本，不为非允许目标提供可执行链接，内容仍可阅读

#### Scenario: 未闭合围栏与复制失败
- **WHEN** 流式正文的代码围栏尚未闭合，或用户复制代码时剪贴板操作失败
- **THEN** 部分代码可读，复制失败有明确反馈；成功复制时内容与代码一致

### Requirement: 按会话保留消息阅读位置

消息区 SHALL 区分底部跟随与历史阅读状态。处于底部时新内容保持跟随；用户向上阅读后 SHALL 停止强制滚动，并提供返回最新内容操作。页面存活期间 SHALL 按会话记忆跟随状态与阅读位置。

#### Scenario: 生成时阅读历史
- **WHEN** 用户从底部向上滚动，随后收到正文分片或工具结果
- **THEN** 阅读位置不被强制拉回底部，用户可主动返回最新内容并恢复跟随

#### Scenario: 切回历史阅读会话
- **WHEN** 用户在 A 阅读历史，切到 B 后再次切回 A
- **THEN** A 恢复其阅读位置和跟随状态，不使用 B 的滚动状态

### Requirement: 通用工具视图遵循已有执行事实

前端 SHALL 展示完整原始参数、已校验参数、工具版本和可检查结果。相同 callId 在不同 Step SHALL 独立关联。tool/operation 不代表正文已执行，允许后无结果 SHALL 显示等待结果。成功、失败、取消、超时、未开始和结果未确认 SHALL 依记录区分；未知内容块和 meta 使用可检查的文字或 JSON，不执行其中的 HTML/代码、不重新渲染服务端工具或修改模型上下文。

#### Scenario: 不同 Step 重用调用编号
- **WHEN** 同一会话的不同 Step 使用同一个 callId，分别到达操作与结果
- **THEN** 两个调用独立显示，结果不会更新另一 Step 的卡片，快照与增量派生结果一致

#### Scenario: 已校验或已允许但没有结果
- **WHEN** 前端仅有操作事件，或审批允许后尚无结果
- **THEN** 显示已校验或等待结果，不显示正在执行或执行完成的未经证明状态

#### Scenario: 未知工具和展示数据
- **WHEN** 结果包含未知工具、内容块或 meta
- **THEN** 通用视图保留可检查内容，不依赖专属渲染器，也不执行展示数据

### Requirement: 审批决定的请求锁与权威收敛

首轮审批 SHALL 仅提供单次允许与拒绝。指针和键盘 SHALL 共用同一审批提交锁。200 或匹配的 approval/decided 确认决定；带已有决定的 409 SHALL 按服务端决定收敛。approval_not_active 或 404 SHALL 关闭无效交互，不伪造决定。网络结果未知 SHALL 保留待确认反馈，可重试相同审批 id 和决定；对应结果或 Turn 终态关闭交互。

#### Scenario: 指针与键盘重复提交
- **WHEN** 同一审批正在提交，用户再次点击或使用键盘答复
- **THEN** 不产生并发的重复答复；已确认决定不因迟到响应重新激活

#### Scenario: 冲突、失效和不存在
- **WHEN** 答复返回带相反决定的 409、approval_not_active 或 404
- **THEN** 前者展示服务端原决定，后两者关闭交互并解释失效或不存在，不保留相反的乐观结果

#### Scenario: 网络未知后由事件确认
- **WHEN** 请求结果未知后收到匹配 approval/decided，或对应工具结果、Turn 终态
- **THEN** 决定事件确认原审批，结果或终态关闭未结算交互；迟到回调不重新打开它

### Requirement: 审批回调归属与键盘边界

审批异步结果 SHALL 绑定会话、审批及请求身份，切换、替代或卸载后的回调不得修改其他交互或解锁新请求。同步未就绪或失败时 SHALL 保持历史可读并禁用审批，直到有效快照恢复。审批详情获得焦点时 Enter 单次允许、Escape 拒绝；输入框、IME、已消费事件及原生按钮按键 SHALL 保留自身行为。

#### Scenario: 会话切换后旧请求返回
- **WHEN** A 的审批提交未完成，用户切到 B 或审批被替代后旧回调到达
- **THEN** 旧回调不能修改 B 或替代审批的状态与请求锁

#### Scenario: 输入法与原生按钮
- **WHEN** 用户正在输入框或 IME 中按 Enter/Escape，事件已消费，或焦点位于原生按钮
- **THEN** 不额外触发审批快捷键；仅审批详情的有效快捷键答复一次

#### Scenario: 正在同步或同步失败
- **WHEN** 待审批历史仍可显示，但当前订阅没有有效快照或已同步失败
- **THEN** 决定操作不可用，历史内容保留，恢复有效快照后才可重新决定
