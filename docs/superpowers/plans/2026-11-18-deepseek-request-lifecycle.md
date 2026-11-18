# Task 2.7：DeepSeek 请求错误、超时与取消实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, using superpowers:test-driven-development for each behavior. Steps use checkbox syntax for tracking.

**Goal:** 用受控 DeepSeek 传输验收错误映射、请求与流空闲超时、取消清理，并证明每次生成最多发送一次请求。

**Architecture:** 沿用现有原生 fetch Adapter、统一 StreamChunk 与 Runtime 单次终态归一化。DeepSeek Adapter 拥有一次生成的 AbortController、响应 reader、等待计时器及监听器，归类错误后抛出 LlmError；Runtime 仍只消费一次 Adapter，不推进 Turn。输入上下文超限新增稳定代码 CONTEXT_WINDOW_EXCEEDED，Agent 本轮仍按失败结算，不实现 8.6 的压缩或重试。

**Tech Stack:** Node.js 24、TypeScript 5.9、原生 fetch/Web Streams、node:test、Zod、pnpm 10。

---

## 授权、基线与正式依据

用户已指定 continue-dev、计划通过后开发及 continue-review；不重复请求阶段批准。本计划由 GPT-6.1 Sol / high 只读评审，通过后由 GPT-6.1 Terra / high 按 TDD 实现，最后新建两个无开发上下文的子 agent，分别应用项目 mharness-code-review 和运行 Codex 原生 review。用户要求保留 OpenSpec；2.7 交付暂留任务分支，不自行合并。

main 已包含 7.7 提交 9bcf677（feat(acceptance): 完成 Session.follow 正常工具续答验收）。原生工具创建的外部工作树因不在 writable roots 而使开发写入审批阻塞，尚无代码变更。现改用已授权项目目录中的 D:/Cdocument/desktop/QZH/a毕业论文/Pro/MHarness/.worktrees/deepseek-request-lifecycle-local，分支 codex/deepseek-request-lifecycle-local，基线不变；.worktrees 已在 .git/info/exclude 中忽略。所有执行命令使用 pwsh.exe。主工作区其他未提交文件保留，不迁入工作树。

正式依据：openspec/changes/agent-harness-prototype/proposal.md、design.md §3.2，以及 specs/agent-execution/spec.md 的「模型流失败归一化」「模型请求错误与资源清理」「DeepSeek 流的结束边界」「输入上下文超限后的压缩重试」。OpenSpec status 的四种规划产物均就绪，整个 change 实施未完，不执行 apply 或 archive。

当前主工作区 tasks.md 对 2.7 的展开比 main 更详细。本次按用户指定的完整 2.7 验收：AUTH、RATE_LIMIT、请求或读流 TRANSPORT、带 request/idle 阶段的 TIMEOUT、调用方 ABORTED、明确输入超限的稳定分类、STREAM_CLOSED 与 max-tokens 区别、安全诊断、真实请求/流/计时器/监听器清理、无迟到输出、无自动重发。只在交付完成后更新任务分支的 2.7 一行，不带入其他条款的并行修订。

## 设计选择与固定边界

1. 在 DeepSeek Adapter 实现生命周期；不把 HTTP、SSE 或厂商错误移入 Runtime。原生 fetch 已无 SDK 重试入口，保持一次 transport 调用。Runtime 仅在确有本次测试暴露的收束缺陷时最小修改。
2. HTTP 401/403 映射 AUTH，429 映射 RATE_LIMIT，其余普通 HTTP 失败沿用 TRANSPORT 并保留 httpStatus。有效 Retry-After 只做安全整数毫秒诊断，支持秒数和合法 HTTP 日期；无效/负值/溢出省略，不执行等待或重发。固定错误文案，不暴露正文、请求、密钥、cause 或取消 reason。
3. CONTEXT_WINDOW_EXCEEDED 只在错误对象的 code/type 明确为 context_length_exceeded/context_window_exceeded，或 message 明确表达输入 token 超限时识别。支持 error 包装及顶层错误形态；message 只接受如 `Input token exceed the limit`、`maximum context length ... exceeded/requested` 的严格表述。普通 quota_limit_reached、余额、裸 400/413/422、HTML、含糊的 token/length、输出 finish_reason:length 均不得触发该分类。错误正文只在接入层短暂用于判断，不进入诊断；读取须受同一取消及超时控制。HTTP 鉴权/限流优先按状态归类，不因正文任意文字改变。
4. 请求超时从实际发送到首个有效 SSE data 事件；收到 HTTP 头不等于首事件。之后等待下一个有效事件用 idleTimeoutMs。沿用集中默认 30000/15000ms 和 ModelConfig 覆盖。SSE 注释、空行、拆包字节不构成有效事件，不得无限延长预算；usage 或合法空 delta 事件属于有效事件。[DONE] 保持现有结束边界。下游暂停消费不是网络超时，等待计时器仅在 Adapter 等待 fetch/read 时活动；一个事件被拆成多个读包时累计同一阶段的剩余等待预算。
5. 每次生成创建自有控制器，将上游取消传播给实际 fetch，并中止 reader。超时记录 TIMEOUT 阶段，随后通过同一控制器终止网络；调用方取消归 ABORTED。与现有 Runtime 约定一致，交付最终 finish 前上游已取消时以 aborted 归一。每次恢复 yield、每次等待完成后检查终止，取消后不再交付已缓冲的正文、usage 或成功 finish。既有 LlmError 保持类别，JSON/Schema 错误为 PROTOCOL，读流拒绝为 TRANSPORT，EOF 无 DONE 为 STREAM_CLOSED。
6. 统一 finally 释放 reader（cancel 后 releaseLock）、计时器与监听器。正常完成、错误、超时、取消和消费者 break 均走清理；提前 break 不额外交付 finish。fetch/read 的迟到完成或拒绝需被消费；若 fetch 在本地已终止后才返回 Response，立即取消其 body，不输出、不再发送。使用有限、局部的等待/取消协作辅助函数，不创建通用重试、调度框架或改变 Session 协议。

