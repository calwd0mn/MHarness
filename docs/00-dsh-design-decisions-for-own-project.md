# 00. 借鉴 DSH：为自己的 RAG + MCP 项目选择设计

## 本章目标

本章不是要求复刻 DeepSeek Harness。

目标是从 DSH 的 AgentLoop 中提取可迁移的设计决策，用于一个包含 React、TypeScript 后端、SSE、RAG、MCP 和多模型 Adapter 的项目。

后端框架不作限定。Agent 内核采用普通 TypeScript 模块组织，HTTP/SSE 接口按现有工程和团队习惯选择框架；NestJS 是可选实现，不是 Harness 的前提。文中的 Service、Module 表示职责划分，不要求使用框架装饰器或依赖注入容器。

学习重点应是“哪些事实必须可靠保存、哪些过程可以暂态处理”，而不是逐行复制框架实现。

## 1. 先区分三种学习深度

| 深度 | 目标 | 适合的内容 |
|---|---|---|
| 能实现 | 能在自己的项目中独立写出最小版本，并覆盖关键失败路径 | Session、SSE、模型 Adapter、MCP 工具生命周期、取消 |
| 能解释 | 理解为何存在，能在需求增长时选择是否引入 | 工具并发、顺序提交、Attempt 重试、重连恢复 |
| 能定位 | 知道属于哪一层、需要时能回到源码查阅 | Cordis scope、完整投影体系、PTC、Session 格式迁移 |

不要把“读过源码”误认为“掌握设计”。掌握的标准是：面对取消、超时、重试或前端断线时，能指出哪些状态会丢失、哪些状态必须保留，以及由谁负责收尾。

## 2. 最值得迁移的十个设计

### 2.1 能力边界先于具体实现

DSH 将可替换能力设计为三个角色：Service Definition 定义调用接口，Service Provider 提供实现，Consumer 使用该能力。模型、工具、会话和文件系统等都可以沿着这个边界替换。

它解决的不是“多写一层接口”的问题，而是避免业务流程直接依赖某个 SDK。自己的项目不需要引入 Cordis，也不需要为每个小函数抽象接口；但模型、检索和工具这三类会变化的外部能力应各有明确入口。若 RAG 已经是独立的 MCP 服务，Agent 不应直接注入 `Retriever`；它只依赖 MCP Client 暴露的工具合约。

```text
Agent Service
  ├─ ModelAdapter       ← DeepSeek / GLM 等 Provider
  └─ McpToolClient      ← RAG / 转人工 / 场馆查询等 MCP Server

RAG Module
  ├─ DocumentIngestion  ← 文档解析、切分、索引写入
  ├─ Retriever          ← Milvus + BM25 + Rerank
  └─ MCP Tool Binding   ← 将检索能力暴露为 Tool
```

上层只依赖统一的请求、结果和错误语义。Provider 的鉴权、协议字段、SSE 格式和供应商错误码留在实现一侧。RAG Module 只负责编排传入的 Ingestion 与 Retriever，不把 Milvus、BM25 或切分策略泄漏给 Agent。

### 2.2 Session 是事实来源

Session 不是前端页面状态，也不是单纯的聊天文本列表。

它是一次 Agent 工作过程的持久化事实集合，至少需要保存用户消息、最终 assistant 消息、工具调用和工具结果。

```text
前端内存：为了即时渲染，可以丢失并重建
数据库 Session：已经发生的事实，刷新和重连后仍应成立
```

对自己的项目，最小实现可以采用：

```text
conversation
message
tool_run
```

不必一开始采用完整事件溯源；但每次工具执行的状态和结果不应只保存在 Node 进程内存中。

### 2.3 区分 Session、Turn、Step 与 Attempt

DSH 使用的分层有助于避免重试和工具循环混乱：

```text
Session：一段完整且可恢复的用户会话
Turn：一次用户提问驱动的完整任务
Step：一次模型调用及其产生的工具阶段
Attempt：一次实际 Provider 请求；同一 Step 可因重试有多个 Attempt
```

