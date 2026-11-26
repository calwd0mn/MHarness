# Spec Delta

## ADDED Requirements

### Requirement: 服务端会话目录

`GET /api/sessions` SHALL 每次读取当前后端的已提交会话清单及可用检查点，再按会话 ID 合并身份兼容的在线会话状态和本进程仍在创建中的已注册会话，返回带有 SSE 覆盖进度的完整 `{ revision, sessions }` 快照。查询 SHALL 不写持久化存储、不读取事件正文、不加载 Agent、不派发目录 SSE，也不推进 `revision`。已提交清单读取失败时 SHALL 返回错误，空目录 SHALL 返回成功与空数组。

摘要包含 `sessionId`、`createdAt`、`updatedAt`、`running`、`blank`，分支可包含 `parentSessionId`。时间为 Unix 毫秒。列表 SHALL 按 `updatedAt` 降序排列，并列时按会话 ID 升序排列。查询 SHALL 保留读取期间发生的较新在线变化，尚未列入持久化清单的临时项仍由创建流程确认或撤回。

#### Scenario: 列出当前实例的会话
- **WHEN** 当前实例有已保存会话、已发布分支以及已注册但未提交的新会话，另一个实例使用独立存储
- **THEN** 目录返回当前实例的所有这些条目，且不包含另一实例的条目

#### Scenario: 没有会话
- **WHEN** 目录查询成功，且合并后没有已提交会话或本进程已注册的在线会话和创建临时项
- **THEN** 目录返回 HTTP 200、当前 `revision` 和空数组

#### Scenario: 查询发现已提交但未发布 Agent 的分支
- **WHEN** 查询从已提交清单发现一个尚未进入目录且没有在线 Agent 的分支
- **THEN** 每份查询快照各包含一条该分支的冷摘要且 `running: false`。查询不推进 SSE 进度，也不向其他窗口发出新增通知

#### Scenario: 未发布分支等待下一次列表查询
- **WHEN** 分支已提交但没有发布 Agent，且没有新的列表 GET
- **THEN** 后端不为补录该分支单独扫描存储或向窗口推送新增。下一次列表 GET 返回该分支

#### Scenario: 在线会话与已提交记录身份冲突
- **WHEN** 在线会话和已提交会话具有同一 ID，但创建时间、普通或分支身份、父会话 ID 或继承边界不兼容
- **THEN** 快照只返回该已提交会话的冷摘要，`running: false`，不混入冲突的在线投影。其他会话仍可列出

#### Scenario: 查询窗口纠正已有的冷摘要
- **WHEN** 两个窗口此前都用 `blank: false` 显示一个未选中的冷会话，之后窗口 A 发起查询，读到该会话有效的空检查点，且此间没有实时目录变更
- **THEN** A 用相同 `revision` 的新快照替换本地目录，并隐藏该会话。B 不收到查询触发的通知，在自己下次获取快照时校正

#### Scenario: 已提交清单读取失败
- **WHEN** 后端无法读取已提交会话清单，但仍有之前建立的内存目录
- **THEN** 查询返回错误，客户端保留已展示的目录供后续重试

### Requirement: 目录新增与创建失败撤回

会话注册进入目录后 SHALL 广播含完整摘要的 `api-session/added`，允许早于持久化。创建结果未知时，后端创建流程 SHALL 独立核实同一次创建的已提交状态，客户端断开后仍继续。只有会话头缺失且写入方确认原事务已经结束、未提交时，后端 SHALL 撤回临时项并广播一次 `api-session/removed`，携带必填的 `reason: "creation-failed"`。核实结果 SHALL 仅应用于仍待核实的同一次创建。单会话历史 GET SHALL 保持只读，不改变目录摘要、版本或核实状态。释放已保存会话的 Agent SHALL 保留目录条目。目录通知 SHALL 由后端状态派生，持久化仍由会话头及日志承担。

#### Scenario: 空会话可以在持久化完成前被发现
- **WHEN** 会话已经注册但会话头尚未提交
- **THEN** 订阅窗口收到 `api-session/added`，快照也包含该会话，且其 `blank` 为 true

#### Scenario: 已广播的创建最终失败
- **WHEN** 后端确认会话创建失败且会话头未提交
- **THEN** 后端从快照移除该条目并广播带 `reason: "creation-failed"` 的撤回通知，客户端按会话 ID 幂等移除。首次 POST 若已确认失败，返回 `500 { code: "session_creation_failed" }`

