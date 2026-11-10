# MHarness

本地 Agent Harness 原型。开发环境需要 Node.js 24 和 pnpm 10。

```sh
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:5173` 检查前后端连接。开发服务把 `/api` 请求转发到 Fastify，页面通过共享协议校验 `/api/health` 的响应。

`pnpm typecheck` 检查全部工作区包的 TypeScript 类型。

## 会话接口

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
