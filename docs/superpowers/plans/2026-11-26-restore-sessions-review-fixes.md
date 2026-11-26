# 会话目录第一批评审修复实施计划

> **执行方式：** 使用 superpowers:subagent-driven-development 和 superpowers:test-driven-development。独立复审通过后按用户授权直接执行。开发结束后固定差异，运行独立验证和两次只读审查。

**目标：** 修复 1.1、1.2 两轮代码审查发现的四个问题，并补足相关验收。
**架构：** 控制器管理每个会话 ID 的当前创建尝试与核实任务，应用关停时同步停止调度。SQLite 提供与原写事务身份绑定、独立于已关闭句柄的核实能力，并把坏检查点隔离到单条会话。
**技术栈：** TypeScript、Fastify、Node.js SQLite、Node.js 测试运行器、pnpm、OpenSpec。

---

现有分支 feat/restore-sessions-from-server，起始提交 4721d1f。现有未提交实现是本次输入。记录修改前工作区和审查树 d26806ff95c27dfbe311034a3830916386334d07，保留用户原有暂存、Web 和其他文档。原实施计划由本计划补充。范围限任务 1.1、1.2，POST 接受空对象且由服务端分配 ID，不引入公开重发键、页面防重或空会话复用。保存确认计数与 SSE revision 的区别保持原约定。

## A. 让坏检查点按单个会话降级

文件：packages/session/src/storage/sqlite-persistence.ts、packages/session/src/storage/sqlite-persistence.test.ts、apps/server/src/session/directory.ts、apps/server/src/session/directory.test.ts、apps/server/src/session/routes-acceptance.test.ts。

- [ ] 在已升级的真实临时库写入正常空会话、另一个正常会话，以及由独立连接写入超范围 SQLite 整数的检查点和零事件带活动时间的检查点。用生产应用重开并调用列表路由。坏项各自应为 blank false、updatedAt 等于自己的 createdAt；正常空会话仍为 true；结果含全部会话且 revision 不变。
- [ ] 运行 pnpm --filter @mharness/server exec node --import tsx --test src/session/directory.test.ts src/session/routes-acceptance.test.ts ../../packages/session/src/storage/sqlite-persistence.test.ts。预期超范围在读取检查点列时抛 ERR_OUT_OF_RANGE，零事件错误采用活动时间；按需用测试名分别验证红态。
- [ ] 在检查点 JOIN 选列通过 SQLite CASE 或等价方式将超范围值在 Node 解码前隔离，保留会话头和其他行。检查检查点的 safe integer 范围、零事件时 lastPromptAt 必须为 null、记录前缀和继承边界。后续检查点逻辑与普通会话元数据故障的处理保持现有语义。重跑同命令，预期新旧目录测试均通过。

## B. 为核实提供独立的新读与原事务证据

文件：packages/session/src/persistence.ts、packages/session/src/storage/sqlite-persistence.ts、packages/session/src/storage/sqlite-persistence.test.ts、packages/session/src/api/use-cases.ts、packages/session/src/server.ts、packages/session/src/storage/ownership.ts、packages/session/src/storage/ownership.test.ts，必要时同步更新测试替身。

- [ ] 用真实 WAL SQLite 和故障注入稳定制造旧读视图、会话头已提交但 flush 回执异常，使共享读取仍读不到头。用核实入口断言采用本次创建的已提交结果。另一用例使首次读缺失与原事务结束检测之间出现提交，验证第二次独立新读。新读故障或原事务仍未结束时应为未知，后续任务不能撤回。
- [ ] 运行 pnpm --filter @mharness/server exec node --import tsx --test ../../packages/session/src/storage/sqlite-persistence.test.ts src/session/routes-acceptance.test.ts。预期旧共享读不能可靠通过新回归。
- [ ] 在存储层提供首次创建专用的核实能力，绑定原创建事务而非后来由同一句柄或者其他句柄开启的事务。保留正常 close 语义以及原所有权令牌释放责任。核实先用新的只读连接/事务查询预期会话头；匹配则保存。读不到时先确认原事务终止，再用另一个新的 SQLite 已提交视图读取；仍无头才失败。任何读取不可用都保留未知。确保每个临时连接在成功及异常路径释放，普通 stat、历史读取和暂存语义保持不变。重跑同命令，验证旧读不会导致误撤回及原事务清理不影响后续事务。