#### Scenario: 会话头已提交但关闭句柄失败
- **WHEN** `flush()` 已确认提交，随后 `close()` 失败
- **THEN** POST 返回 `201 Created` 和 `{ sessionId }`，后端保留同一条目并确认已保存，单独记录关闭错误，不启动核实，也不发送 `api-session/removed`

#### Scenario: 提交报错后需要核实
- **WHEN** 写入未能给出明确的提交结果
- **THEN** 后端使用新的 SQLite 读事务核实原会话 ID。响应前确认该次创建已提交时返回 `201 Created` 和 `{ sessionId }`。响应时仍无法确认则返回 `503 { code: "session_creation_unknown", sessionId }` 并保留临时项

#### Scenario: 客户端断开后继续核实
- **WHEN** POST 返回 `503`，且临时读取失败或无法排除原事务仍会提交
- **THEN** 即使客户端断开且没有后续请求，后端仍保留临时项并安排重试。确认已提交时保留原条目和版本。确认未提交时先移除临时项，再发布一次撤回通知并推进一个版本。重试次数本身不触发撤回

#### Scenario: 核实必须使用新的已提交视图
- **WHEN** 提交结果未知，先前的读事务可能仍持有旧快照
- **THEN** 后端以新的已提交视图核对本次创建身份。读不到会话头时，须先确认原写事务结束，再以新的已提交视图确认头仍不存在才撤回。读取失败或无法取得新的视图时保持待核实

#### Scenario: 同一创建尝试的并发调用及同 ID 重试
- **WHEN** 后端收到同一次创建的并发调用，或该尝试返回 503 后再次收到同一次调用
- **THEN** 复用原写入结果和至多一个后台核实任务。同 ID 的新尝试仅在确认旧尝试未提交且写入权已释放后才可开始。找到匹配的已提交头时确认原条目并保持版本，身份冲突不视为成功

#### Scenario: 关停期间创建核实返回或才变为未知
- **WHEN** 后端开始关停，而在途创建请求随后才得到未知结果，或已启动的核实随后返回
- **THEN** 不再调度核实，取消等待中的定时器，迟到的后台结果不确认保存、不撤回条目、不改变目录版本

#### Scenario: 旧读取或旧尝试迟到
- **WHEN** 提交前开始的历史 GET 在创建进入待核实后才返回 `404`，或某次核实返回时当前待核实的已是另一次创建尝试
- **THEN** 迟到结果不确认保存、不撤回条目，也不改变目录版本

#### Scenario: 已保存会话的 Agent 被释放
- **WHEN** 已保存会话的 Agent 退出注册表
- **THEN** 目录仍列出该会话，查询到的 `running` 为 false，也不以创建失败撤回该条目

### Requirement: 目录空会话状态由 Turn 派生

在线会话投影在没有 `turn/start` 时 SHALL 为 `blank: true`，一旦观察到该事件便保持 `blank: false`。首条 `turn/start` 追加到 Session 内存日志并获得 `seq` 时，目录 SHALL 在 `blank` 实际由 true 变为 false 时广播 `api-session/updated`，携带会话 ID、`blank: false` 和该条日志的 `seq`。更新 SHALL 无需等待 SQLite 提交。冷目录 SHALL 使用会话目录元数据检查点及其默认规则。客户端 SHALL 保留完整目录副本，侧栏只显示目录标为 `blank: false` 的会话及本窗口选中的空会话。

#### Scenario: 两个窗口看到同一个新会话
- **WHEN** 窗口 B 成功新建并选中一个空会话，窗口 A 正在查看其他会话
- **THEN** 两个窗口的目录副本均包含该条目，B 的侧栏显示它，A 保持原选择并隐藏它。若 A 刷新时共享提示指向其他会话或为空，A 仍隐藏该空会话

#### Scenario: 首次 Turn 让其他窗口显示会话
- **WHEN** 窗口 B 发出首条消息，Agent 先进入运行状态，首条 `turn/start` 随后追加到内存日志，SQLite 提交仍未完成
- **THEN** A 在仅收到 `running: true` 时仍隐藏该条目，收到带来源 `seq` 的 `blank: false` 后立即显示，当前选中项保持不变

### Requirement: 会话目录元数据检查点

