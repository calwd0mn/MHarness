# Session 内存事件日志实施计划

本计划对应 `agent-harness-prototype` 的任务 **1.5**。验收依据为 `tasks.md` 的 1.5、1.17、3.8，`design.md` 的 §1.3、§2、§3、§4.2、§5，以及 `agent-execution` 中的「不可变追加日志」和「通知与持久化分离」。

## 范围与代码落点

| 位置 | 实施内容 |
| --- | --- |
| `packages/session/src/events.ts` | 维护 Session 内部事件的纯数据契约和追加边界校验。 |
| `packages/session/src/session.ts` | 实现内存日志、范围快照、继承边界、Session 准备与发布和类型化通知。 |
| `apps/server/src/session/session-log.test.ts` | 用现有 `node:test` 测试入口覆盖 Session 核心行为。 |
| `docs/00-dsh-design-decisions-for-own-project.md` | 补充针对固定提交的实际映射和差异，记录对应源码位置。 |

现有应用仍通过 `@mharness/session/server` 使用 SQLite `SessionStore`。本批在 Session 模块内验证新的内存核心，SQLite 接线由 1.9 完成。持久化接口归 1.8，surface 替换校验与消息派生归 1.6，选择 fork 锚点和跨模块发布归 1.7。

## 实施顺序

### 1. 记录参考映射并建立测试基线

- [x] 运行根目录类型检查和服务端测试。编写本批测试时沿用服务端现有 `node:test` 与 `tsx` 配置。
- [x] 按设计核对 DSH 提交 `d347e703908d0406b7a7ef80e3a0e594d86b2215` 中的 `packages/core/session` 和 Session 持久化相关模块。在映射说明中记录本项目的 Session 数据结构、事件命名、日志与快照接口，以及 `request/header`、消息和紧凑流的对应关系与取舍。

### 2. 实现有效事件追加及不可变快照

- [x] 先写拒绝用例。追加一条有效事件，再尝试追加含循环引用或无法无损保存为 JSON 的值的事件，最后再追加有效事件。确认测试能发现无效事件被接受或消耗序号的问题，随后实现追加边界，使日志只保留 `seq=0`、`seq=1` 两条有效事件。
- [x] 补测并实现数字边界及快照所有权。检查 `createdAt`、`time` 和事件序号为非负安全整数，调用方修改原输入后日志仍保留接受时的值，已接受事件及嵌套数据递归冻结。
- [x] 补测范围读取。对包含三个事件的日志读取 `[1,2)`，返回一条事件，快照 `cursor` 仍为 `2`，`session.seq` 为 `3`。空日志的 `cursor` 为 `-1`、`session.seq` 为 `0`。读取前后验证日志和序号不变。
- [x] 按 1.17 和 3.8 校验事件样本。覆盖 `request/header`、带 `requestId` 的真实用户消息、Assistant 调用声明、`tool/call` 的原始标识与参数、`tool/result` 的来源引用以及审批事件字段。用重放测试验证未知事件类型被拒绝。

### 3. 实现准备、发布与同步通知

- [x] 写测试验证准备中的 Session 在发布前不可查询，发布后首次查询可读到完整初始快照。用同一套事件追加逻辑构造初始日志和后续事件。
- [x] 写测试验证成功追加后同步通知，监听器可以读取已接受事件。覆盖本次分发的监听器快照与注册顺序、解绑后停止接收后续事件，以及单个监听器抛错可观察且其余监听器照常执行。
- [x] 在监听回调中尝试再次追加，验证重入被拒绝且只留下外层有效事件。补充断言，确认第 2 步的无效追加不会发布通知。

### 4. 实现继承与自有事件边界

- [x] 以给定父日志前缀为测试输入。设 `cut=10`，子会话保留 `0..9` 的事件值、原序号和关联，`inheritedEventCount=10`，第一条自有事件 `session/end-seed` 的 `seq=10`。
- [x] 用含祖先 `session/end-seed` 的嵌套继承样本验证当前子会话按自己的 `inheritedEventCount` 划界。验证继承事件和子标记随初始快照交付，后续订阅追加时不重复收到它们。

### 5. 复验并更新 OpenSpec 进度

- [x] 按 `jsdoc-contracts` 为本次改动涉及的 API 维护中文 JSDoc，核对追加失败、快照所有权、游标、通知时序和解除监听的语义。TypeScript 使用明确类型，事件校验不引入 Cordis。
- [x] 每组测试先确认因目标行为缺失而失败，再实现并重跑。若现有行为已让测试通过，记录已满足的场景，继续验证其余断言。
- [x] 完成后运行以下命令，核对 1.5 的所有验收项及 DSH 映射，再勾选 `tasks.md` 中的 1.5 并记录本轮结果。

```powershell
# 从仓库根目录运行，第一条用于单独迭代新增测试
pnpm --filter @mharness/server exec node --import tsx --test src/session/session-log.test.ts
pnpm --filter @mharness/server test
pnpm typecheck
openspec validate agent-harness-prototype --strict
```

## 验证结果

本轮新增 7 个 Session 日志测试，服务端共 22 个测试通过。全仓类型检查和 OpenSpec 严格校验通过。中文 JSDoc 已按实现人工核对。

DSH 映射见阅读笔记第 8 节。正式 SQLite 接线按任务 1.9 验收。

## 后续任务 1.20：类型化 Session.append

- [x] 在 `packages/session/src/events.ts` 从现有共享事件 Schema 推导追加输入，按事件 `type` 约束 `data`，区分调用方提交的输入和 Session 分配序号后返回的记录。已有的可选时间和 surface 字段按事件约定保留。
- [x] 在 `packages/session/src/session.ts` 用该输入类型约束 `Session.append()`，同步中文 JSDoc。保留追加的运行时校验、快照及发布时序。恢复路径继续把原始记录作为未知值校验，并核对原有序号。
- [x] 在 `apps/server/src/session/session-log.test.ts` 增加编译期验收样例。合法的 `tool/call` 可追加，字段错配、缺失 `callId` 或由调用方指定 `seq` 时，类型检查应报错。保留故意传入无效数据的运行时测试，验证拒绝后日志、序号和通知均未受影响；回归未知事件和序号不连续的重放场景。
- [x] 运行 `pnpm typecheck`、`pnpm --filter @mharness/server test` 和 `openspec validate agent-harness-prototype --strict`，通过后勾选 OpenSpec 的 1.20。

1.20 的验证结果：新增用例在旧接口下因三处预期错误未触发而无法通过类型检查。实现后全仓类型检查、服务端 23 个测试及 OpenSpec 严格校验均通过，中文 JSDoc 已按实现人工核对。