自己的项目可以不保存所有层级名称，但应该能够表达这两个关键事实：

```text
同一用户问题可以经过多次模型调用。
同一次模型调用失败后可以重试，但每次重试是不同的请求实例。
```

### 2.4 流式暂态与最终持久态分离

SSE token 用于实时显示；最终 assistant message 才是会话事实。

```text
模型 token
→ SSE 推送到前端临时消息
→ 流结束并成功保存 assistant message
→ 前端确认或替换临时消息
```

第一版不必实现 DSH 的 `revision`、`attemptId`、compact stream baseline；但不能只把最终回答留在 React state。

### 2.5 工具调用有三种不同事实

```text
tool-call delta
  模型正在生成调用意图，参数可能还不完整。

tool/call
  后端已经接受并开始调度调用，前端可以显示运行中的工具状态。

tool/result
  工具已结束，结果可以进入下一次模型请求。
```

使用 MCP 时也应保持这个边界。MCP 是工具提供和远程调用协议，不替代 Agent 的工具生命周期管理。

推荐路径：

```text
模型 tool-call
→ 保存 tool_run = running
→ 调用 MCP Client
→ 保存 tool_run = succeeded / failed
→ 将 tool result 加入下一次模型请求
```

不要在收到流式 `tool-call delta` 时立即调用 MCP Server。

### 2.6 模型请求可重试，工具副作用不可盲目重放

模型请求失败通常可以按错误类型重试。

一旦工具正文已经开始，重新请求模型可能导致它再次生成同一个工具调用，造成重复写库、重复通知或重复修改业务数据。

对有副作用的 MCP 工具，至少需要：

- 稳定的 `toolCallId`；
- 持久化状态：`pending`、`running`、`succeeded`、`failed`、`cancelled`；
- 幂等键或业务端去重；
- 明确的超时与取消行为。

### 2.7 用事件区分“已发生”与“正在发生”

DSH 区分两类事件：Session event 是必须持久化的事实；Agent event 是进程内工作过程的扩展点。前者用于恢复、回放和审计，后者用于流式 UI、请求拦截和执行策略。

自己的项目可以不建设完整事件总线，但应在表结构和接口中保持这个区分：`assistant_completed`、`tool_completed` 属于可追溯事实；token delta、加载状态和当前连接属于暂态过程。

当增加一个模型可见输入时，先问：它是否应在刷新、重试或问题排查后仍可重建？如果答案是“是”，就把它持久化为会话事实，而不是只塞进本次请求的内存对象。

### 2.8 生命周期、配置和权限不能隐式处理

DSH 通过可卸载的注册、明确的取消信号和工具执行阶段，避免后台任务在请求结束后继续失控。它也将部署差异放进配置，而不是散落在调用处。

自己的项目至少要明确以下规则：

- 前端断开或用户取消时，模型流、SSE 写入和未开始的工具如何停止；
- 工具开始执行后，取消是停止等待、尝试中断，还是只标记结果不再展示；
- 模型、`topK`、重排阈值、超时时间属于配置；租户隔离、工具权限和活动文档过滤属于不能静默降级的不变量；
- MCP 工具参数在入口校验，并在执行前做用户、角色或租户授权；不能把模型生成的参数直接当作可信命令。

### 2.9 Provider 差异留在 Model Adapter

业务 Agent 不应散落 Provider 判断：

```ts
interface ModelAdapter {
  stream(request: ModelRequest): AsyncIterable<StreamEvent>
}
```

DeepSeek、GLM 等差异应由 Adapter 吸收：鉴权、请求体、SSE 格式、工具调用字段、错误码和 usage 字段。

上层只处理统一的文本 delta、工具调用、usage、finish 和错误。

### 2.10 用 MCP Tool 作为跨服务能力边界