后端 SHALL 保存已提交前缀的 `blank`、`lastPromptAt` 和事件数。默认累计 200 条已提交事件或首条待保存事件提交满 5 秒时触发保存。创建提交、已提交的 `turn/end` 和会话释放也 SHALL 触发保存。新空会话首次提交时 SHALL 保存 `blank: true` 和 `lastPromptAt: null`。保存检查点 SHALL 不推进 SSE 进度。

启动重建及列表查询 SHALL 用已提交元数据和检查点生成冷摘要，不读事件正文。检查点有效并覆盖当前已提交前缀时，目录 SHALL 采用其 `blank`，并取 `createdAt` 和 `lastPromptAt` 的较大值作为 `updatedAt`。后者为 `null` 时取 `createdAt`。缺少有效检查点、检查点落后或无法验证分支继承边界时，目录 SHALL 使用 `blank: false` 和 `updatedAt: createdAt`。

#### Scenario: 只有已提交会话头参与重建
- **WHEN** 后端在新会话头提交前崩溃并重启
- **THEN** 目录不包含该会话

#### Scenario: 首个 Turn 尚未提交时重启
- **WHEN** 新空会话的头及初始检查点已保存，首个 `turn/start` 已进入内存但尚未提交，后端崩溃并重启
- **THEN** 初始检查点仍覆盖当前已提交前缀，目录恢复为 `blank: true`，即使崩溃前曾广播 `blank: false`

#### Scenario: 首个 Turn 已提交但检查点尚未保存
- **WHEN** 旧检查点记录 `blank: true`，之后首个 `turn/start` 已提交，但后端在新检查点保存前崩溃并重启
- **THEN** 旧检查点落后，目录使用 `blank: false` 保留该会话的可见性，重建不读取该会话的完整事件日志

#### Scenario: 单条检查点内容无效
- **WHEN** 已提交会话的检查点包含超出安全整数范围的数值，或零事件检查点带有用户活动时间
- **THEN** 启动重建与 GET 仍包含该会话，以 blank 为 false、updatedAt 为 createdAt 生成冷摘要。其他有效会话不受影响，GET 不推进目录版本

#### Scenario: 旧会话缺少检查点
- **WHEN** 已提交会话没有可用的目录元数据检查点
- **THEN** 目录列出该会话并以创建时间参与排序，无需重放该会话的日志

#### Scenario: 冷分支的检查点缺少可验证的继承边界
- **WHEN** 已提交的冷分支有检查点，但无法验证它覆盖子会话自己的继承前缀
- **THEN** 查询按 `blank: false` 和 `updatedAt: createdAt` 返回该分支，不读取事件正文

### Requirement: 目录运行状态与错误通知

目录 SHALL 从当前 Agent 的公开状态计算 `running`。未加载、空闲及维护阶段均为 false。公开运行状态变化时 SHALL 发送 `api-session/status`。运行循环收尾结束才 SHALL 发布退出运行的 false。Agent 运行错误 SHALL 通过 `api-session/error` 发送可公开展示的错误文本，客户端只在已有会话对象上记录 `lastAgentError`。

#### Scenario: 生成失败后完成收尾
- **WHEN** 运行中的 Agent 报告错误，随后完成收尾并退出运行循环
- **THEN** 错误通知只更新已有会话对象的错误文本，随后的状态通知更新运行指示，错误通知不改变目录行或其排序

#### Scenario: 未加载或执行维护的会话
- **WHEN** 会话没有对应的在线 Agent，或 Agent 在执行维护
- **THEN** 目录返回 `running: false`

### Requirement: 用户消息推进目录活动时间

目录 SHALL 以 `createdAt` 初始化 `updatedAt`，当真实用户的 `user/message` 进入日志且消息时间更晚时，SHALL 推进 `updatedAt` 并广播 `api-session/activity`。客户端处理该实时帧时 SHALL 只接受更大的活动时间。安装完整快照时 SHALL 以快照值为准，并按与服务端相同的规则排序。

#### Scenario: 用户在另一个窗口继续对话
- **WHEN** 一个可见会话收到比当前 `updatedAt` 更新的真实用户消息
- **THEN** 其他窗口收到活动通知，更新该行时间并按新时间重排，当前打开的会话保持不变

### Requirement: 目录通知就绪帧与版本

