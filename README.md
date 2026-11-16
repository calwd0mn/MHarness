# MHarness

本地 Agent Harness 原型。开发环境需要 Node.js 24 和 pnpm 10。

```sh
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:5173` 检查前后端连接。开发服务把 `/api` 请求转发到 Fastify，页面通过健康检查契约校验 `/api/health` 的响应。

`pnpm typecheck` 检查全部工作区包的 TypeScript 类型。

## Session 模块

- 浏览器契约入口为 `@mharness/session/contracts`，共享原始事件 Schema、持久历史封装及 prompt 契约。
- `@mharness/session/server` 供后端装配 Session、SQLite 存储与启动修复。核心事件和持久化接口分别位于 `packages/session/src/events.ts`、`packages/session/src/persistence.ts`。
- 已绑定写入器按会话以 200ms 固定窗口串行追加事件。`session.flush()` 会立即排空缓冲并确认持久前缀；历史查询只读取已提交记录。后台写入失败后保留原批次，在显式 flush 或关闭时按事务结果处理。

## 新版会话存储

开发服务器可通过 `MHARNESS_SESSION_DB_PATH` 启用新版事件库。相对路径从仓库根目录解析。

```powershell
$env:MHARNESS_SESSION_DB_PATH = 'data/mharness-events.sqlite'
pnpm dev
```

新版模式提供会话创建、原始持久历史读取和启动恢复。空历史返回 `{"sessionId":"…","inheritedEventCount":0,"cursor":-1,"records":[]}`。正式 prompt 提交和 follow 接线分别由 Session 命令和 SSE 的后续阶段交付。

每个在线库由单个后端持有实例锁。实例和会话锁保存在数据库文件旁的 `<数据库文件名>.locks/` 目录，进程退出后会释放锁。锁文件保留供后继进程复用。

旧格式和未知版本的数据库会被拒绝。使用独立的新版路径，保留原有 `data/mharness.sqlite`。需要回到旧版开发接口时，停止服务，清除 `MHARNESS_SESSION_DB_PATH` 后重新启动。

## 旧版会话接口

开发服务器将持久记录保存在仓库根目录的 `data/mharness.sqlite`。
此数据库供单个后端实例使用。服务重启时，遗留的活动 Turn 会标记为中断，已发出但未确认结果的工具会记录为结果未知，待审批操作作废。

```powershell
$api = 'http://127.0.0.1:5173/api'
$session = Invoke-RestMethod -Method Post -Uri "$api/sessions"
$turn = Invoke-RestMethod -Method Post -Uri "$api/sessions/$($session.sessionId)/messages" -ContentType 'application/json' -Body '{"text":"你好"}'
$history = Invoke-RestMethod -Uri "$api/sessions/$($session.sessionId)"
```

- 创建会话返回 `201` 和 `{"sessionId":"…"}`，创建时不调用模型。
- 提交消息返回 `202` 和 `{"sessionId":"…","turnId":"…"}`，表示消息与 Turn 已保存。模型循环接入前，Turn 保持 `running`。
- 读取历史返回 `200`。空会话响应为 `{"sessionId":"…","cursor":0,"records":[],"latestTurn":null}`。首次提交后，`cursor` 为 2，`records` 依次包含用户消息和初始 Turn 状态，`latestTurn` 为 `{"turnId":"…","status":"running"}`。
- 参数校验失败返回 `400`，会话不存在返回 `404` 和 `{"code":"session_not_found"}`，已有活动 Turn 时提交返回 `409` 和 `{"code":"turn_active"}`。