当 RAG、人工转接和远端场馆查询都是独立服务时，MCP 是合适的 Agent 调用边界：服务端定义工具名称、输入 Schema、输出 Schema、鉴权与领域审计；Agent Module 通过 MCP Client 发现并调用这些工具。

```text
React
  └─ SSE / HTTP → Agent Module
                    └─ MCP Client ── Streamable HTTP ─→ RAG MCP Server
                                                    ├→ Handoff MCP Server
                                                    └→ Venue MCP Server
```

这里有两个不能混淆的流：React 的 SSE 用于把 Agent 的实时回答展示给用户；MCP 的 Streamable HTTP 用于 Agent 与领域服务交换 JSON-RPC 消息。MCP Server 可以通过 SSE 返回多个协议消息或进度通知，但它不是前端聊天流的替代品。

也不要把 MCP Session（服务启用状态化会话时）与业务 Conversation 混为同一个 ID。前者管理 Client 与 Server 的协议连接；后者是用户会话和审计事实。Agent 调用 Tool 时应传递自己的 `conversationId`、`turnId` 与追踪 ID 作为业务上下文，但 MCP Server 仍须根据可信身份重新授权。网络断开不等于取消工具；需要由 MCP Client 显式取消，并由每个 Tool 说明“未开始、正在尝试中断、已完成但调用方未收到结果”分别怎样结算。

每个公网或跨网络的 Streamable HTTP MCP Server 都要校验来源并实施认证。不要因 Agent 已经认证就省略 Server 侧授权；场馆查询、转人工和知识库访问应分别按用户、角色与租户判断可用范围。

RAG MCP Server 内部由独立的 RAG 应用服务编排检索。MCP Handler 负责协议接入、参数校验和调用该服务，不承载检索流程：

```text
MCP search_knowledge Tool
→ RAG 应用服务
→ Retriever（向量召回、关键词召回、融合、重排）
→ 结构化检索结果（片段、来源、版本、分数）
```

`DocumentIngestion` 通常是后台管理或异步任务入口，不应默认作为模型可调用工具暴露；只有确实需要模型写入知识库时，才额外提供受严格权限、审批和幂等保护的 Tool。

还要明确检索的触发策略：若 `search_knowledge` 是普通 Tool，就由模型决定是否调用；若每次政务问答都必须先检索，则由 Agent 编排层在首次模型请求前通过 MCP Client 调用 RAG，再把结果作为受标记的上下文加入请求。两种策略都能使用 MCP，但不能一边要求强制检索，一边又把是否检索完全交给模型。

## 3. 一个适合第一版的架构

HTTP/SSE 接口负责身份校验、请求解析与响应；运行管理负责执行的启动、并发限制、取消和订阅；Agent Loop 负责模型与工具循环。Agent 内核通过显式参数接收依赖，不直接依赖 HTTP 请求、响应对象或框架生命周期。需要接入已有 NestJS 工程时，可以由 Controller 调用这些模块。

```text
React
  ├─ HTTP：创建会话、提交消息、取消
  └─ SSE：文本、推理状态、工具状态

TypeScript 后端
  ├─ HTTP / SSE 接口
  ├─ 运行管理：启动、并发限制、取消、订阅
  └─ Agent 应用服务
      ├─ ConversationStore
      ├─ ModelAdapter
      ├─ McpToolClient
      └─ Agent Loop

RAG 模块 + MCP Server（可与 Agent 同一应用部署，也可独立部署）
  ├─ RAG 应用服务
  │   ├─ DocumentIngestion
  │   └─ Retriever
  └─ Streamable HTTP MCP Server
```

最小请求路径：

```text
保存 user message
→ ModelAdapter.stream()
→ SSE 输出文本 delta
→ 若得到完整 tool-call：保存 tool run，通过 MCP Client 调用 RAG、转人工或场馆查询服务
→ 远端服务执行领域逻辑并返回结构化 tool result
→ 保存 tool result
→ 下一次模型调用读取 tool result
→ 保存最终 assistant message
```

