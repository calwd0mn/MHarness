---
name: mharness-protocol-design
description: 在 MHarness 项目设计、修改或审查 packages/protocol 的类型、Zod schema 和校验边界时使用。涵盖 HTTP、会话记录、SSE 帧以及从协议类型派生的进程内结构。
---

# MHarness 协议类型与校验

- 先追踪数据的读写边界，核对当前解析调用点及相关 OpenSpec 契约。尚未接入的边界也可能有已约定的运行时校验要求。
- 需要在运行时解析、校验或规范化的数据，用 Zod 定义 schema，并用 `z.infer` 推导解析后的类型。典型边界包括服务端接收 HTTP 请求、从存储读取会话记录，以及浏览器解析需要校验的 SSE 帧。
- 只用于传递已校验数据、表达派生状态或提供其他编译期约束的结构，直接使用 TypeScript 类型。内部结构由使用它的功能模块维护。需要复用协议形状时，从现有类型派生，例如从 `SessionRecord` 派生尚未分配 `seq` 和 `timestamp` 的 `SessionEvent`。
- 同一结构只维护一份定义。若校验边界发生变化，同步更新相关 OpenSpec 契约。