Web SHALL 使用独立于聊天 follow 的目录 SSE。服务端 SHALL 完成监听器注册后，以 `{ "type": "api-session/ready" }` 作为首个业务帧。Web 收到就绪帧后 SHALL 请求全量 GET 快照。SSE 消息 SHALL 以 JSON `type` 区分帧类型，`api-session/added` 的 `summary` SHALL 是完整会话摘要，`api-session/removed` SHALL 携带会话 ID 与撤回原因。

目录 SSE 进度 `revision` SHALL 是实例内从 `0` 开始的非负安全整数。后端每产生一条实时目录变更，SHALL 在同一个更新点修改对应的实时状态、递增进度一次，并将该序号写入变更帧。列表 GET、就绪帧、运行错误、相同值的重复通知及未改变目录摘要的持久化确认 SHALL 保持当前进度。就绪帧和运行错误 SHALL 不带 `revision`。

#### Scenario: 新订阅就绪且无目录变更
- **WHEN** 新连接完成监听器注册，期间只有 Agent 错误或重复报告相同目录字段值
- **THEN** 就绪是首个业务帧，就绪和错误均不带版本，GET 的目录版本保持不变

### Requirement: 本地开发入口多路复用目录和聊天订阅

默认 Web 开发入口 SHALL 通过 HTTPS 与支持 HTTP/2 的浏览器协商 HTTP/2。目录 SSE、聊天 follow 和普通 API 请求 SHALL 保持同源并经开发代理转发。

#### Scenario: 三个标签页持续订阅时发送消息
- **WHEN** 同一浏览器通过默认开发入口打开三个标签页，每页选中会话并保持目录和聊天订阅
- **THEN** 任一标签页可发送消息并接收响应，无需关闭任何订阅；所有标签页继续接收目录和聊天更新

### Requirement: 目录快照与通知合并

启动或重连 SHALL 建立新的连接代次。安装本代次快照前，Web SHALL 保留已展示的目录并缓存本代次的目录变更。服务端返回 `revision: N` 时，快照 SHALL 已体现或覆盖截至 N 的实时目录变更。Web SHALL 使用本次有效查询的完整快照建立基线，即使其 `revision` 与前一次相同。Web SHALL 按接收顺序重放比快照进度更新的变更，重放成功后一次性发布合并结果并核对选择。安装后 SHALL 实时应用本代次的目录变更。重放和实时应用时 SHALL 忽略序号不高于当前进度的变更，下一条有效变更须连续。遇到缺号 SHALL 重新订阅并获取全量快照。旧代次的回调 SHALL 不修改当前目录。

#### Scenario: 持久化清单读取期间有实时变化
- **WHEN** 读取清单前 SSE 进度为 11，读取期间在线 Agent 进入运行状态并产生序号 12 的通知
- **THEN** 快照若返回 `revision: 12`，则当前在线状态已经体现在该会话的摘要里，Web 可安全忽略第 12 帧

#### Scenario: 重放或实时合并时发现缺号
- **WHEN** 已应用到版本 12，随后收到版本 14 的目录变更
- **THEN** Web 重新订阅并获取全量快照，未按连续版本应用该条变更

#### Scenario: 快照已经包含较早的状态变化
- **WHEN** GET 返回 `running: false`，且快照已经覆盖的一条 `running: true` 出现在缓存中或在快照安装之后才送达
- **THEN** 旧通知不覆盖快照，最终目录保持 `running: false`

#### Scenario: GET 截点后有目录变化
- **WHEN** 目录读取期间收到比快照 `revision` 更新的新增、状态更新或撤回通知
- **THEN** Web 在快照上按顺序重放这些通知，同一 ID 只有一个条目，已撤回的条目不被迟到快照恢复

#### Scenario: 断线期间错过通知或后端重启
- **WHEN** 目录连接断开，在重连前有跨窗口变化或后端进程重启
- **THEN** 新订阅重新获取全量目录，以当前进程的快照和本代次的更新收敛，忽略旧代次的请求和通知

#### Scenario: 重启后通知先于版本更低的新快照
- **WHEN** 旧连接最后展示的目录版本为 20，后端重启后，新连接先收到版本 1 的目录变更，随后 GET 返回版本 0 的快照
- **THEN** 等待快照期间页面继续展示旧目录并缓存版本 1 的变更，随后在版本 0 的快照上重放该变更，一次性发布版本 1 的目录并核对选择