RAG 检索结果是本轮模型输入的一部分；它通常不应伪装为用户原话。RAG Tool 应返回检索来源、chunk 版本、检索参数和必要分数，使错误回答可以回溯到具体证据。Agent 将实际接收到的 Tool 结果写入 Session；RAG 服务另外保存自身的索引与领域审计数据。

这里的“保存”不要求第一版采用 DSH 的 JSONL Session 格式或投影系统。关系型数据库中的 `message`、`tool_run`、`retrieval_trace` 表也可以满足目标，前提是它们能重建实际模型上下文。

### 3.1 运维辅助原型可以舍弃哪些装配机制

对于服务公司内部技术支持与运维人员的物联平台 Agent 原型，用户围绕设备、告警和运行记录开展调查，不需要为每段对话选择本地代码目录。因此，不必复刻 DSH 的 Workspace 导航、按 Session 加载 preset、Cordis 动态插件装配或斜杠命令系统。这里在应用启动时固定组合 TypeScript 模块，保留会话持久化、Agent 执行和前端流式消费能力。

| DSH 中的机制 | 本项目第一版的取舍 |
|---|---|
| Workspace、`cwd`、目录选择、工作区内空白会话复用 | 舍弃；创建对话时关联当前用户及必要的业务范围 |
| 每个 Session 的 preset、插件挂载与配置覆盖层 | 舍弃；应用启动时固定装配 Agent Service、Model Adapter 和 MCP Client |
| 斜杠命令解析、命令注册和分发 | 没有对应产品需求时不实现；取消、重试等操作可通过页面按钮和普通接口提供 |
| `SessionCommandController` 的类划分 | 不必照搬；HTTP 处理函数接收创建、发送、取消等请求，由应用服务与运行管理执行对应操作 |
| 模型、Prompt、MCP 工具与检索参数 | 保留集中配置；会话执行时读取必要配置，不必重做整套插件加载 |
| Session 历史、模型尝试、工具状态与流式展示 | 保留；它们直接支撑调查过程展示、历史恢复和问题追溯 |
| 用户身份、设备访问范围与组织权限 | 保留；请求入口校验身份和会话权限，领域工具执行前校验业务权限 |

DSH 的 `SessionCommandController` 中，command 表示创建会话、提交消息、取消执行等写操作，并不等于用户输入的斜杠命令。可以合并这些类，但不能因此省略对应的业务操作。

运维项目中的组织、场馆和设备范围也不必建模成 DSH 的 Workspace。它们是查询上下文与访问控制条件，应根据平台已有的身份和权限体系取得；模型生成的工具参数不能扩大当前用户的访问范围。

### 3.2 简化后的启动、创建与发送链路

以下是本项目建议采用的链路，不是 DSH 当前实现的逐项映射。把应用级初始化、会话创建和本轮执行分开，可以让创建会话无需触发模型请求或加载一套独立插件。

```text
后端应用启动
  → 加载 Provider、模型、凭据引用和 Prompt 配置
  → 注册 Model Adapter
  → 初始化 MCP Client，取得工具目录与输入 Schema
  → 组合 Agent 应用服务、运行管理与持久化服务
  → 注册 HTTP 路由与 SSE 订阅入口
```

长期配置由后端管理，凭据不返回浏览器。工具目录可以在启动时准备，但实际可调用范围仍须结合当前用户权限决定。

```text
用户点击“新建对话”
  → POST /conversations
  → 校验身份，创建 conversation 并关联当前用户
  → 返回 conversationId
  → 前端进入对话页，读取历史与执行状态
```

创建会话只建立持久记录，不必立即创建一个长期驻留内存的 Agent 实例。前端的会话对象负责历史、暂态输出和页面交互；后端的 conversation 记录保存会话事实；发送消息时再启动本轮 Agent 执行。