- [ ] 区分原提交结果和写入权释放。用锁连接关闭故障验证：回滚/清理报错但所有权已证实释放时可以按未提交终态结算并开放同 ID；锁连接关闭失败且无法确认释放时不得开放同 ID。由存储暴露真实释放证据，所有权释放只在关闭成功或证实已关闭后标记成功，重复调用不能因前次失败而虚报成功。即使写入权释放失败，已明确 flush 成功的请求仍返回 201。运行 pnpm --filter @mharness/server exec node --import tsx --test ../../packages/session/src/storage/ownership.test.ts ../../packages/session/src/storage/sqlite-persistence.test.ts src/session/routes-acceptance.test.ts，先证实旧行为失败，再验证锁故障解除或可证实已释放时恢复。

## C. 在控制器管理创建尝试和关停

文件：apps/server/src/commands.ts、apps/server/src/app.ts、apps/server/src/session/routes.ts、apps/server/src/session/directory.ts、apps/server/src/session/routes-acceptance.test.ts，所有直接注册会话路由的测试装配。以 rg -n 'registerSessionRoutes\(' apps/server/src 核对调用方。

- [ ] 用受控 flush 闸门测试并发同一创建意图只调用一次 create/flush。共享固定的预期头，明确同 ID 不同身份冲突。受控时钟验证 503 后重复调用复用原结果和唯一后台任务。确认失败且原事务及所有权释放后再次创建，阻拦旧结果对新尝试的确认或撤回。用独立测试验证匹配保存不改变 revision、失败只撤回一次。
- [ ] 在真实 Fastify 网络请求中让在途 POST 跨越 preClose 后进入 unknown，断言关闭完成、推进时间后无新定时器或读取。保留正在核实的读结果迟到测试，并验证关闭不合成 removed。逐个运行 pnpm --filter @mharness/server exec node --import tsx --test src/session/routes-acceptance.test.ts，记录重复创建和穿越关停的失败。
- [ ] 在 SessionCommandController 或其持有的创建模块中于准备写入前按 ID 登记尝试对象，尝试对象持有不可变 header、写入 Promise 与核实任务。目录只接受当前对象的终态；核实前、应用终态前检查当前对象和关停状态。已确认提交且关闭出现异常仍返回 201。未知时共享 503 结果并保持登记。只有确认未提交、应用一次撤回且写入权已释放才清除位置允许同 ID 开始新尝试。翻转关停标志与取消计时器在同一同步阶段，已经启动的核实不得开启下一轮或应用结果。把路由变薄，保留 HTTP 契约及无 Agent 加载。重跑同命令，预期验收通过。
- [ ] 在真实 GET 路由用可控的清单读取挂起和已加载 Agent 验证运行、维护、活动时间更新被正确纳入，且不会调用 load、读取事件正文或写存储。若验收意外失败，按规格只修涉及路径，保留双窗口首次 GET 仅一条的既有回归。

## 独立验证及审查

- [ ] 主代理独立运行 pnpm typecheck、pnpm --filter @mharness/server test、openspec validate restore-sessions-from-server --strict，并检查包含未跟踪源码的固定差异格式。
- [ ] 核对中文 JSDoc 中的写入、共享 Promise、关闭与资源契约，确保 TypeScript 未使用 any。记录各回归的预期失败和通过结果。
- [ ] 对同一固定差异运行项目审查与 Codex 原生审查，报告重叠和独立发现。保留未完成的 OpenSpec 待办，根据审查结果暂停给用户决定后续。