### Requirement: 页面从服务端目录恢复会话选择

Web 启动时 SHALL 读取共享选中提示，并使用成功合并的服务端目录验证该提示，再经现有 follow 打开顶层会话。无有效提示时 SHALL 保持主区域空白。读取失败 SHALL 保留提示和已有目录并提供重试。用户在读取期间完成的新建或选中操作 SHALL 不被迟到的结果覆盖。单独的 follow 打开失败 SHALL 保留选中供重试。

#### Scenario: 刷新后恢复同一站点最后保存的选择
- **WHEN** 同一浏览器和站点的 A 先选 X、B 后选 Y，两个窗口均保持打开，Y 仍在服务端目录中且共享提示未被改写
- **THEN** A 仍显示 X，B 显示 Y，两个窗口各自刷新时均恢复选中 Y，在侧栏显示 Y 并通过 follow 首帧加载其历史，即使 Y 仍为空

#### Scenario: 无痕窗口首次打开
- **WHEN** 浏览器没有选中记录，当前后端已有历史会话
- **THEN** 页面自动显示非空会话，保持主区域空白，用户选中后才建立会话 follow

#### Scenario: 最新目录确认选中项失效
- **WHEN** 成功取得的最新目录确认选中 ID 已不存在
- **THEN** 页面回到空白页。若失效的是当前选择，将共享提示写为 `{}`。若失效的是启动时读取的提示，只在共享键仍对应该提示时写为 `{}`

#### Scenario: 目录读取或会话打开失败
- **WHEN** 目录读取失败或已选中会话的 follow 打开失败
- **THEN** 页面保留选中提示并提供对应重试，不因失败清理选中项

#### Scenario: 本页新建早于初始目录加载
- **WHEN** 页面等待目录时新建成功，随后收到不含新会话的旧快照
- **THEN** 页面保留本页确认的新建条目及当前选择，与后续通知或快照对账时按会话 ID 去重

### Requirement: 窗口独立选择与共享恢复提示

各窗口 SHALL 独立维护当前选择，并使用共享 `localStorage` 键 `mharness.sessions.current` 保存 JSON 选中提示。当前版本 SHALL 写入 `{ sessionId }` 或 `{}`。数据类型预留 `subagentAddress`，恢复和打开 SHALL 使用顶层 `sessionId`。当 `projectList()` 确认选中项有效且值已变化时，Web SHALL 立即写入。确认选择变为空时 SHALL 写入 `{}`。其他窗口对共享键的写入 SHALL 保持本页当前选择。

#### Scenario: 已确认的选择早于 follow 成功
- **WHEN** 用户切到另一有效会话或新建成功后自动选中，且 `projectList()` 已确认该选择
- **THEN** Web 立即保存 `{ sessionId }`，即使 follow 仍在加载或随后失败

#### Scenario: 常规目录或消息更新保持共享提示
- **WHEN** A 仍显示 X，B 已保存 Y，A 收到目录刷新、消息或运行状态变化，且 A 的确认选择值保持不变
- **THEN** A 继续显示 X，共享提示仍保存 Y

#### Scenario: 显式清空与旧键迁移
- **WHEN** 用户主动清除选择，或目录更新确认当前选中项变为空
- **THEN** Web 将共享键写为 `{}`。下次启动将其视为空选择，旧键的提示仅可在新键缺失时迁移

## MODIFIED Requirements

### Requirement: 快照初始化与当前会话订阅
首次打开会话、会话 follow 重连及切回会话时，实时页面 SHALL 建立 follow，以首帧 snapshot replace 重建视图后顺序消费后续帧，不额外 GET 首屏历史，不将旧草稿与新快照拼接。单会话 follow SHALL 只订阅当前选中会话；切走关闭订阅，切回重新订阅，不取消后端 Turn。快照 SHALL 包含完整原始事件前缀，分页后置。

#### Scenario: 切回已关闭订阅的会话
- **WHEN** 用户切回此前已释放订阅的会话
- **THEN** 新建 follow，以新快照重建历史及活动草稿，不使用旧连接游标或旧草稿拼接接续，不额外请求首屏历史

#### Scenario: 等待新快照
- **WHEN** 新订阅尚未成功安装 snapshot
- **THEN** 可显示该会话旧缓存并标明正在同步，但不将缓存作为新连接基线；成功后整体以新快照为准