```text
用户提交消息
  → 校验会话访问权限，检查是否已有活动执行
  → 保存 user message，创建本轮执行记录
  → Agent Service 读取历史，组装 system prompt、tools 和模型参数
  → ModelAdapter.stream()
  → Adapter 构造 Provider 请求，开始消费响应流
  → SSE 推送文本与工具状态，前端更新暂态展示
  → 保存工具结果与最终 assistant message
  → 前端依据完成结果确认或替换暂态消息
```

第一版可以规定同一会话同时只允许一轮活动执行，重复提交时返回明确状态；不必立即实现 DSH 的 Inbox、`next-turn` 队列和 `next-step` steer。活动执行仍需拥有执行 ID、取消信号与终态记录，避免页面刷新后无法判断任务是否结束。

这里的 SSE 是 Agent 后端向 Web 前端发送展示事件的通道；Adapter 与 Provider 之间的响应流属于另一段连接。运行管理分别提供启动、取消和订阅能力，SSE 连接只负责观察执行。浏览器断开后是否继续执行，需要沿用 2.8 节明确的生命周期规则，不能仅凭关闭 SSE 就认定模型和工具已经停止。

### 3.3 简化装配后仍要保存的请求信息

不采用动态配置加载，也应能追溯实际调用使用的模型、Prompt 版本、工具定义版本或配置标识，以及必要的生成参数。可以将这些信息附在本轮执行记录上，无需复刻 DSH 的 `request/header` 事件与完整投影系统；凭据本身不写入会话历史。

对于需要恢复或评估的模型输入，还要保存实际进入上下文的用户消息、补充查询结果、工具结果和证据引用。这样，固定模块装配与持久化回放可以独立实现：前者决定程序如何启动，后者记录每轮调查实际发生了什么。

## 4. 先实现什么，后实现什么

### 必须先实现

- 单轮模型 SSE 流式输出；
- 用户消息与最终 assistant 消息持久化；
- 统一 Model Adapter；
- 单个 MCP 工具调用的 `running → result` 生命周期；
- 工具结果进入下一次模型请求；
- AbortSignal 中断当前模型请求；
- 基础错误状态与前端展示。

### 需求增长后再实现

- 多工具受限并发；
- 结果按模型调用顺序提交；
- Attempt 级重试与指数退避；
- 活跃流在断线重连后的恢复；
- 工具权限、人工审批、guard 与 post-execute；
- MCP Client 的连接池、服务发现与故障隔离；
- 按时间回放完整流式节奏。

### 暂时无需复刻

- Cordis 的 scope、effect 和插件装配；
- DSH 完整的 Session 投影系统；
- PTC/code mode；
- 发布后的 Session 格式迁移；
- 极端并发下的完整滚动调度器。

## 5. 用五个故障问题检验设计

在实现一个能力前，先回答：

1. 用户在生成中取消时，前端临时文本、后端最终消息和请求连接分别如何结束？
2. MCP 工具超时后，是否能确认它没有执行、正在执行，还是已经执行成功？
3. 前端断线后重连，已经持久化的消息如何恢复？正在生成的内容如何处理？
4. 模型请求重试时，如何避免再次执行已经开始的副作用工具？
5. 某次 RAG 回答不正确时，能否定位到实际使用的检索 chunk、版本与模型配置？

若这些问题都有明确答案，就已经掌握了 DSH 中最能提升项目可靠性的部分。

## 6. 源码阅读优先级

按以下顺序阅读即可。阅读每个文件时，优先回答“谁写入状态、谁读取状态、失败如何结算”，而不是逐行追踪框架类型：

1. `docs/architecture.md`：先建立插件、事件、Turn/Step 和 Session Log 的总图。
2. `packages/core/agent-loop/src/agent.ts`：Turn、Step、模型请求、取消、结算和工具循环。
3. `packages/core/agent-loop/src/assistant-stream.ts`：实时流与持久化结算的交接。
4. `packages/core/session/src/index.ts` 与 `packages/core/session/src/types.ts`：事件日志如何派生为模型消息。
5. `packages/core/tools/src/index.ts`：工具预执行、执行和后处理的策略位置。