DeepSeek 官方状态码依据：https://api-docs.deepseek.com/quick_start/error_codes/。该页确认 401/429；输入超限规则是本项目对明确 Provider 错误的保守识别约定，测试使用合成受控响应，不宣称覆盖厂商所有未公开变体。

## 文件职责

| 文件 | 本次职责 |
| --- | --- |
| apps/server/src/model/adapter.ts | 固定上下文超限错误文案，补充超时/诊断/取消约定的中文 JSDoc。 |
| apps/server/src/model/providers/deepseek.ts | 厂商错误分类、单次请求控制器、超时及 reader 生命周期，保留原流组装语义。 |
| apps/server/src/model/providers/deepseek.test.ts | 保留现有流和请求编码回归。 |
| apps/server/src/model/providers/deepseek-lifecycle.test.ts（新增） | 受控 fetch、可推进 SSE、错误与资源观测、无重发及竞态。 |
| apps/server/src/model/runtime.test.ts | 单次终态、安全白名单和新增分类贯穿 Runtime；现有用例优先复用。 |
| apps/server/src/agent/deepseek-turn.test.ts | 真实 Adapter 到 Turn 的错误结算、零工具派发、单次请求。 |
| README.md | 简要说明错误类别、超时边界和不自动重试，与 API 保证一致。 |
| 本计划、tasks.md 的 2.7 一行 | 新鲜验证与完成记录；不修改其他任务、规格或归档目录。 |

## Task A：错误映射与安全诊断（先 RED，再 GREEN）

- [ ] 先在新增生命周期测试文件写表驱动用例，通过真实 createDeepSeekAdapter + LlmRuntime 收集 finish。最小测试结构如下，其他矩阵按同一真实边界增加独立用例：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { LlmRuntime } from "../runtime.ts";
import { createDeepSeekAdapter } from "./deepseek.ts";
import type { StreamChunk } from "../adapter.ts";