暂时跳过 Cordis 的完整 scope 机制、发布后的 Session 格式迁移、PTC 和极端工具并发调度。只有当自己的项目已经出现多 Provider 装配、复杂恢复或多工具并发需求时，再沿这些路径继续下钻。

## 7. 面试与落地的掌握标准

不需要说出 DSH 的每个类名。对下列问题能结合自己的代码给出“为什么、怎么做、失败时怎么办”的答案，就已经掌握了可迁移的设计：

1. 为什么模型 Adapter、Retriever 和 ToolExecutor 的编排不应直接写在 HTTP 处理函数或 Controller 中？
2. 一次回答的检索片段、模型配置和工具结果如何被追溯？
3. SSE 断线、用户取消、Provider 超时分别怎样结算？
4. 为什么不能在收到流式 tool-call delta 时立刻调用 MCP？
5. 为什么模型重试不能默认重放已有副作用的工具？
6. 为什么 Agent 不直接注入 `Retriever`，而通过 MCP Client 调用 RAG Tool？
7. 为什么前端 SSE 与 MCP Streamable HTTP 必须使用不同的状态与取消语义？

## 8. Session 内存事件日志的源码映射

以下以 DSH 提交 `d347e703908d0406b7a7ef80e3a0e594d86b2215` 为准，对应 MHarness 任务 1.5。

| 主题 | DSH 来源 | MHarness 落点 |
| --- | --- | --- |
| 会话元数据与日志 | `SessionHeader` 将 `id`、创建时间、谱系和格式信息放在事件以外。 `Session` 按 `seq` 定位事件。 [会话类型](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/session/src/types.ts#L91) | `session.ts` 的 header 使用 `sessionId`、`createdAt`，分支保存 `parentSession` 和 `isSeeded`。 `session.seq` 是当前事件数，`snapshot(start, end)` 的游标指向完整前缀的末条记录。 |
| 准备、发布和订阅 | `SessionStore.prepare` 准备实例，`enter` 安装发布钩子并注册实例，`announce` 发创建通知。分支构造向继承前缀追加标记。 [内存 Session 与 Store](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/session/src/index.ts#L958) | `SessionStore.prepare` 校验初始日志，`publish` 注册后通过同步监听器发布 `session/created`。普通追加通过 Session 的 `session/event` 通知交付。继承数量由当前会话持有，继承内容及本次标记随初始快照读取。 |
| 请求配置与消息 | `request/header` 记录生效的请求快照，`user/message` 保存消息本体，`assistant/message` 和 `tool/result` 保存嵌套消息。 `tool/call` 保留原始参数字符串。 [事件定义](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/session/src/types.ts#L260) | `events.ts` 保留上述载荷分层和原始参数。自有真实用户消息另含 `requestId`；工具治理补充操作与审批事件，工具结果保留来源引用和已有的 `operationId`。 |
| 紧凑流与结算 | `assistant/message` 与 `assistant/attempt` 保存带时序的紧凑流，避免逐分片持久化。 [Assistant 结算事件](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/session/src/types.ts#L299) | 1.5 在事件边界保留 `stream` 的完整 JSON 内容，结算事件另记录上下文纳入标记。压缩编码、结算及回放消费由 2.5 实施。 |
| 持久化和检查点 | 持久化服务通过每会话句柄读取和追加。JSONL 提供具体存储，检查点策略在模型或工具调用前等待持久化。 [持久化接口](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/session/session-persistence/README.md) · [JSONL](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/session/session-persistence-jsonl/README.md) · [检查点](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/session/session-checkpoint-policy/README.md) | MHarness 按 1.8、1.9、1.10 实施持久化接口、SQLite 和检查点。1.5 的追加和通知代表内存接受。 |