test("HTTP 401 归 AUTH 且每次生成只发送一次", async () => {
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: "private-fake-key" } }), { status: 401 });
  };
  const prepared = new LlmRuntime({ deepseek: createDeepSeekAdapter({ apiKey: "private-fake-key", fetch: transport }) })
    .prepare({ provider: "deepseek", model: "deepseek-v4-pro" });
  const chunks: StreamChunk[] = [];
  for await (const chunk of prepared.generate({ systemPrompt: "", messages: [], tools: [] }, new AbortController().signal)) chunks.push(chunk);
  assert.deepEqual(chunks, [{ type: "finish", reason: { kind: "error", failure: {
    code: "AUTH", message: "Provider authentication failed", httpStatus: 401,
  } } }]);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(chunks), /private-fake-key/);
});
```

- [ ] Run `pnpm --filter @mharness/server exec node --import tsx --test src/model/providers/deepseek-lifecycle.test.ts`，确认首先因错误类别 TRANSPORT != AUTH 失败，记录实际输出。
- [ ] 扩展错误矩阵：403、429 与 Retry-After 秒/日期/无效值；500、普通 400/413/422、余额或 quota 失败；明确输入超限（嵌套和顶层结构、严格文本）与近似负例；fetch 拒绝、reader 拒绝、非法 JSON/Schema、无 body 和无 DONE。每个失败只一个 finish，calls=1，固定文案不含秘密。
- [ ] 最小修改 adapter.ts 的 failureMessages 与 deepseek.ts 的错误转换。诊断沿用 LlmError.toFinishReason 的白名单；网络原错仅作为内部 cause，禁止把原正文写进 message。
- [ ] 重跑生命周期与现有 deepseek.test.ts、runtime.test.ts，全部 GREEN 后再进入 Task B。默认不为错误正文保留任意 Provider 元数据。

## Task B：请求与 idle 超时、取消及资源归属（逐个行为 RED/GREEN）

- [ ] 用 node:test 的 mock timers 控制计时，使用原生 ReadableStream 暴露 controller 与 cancel 计数，记录传给 fetch 的 signal，以 node:events 的 getEventListeners 检查上游 abort 监听器。以显式 Promise 屏障确认 fetch/read 已开始，禁止用无界 sleep 猜时序。测试配置 requestTimeoutMs=100、idleTimeoutMs=50。
- [ ] 先写请求挂起超过 100ms 的失败测试；推进时间并检查 `finish.reason.failure` 为 `{code:"TIMEOUT",message:"Provider request timed out",timeoutPhase:"request"}`，底层 signal 已 aborted、上游 signal 未 aborted、调用数 1。再最小实现控制器、单次等待及超时，不读取凭据或真实网络。
- [ ] 再写 HTTP 头已到但无首 data、只有 keep-alive/空行/不完整 data 的请求超时测试。让分片跨多个 read 消耗预算，总等待达到 100ms 仍超时。最小实现首有效事件边界并 GREEN。
- [ ] 再写首个正文/usage/合法空 delta 后挂起及注释/拆包不无限重置 idle 的失败测试，推进 50ms 得 TIMEOUT/idle；有效事件重置 idle，下游暂停不消耗网络等待预算。最小实现事件级剩余等待预算并 GREEN。
- [ ] 再逐个写取消测试：开始前取消 calls=0；挂起 fetch；首 read 前与读流等待中；yield block-start 后仍有同包正文和 DONE；最终 finish 前取消。断言上游取消为 aborted、实际 signal 终止、cancel 被调用且锁已释放、最多一次 finish、零迟到分片、监听器回到基线。
- [ ] 再写提前 break 测试：消费一个 chunk 后 break，检查请求 signal 终止、body.cancel、body.locked=false、无额外 finish、清理后推进超时不触发动作、监听器归零。正常 DONE 与异常路径也核对相同资源证据。仅在这些 RED 证据后补 finally 清理和中文契约。
- [ ] 受控迟到 fetch 返回 Response、fetch/read 迟到拒绝不得输出或产生未处理拒绝；超时之后再取消、取消之后再推进超时及有效结果在截止前到达分别维持既定归一结果。不要为了无迟到输出而留下后台读取。
- [ ] 合并生命周期及 DeepSeek/Runtime 定向测试全部 GREEN。保持原来的 SSE 内容块索引、工具参数、DONE 与 finish_reason 映射，输出 length 仍是 max-tokens。

## Task C：Turn 交付与验收（先集成 RED，再最小接线）

- [ ] 在 deepseek-turn.test.ts 使用实际 DeepSeek Adapter 和现有 Session/工具注册夹具增加输入超限、AUTH/RATE_LIMIT、读流断网、超时及取消的代表场景。观察持久事件和实际 transport 次数，不只检查一个局部返回值。
- [ ] 检查失败 assistant/attempt 与 turn/end 的稳定代码、取消区别；尝试已输出但未正式结算的文字/完整工具参数后失败时，新增 assistant/message、tool/call、approval/asked、工具 handler 均为零；每个未预取消的生成 calls=1。输入超限仍终止当前 Turn，不压缩、不重发。输出 max-tokens 与 STREAM_CLOSED 继续沿用原有场景。
- [ ] 若现有 Agent 行为已满足集成断言，记录基线 GREEN 及来自 Adapter 切片的 RED，不伪造集成缺陷。只有实际暴露本次要求的缺陷才最小改生产接线。按 jsdoc-contracts 核对变更声明的中文契约、失败/取消/时间单位与资源所有权，内部注释仅解释非显而易见的原因。
- [ ] README 添加与实现一致的简短说明；检查 TypeScript 无 any，不引入依赖、公开 HTTP/SSE 字段或重试 API。

## 验证与审查门禁

- [ ] 定向：`pnpm --filter @mharness/server exec node --import tsx --test src/model/providers/deepseek.test.ts src/model/providers/deepseek-lifecycle.test.ts src/model/runtime.test.ts src/agent/deepseek-turn.test.ts`，预期全部通过；记录 RED/GREEN 命令、失败断言、数量。
- [ ] 服务端与 Session 全套：`pnpm --filter @mharness/server test`；全仓类型：`pnpm typecheck`；协议及消费回归：`pnpm --filter @mharness/web test`。预期全部通过；生产前端未变，不额外构建。
- [ ] `openspec validate agent-harness-prototype --strict`、`git diff --check`、核对基线 `git diff 9bcf677 --stat`。无真实 Provider 调用，无用户数据库访问。没有 JSDoc 专用静态脚本时人工核对并如实记录，不声称已自动检查文档。
- [ ] 主 agent 复跑关键定向测试和 typecheck；全新上下文的项目审查子 agent 只读使用 `.agents/skills/mharness-code-review/SKILL.md` 核对任务/实现/调用链。第二个独立新上下文子 agent 执行 `codex review --base 9bcf677`，原生 CLI 在终态前必须跑完；不拿通用自审冒充原生 review。两路检查都包含未跟踪源码，固定相同交付差异。按用户要求两路可并行。
- [ ] 如有范围内发现，开发 agent 先复现 RED 再修复，两路复核及必要复验；通过后仅勾选 2.7，并写验证记录。任务分支提交采用 `feat(model): 中文说明`，正文中文分点；不把主工作区无关变更带入。保持工作树可审阅、OpenSpec 不归档，最终报告 commit、检查结果、两路审查结论及未验真实 Provider 的限制。
