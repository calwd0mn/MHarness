# 会话分支实施计划

> **实施代理必读**　使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 逐项实施，按复选框记录红灯、绿灯和核验结果。

**目标**　完成 OpenSpec `agent-harness-prototype` 的 1.7，提供基于父会话稳定前缀的内部 fork 命令。

**架构**　Session 包从一次父快照选择继承截止位置。命令控制器负责选源和编排，AgentManager 管理子会话的准备、持久化、发布和关闭。HTTP 历史、follow 和 Web 沿用 1.13 的原始事件路径。

**技术栈**　Node.js 24、TypeScript 5.9、`node:sqlite`、Fastify、`node:test`、pnpm。

---

## 契约与文件

基线为 `e35b593`，工作树为 `@.worktrees/task-1.7-fork`。读取 `@openspec/changes/agent-harness-prototype/tasks.md:62`、`@openspec/changes/agent-harness-prototype/design.md:152`、`@openspec/changes/agent-harness-prototype/specs/agent-execution/spec.md:193` 和 `@openspec/changes/agent-harness-prototype/specs/execution-streaming/spec.md:144`。独立压缩的真实运行、重开修复和模型视图联验归 8.4；1.7 选择器理解已有压缩事件并使用数据夹具覆盖稳定截止位置。

| 文件 | 职责 |
| --- | --- |
| `@packages/session/src/fork.ts`、`@packages/session/src/fork.test.ts` | 选择闭合 Turn 与稳定尾部，测试实际事件位置。 |
| `@packages/session/src/session.ts`、`@packages/session/src/server.ts` | 内存 SessionStore 增加按实例释放，后端入口以 `MemorySessionStore` 暴露内存版本；选择器经同一入口导出。 |
| `@apps/server/src/commands.ts`、`@apps/server/src/agent/manager.ts`、`@apps/server/src/agent/react-agent.ts` | 内部命令、子 Agent 激活与关闭、稳定的命令错误码。 |
| `@apps/server/src/agent/manager.test.ts`、`@apps/server/src/session/fork.test.ts` | 补齐既有持久化替身的 create，验证首次提交、读取租约、竞态、回滚与重开。 |
| `@apps/server/src/app.ts`、`@apps/server/src/session/routes-acceptance.test.ts` | 真实启动入口可取得内部命令，通过现有 HTTP 与 SSE 验证分支。 |
| `@apps/server/src/agent/request-context.ts`、`@apps/server/src/agent/request-context.test.ts` | 从没有 `request/header` 的合法 seed 派生首个 `resume`。 |
| `@apps/web/src/app.test.jsx` | 经真实对话组件和 `useConversation` 验证同步窗口中的子继承边界及占位交接。 |

生产代码沿用 SQLite 初始事务、Session 构造器生成 marker、写入器绑定前不消费初始日志，以及 ReActAgent 按 `inheritedEventCount` 去重。创建普通空会话仍走现有持久化用例。执行使用 `pwsh.exe`。涉及 JS/TS 时先读 `jsdoc-contracts`，增改 API 的 JSDoc 使用中文，TypeScript 禁用 `any`。提交另按授权处理；若提交，使用 `feat(module): 中文说明` 和中文分点正文。

## 任务一　选择同一个观察截点内的稳定前缀

- [ ] 在 `@packages/session/src/fork.test.ts` 增加以下红灯用例。`request/header` 构成轮间尾部，`seq=3` 始终归第一轮；同样的 `seq=5` 在第二轮结束前拒绝，结束后选第二轮。

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectForkCut } from "./fork.ts";
import { Session } from "./session.ts";

test("只在已观察前缀内按锚点选择稳定尾部", () => {
  const source = new Session({ sessionId: "parent", createdAt: 0 });
  const events = () => source.snapshot().events;
  source.append({ type: "request/header", data: { reason: "initial", header: { config: { provider: "mock", model: "m" } } } });
  source.append({ type: "turn/start", data: { turn: 1 } });
  assert.equal(selectForkCut(events()), undefined);
  source.append({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  source.append({ type: "request/header", data: { reason: "series", header: { config: { provider: "mock", model: "m" } } } });
  source.append({ type: "turn/start", data: { turn: 2 } });
  source.append({ type: "step/start", data: { turn: 2, step: 1 } });
  assert.equal(selectForkCut(events(), 0), undefined);
  assert.equal(selectForkCut(events(), 1), 4);
  assert.equal(selectForkCut(events(), 2), 4);
  assert.equal(selectForkCut(events(), 3), 4);
  assert.equal(selectForkCut(events(), 4), undefined);
  assert.equal(selectForkCut(events(), 5), undefined);
  assert.equal(selectForkCut(events(), 6), 4);
  assert.equal(selectForkCut(events()), 4);
  source.append({ type: "step/end", data: { turn: 2, step: 1 } });
  source.append({ type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } });
  assert.equal(selectForkCut(events(), 3), 4);
  assert.equal(selectForkCut(events(), 5), 8);
  assert.equal(selectForkCut(events(), 7), 8);
  assert.equal(selectForkCut(events()), 8);
  for (const value of [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => selectForkCut(events(), value), RangeError);
  }
});

test("轮间锚点按同一快照中匹配的独立压缩终态确定截止位置", () => {
  const source = new Session({ sessionId: "parent", createdAt: 0 });
  source.append({ type: "turn/start", data: { turn: 1 } });
  source.append({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  source.append({ type: "compaction/start", data: { turn: null, compactionId: "first" } });
  source.append({ type: "compaction/end", data: { turn: null, compactionId: "other", status: "succeeded" } });
  assert.equal(selectForkCut(source.snapshot().events, 3), 2);
  source.append({ type: "compaction/end", data: { turn: null, compactionId: "first", status: "succeeded" } });
  assert.equal(selectForkCut(source.snapshot().events, 3), 5);
  source.append({ type: "turn/start", data: { turn: 2 } });
  assert.equal(selectForkCut(source.snapshot().events, 3), 5);
});
```

- [ ] 在根目录运行 `pnpm --filter @mharness/server exec node --import tsx --test ../../packages/session/src/fork.test.ts`。首次应因 `./fork.ts` 缺失而失败；添加临时返回 `undefined` 的函数后，应因有效首轮期望 `4` 和压缩期望 `2` 而失败。确认红灯来自行为断言后完成实现。

- [ ] 在 `@packages/session/src/fork.ts` 实现选择器，调用方传入来自 `Session.snapshot()` 或 `SessionHandle.read()` 的从零连续前缀。

```ts
import type { SessionEvent } from "./events.ts";

/**
 * 从同一观察截点选择可继承的闭合 Turn 及随后的稳定轮间事件。
 * @param events - 从零连续排列的一次父会话观察前缀。
 * @param atSeq - 可选的非负安全整数事件位置；缺省或超过末条已观察事件时选择最近闭合的 Turn。
 * @returns 排他的截止位置；锚点找不到闭合 Turn 时返回 undefined。
 * @throws 锚点非法时抛出 RangeError。
 */
export function selectForkCut(events: readonly SessionEvent[], atSeq?: number): number | undefined {
  if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq < 0)) {
    throw new RangeError("分支锚点必须是非负安全整数");
  }

  let end: number;
  if (atSeq !== undefined && atSeq < events.length) {
    const start = events.findLastIndex((event) => event.seq <= atSeq && event.type === "turn/start");
    const turn = events[start];
    if (turn?.type !== "turn/start") return undefined;
    end = -1;
    for (let index = start + 1; index < events.length; index++) {
      const event = events[index];
      if (event.type === "turn/start") break;
      if (event.type === "turn/end" && event.data.turn === turn.data.turn) {
        end = index;
        break;
      }
    }
  } else {
    end = events.findLastIndex((event) => event.type === "turn/end");
  }
  if (end < 0) return undefined;

  const pending = new Map<string, number>();
  let cut = end + 1;
  for (; cut < events.length; cut++) {
    const event = events[cut];
    if (event.type === "turn/start") break;
    if (event.type === "compaction/start" && event.data.turn === null) pending.set(event.data.compactionId, cut);
    if (event.type === "compaction/end" && event.data.turn === null) pending.delete(event.data.compactionId);
  }
  return pending.values().next().value ?? cut;
}
```

- [ ] 运行 `pnpm --filter @mharness/server exec node --import tsx --test ../../packages/session/src/fork.test.ts`。两例通过。`events.length - 1` 是真正的最后锚点，`events.length` 才进入越界回退；轮间截止始终以所选 Turn 结束后的第一条 `turn/start` 划界。

## 任务二　用存储替身接通命令、首次提交和关闭

- [ ] 创建 `@apps/server/src/session/fork.test.ts`，先以替身冻结首次提交。夹具用订阅观察后续入队，真实写入器在任务三联验。

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Session, type SessionHandle, type SessionHeader, type SessionPersistenceCreateOptions } from "@mharness/session/server";
import { AgentManager } from "../agent/manager.ts";
import type { AgentObservation } from "../agent/react-agent.ts";
import { SessionCommandController } from "../commands.ts";

type Event = ReturnType<Session["snapshot"]>["events"][number];

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

function parentRecords() {
  const parent = new Session({ sessionId: "parent", createdAt: 1 });
  parent.append({ type: "turn/start", time: 1, data: { turn: 1 } });
  parent.append({ type: "user/message", time: 2, surfaceOp: "append", data: {
    turn: 1, id: "parent-user", requestId: "shared", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "父消息" }],
  } });
  parent.append({ type: "turn/end", time: 3, data: { turn: 1, reason: { kind: "completed" } } });
  return parent.snapshot().events;
}

function fakeStorage(options: { failRead?: boolean; failCommit?: boolean; holdCreate?: boolean } = {}) {
  const taken = gate();
  const continueCreate = gate();
  const commitEntered = gate();
  const continueCommit = gate();
  const trace: string[] = [];
  const parent = parentRecords();
  let childId = "";
  let childBatch: readonly Event[] = [];
  let createSignal: AbortSignal | undefined;
  const port = {
    async open(id: string, access: "read" | "write"): Promise<SessionHandle | undefined> {
      trace.push(`open:${id}:${access}`);
      if (id !== "parent") return undefined;
      assert.equal(access, "read");
      return {
        id, header: { sessionId: id, createdAt: 1 }, inheritedEventCount: 0, access,
        async read() { trace.push("read-parent"); if (options.failRead) throw new Error("read failure"); return parent; },
        async append() { assert.fail("父日志被追加"); },
        async flush() { assert.fail("父日志被刷新"); },
        async close() { trace.push("close-parent"); },
      };
    },
    async create(header: SessionHeader, optionsForChild?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
      trace.push("prepare-child");
      childId = header.sessionId;
      assert.equal(header.isSeeded, true);
      assert.equal(header.parentSession, "parent");
      assert.equal(optionsForChild?.inheritedEventCount, 3);
      createSignal = optionsForChild?.signal;
      taken.open();
      if (options.holdCreate) await continueCreate.promise;
      return {
        id: childId, header, inheritedEventCount: 3, access: "write",
        async read() { return childBatch; },
        async append(events) {
          trace.push("append-child");
          commitEntered.open();
          await continueCommit.promise;
          if (options.failCommit) throw new Error("append rollback");
          childBatch = events;
          trace.push("committed-child");
        },
        async flush() { assert.fail("初始化不能 flush 空 header"); },
        async close() { trace.push("close-child"); },
      };
    },
    bindWriter(_handle: SessionHandle, session: Session) {
      trace.push("bind-child");
      session.on("session/event", (event) => trace.push(`queued:${event.seq}`));
    },
  };
  return { port, trace, taken, continueCreate, commitEntered, continueCommit, parent,
    childId: () => childId, childBatch: () => childBatch, createSignal: () => createSignal };
}

test("首批确认后发布完整 Session 与 Agent，父句柄先于子准备释放", { timeout: 5000 }, async () => {
  const storage = fakeStorage();
  const agents = new AgentManager(storage.port, async () => { assert.fail("fork 不调用模型"); });
  const commands = new SessionCommandController(agents);
  const observed: { session: Session; agentSession: Session | undefined; records: readonly Event[] }[] = [];
  const realtime: AgentObservation[] = [];
  agents.onLoaded((agent) => {
    storage.trace.push("loaded-child");
    agent.onObservation((notice) => realtime.push(notice));
  });
  agents.onSessionCreated((session) => {
    storage.trace.push("created-child");
    observed.push({ session, agentSession: agents.get(session.header.sessionId)?.session, records: session.snapshot().events });
    session.append({ type: "turn/start", time: 4, data: { turn: 2 } });
  });
  try {
    const fork = commands.fork({ sessionId: "parent", atSeq: 0 });
    await storage.commitEntered.promise;
    const id = storage.childId();
    assert.equal(agents.get(id), undefined);
    assert.deepEqual(storage.trace, ["open:parent:read", "read-parent", "close-parent", "prepare-child", "append-child"]);
    const loading = agents.load(id);
    storage.continueCommit.open();
    assert.deepEqual(await fork, { sessionId: id });
    const child = await loading;
    assert.equal(child, agents.get(id));
    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.session, child.session);
    assert.equal(observed[0]?.agentSession, child.session);
    assert.deepEqual(observed[0]?.records, storage.childBatch());
    assert.ok(!storage.trace.includes(`open:${id}:write`));
    assert.deepEqual(child.session.snapshot().events.slice(0, 3), storage.parent);
    assert.deepEqual(child.session.snapshot().events.at(3), { type: "session/end-seed", seq: 3, time: child.session.header.createdAt, data: { inherited: true } });
    assert.deepEqual(storage.trace.slice(-5), ["committed-child", "bind-child", "loaded-child", "created-child", "queued:4"]);
    assert.deepEqual(storage.trace.filter((entry) => entry.startsWith("queued:")), ["queued:4"]);
    assert.deepEqual(realtime, [{ type: "event", event: { type: "turn/start", seq: 4, time: 4, data: { turn: 2 } } }]);
  } finally {
    storage.continueCommit.open();
    await agents.close();
  }
});

test("读取失败释放父句柄，首次提交失败释放子句柄且不发布", { timeout: 5000 }, async () => {
  for (const failRead of [true, false]) {
    const storage = fakeStorage({ failRead, failCommit: !failRead });
    const agents = new AgentManager(storage.port, async () => {});
    const commands = new SessionCommandController(agents);
    try {
      let created = 0;
      agents.onSessionCreated(() => { created++; });
      const fork = commands.fork({ sessionId: "parent" });
      storage.continueCommit.open();
      await assert.rejects(fork, failRead ? /read failure/ : /append rollback/);
      assert.equal(created, 0);
      assert.ok(storage.trace.includes("close-parent"));
      assert.ok(!storage.trace.includes("bind-child"));
      assert.equal(storage.trace.includes("prepare-child"), !failRead);
      assert.equal(storage.trace.includes("close-child"), !failRead);
      assert.equal(agents.get(storage.childId()), undefined);
    } finally {
      storage.continueCommit.open();
      await agents.close();
    }
  }
});

test("关闭等待已开始的首批提交并兑现分支，入途 prompt 无法接管", { timeout: 5000 }, async () => {
  const storage = fakeStorage();
  let turns = 0;
  const agents = new AgentManager(storage.port, async () => { turns++; });
  const commands = new SessionCommandController(agents);
  try {
    const fork = commands.fork({ sessionId: "parent" });
    await storage.commitEntered.promise;
    const id = storage.childId();
    const prompt = assert.rejects(commands.prompt({ sessionId: id, requestId: "new", content: [{ type: "text", text: "x" }] }), { code: "agent_closed" });
    const closing = agents.close();
    storage.continueCommit.open();
    assert.deepEqual(await fork, { sessionId: id });
    await prompt;
    await closing;
    assert.equal(turns, 0);
    assert.equal(storage.childBatch().length, 4);
    assert.equal(agents.get(id), undefined);
    assert.equal(storage.trace.at(-1), "close-child");
  } finally {
    storage.continueCommit.open();
    await agents.close();
  }
});

test("关闭取消准备中的分支并释放取得的句柄", { timeout: 5000 }, async () => {
  const storage = fakeStorage({ holdCreate: true });
  const agents = new AgentManager(storage.port, async () => {});
  const commands = new SessionCommandController(agents);
  try {
    const fork = assert.rejects(commands.fork({ sessionId: "parent" }), { code: "agent_closed" });
    await storage.taken.promise;
    const closing = agents.close();
    assert.equal(storage.createSignal()?.aborted, true);
    storage.continueCreate.open();
    await fork;
    await closing;
    assert.deepEqual(storage.trace.slice(-2), ["prepare-child", "close-child"]);
  } finally {
    storage.continueCreate.open();
    storage.continueCommit.open();
    await agents.close();
  }
});
```

- [ ] 运行 `pnpm --filter @mharness/server exec node --import tsx --test src/session/fork.test.ts`。先观察 `commands.fork` 和 `agents.onSessionCreated` 缺失；为新入口建立最小签名后，确认观察器轨迹和关闭竞态断言仍失败。创建回调由既有 SessionStore 隔离异常，回调中需要外部断言的结果先捕获，随后在 `await fork` 之后验证，避免回调内断言仅被记录。

- [ ] 将 `selectForkCut` 导出到 `@packages/session/src/server.ts`，同时添加 `export { Session, SessionStore as MemorySessionStore } from "./session.ts";`，保留 `./storage/sqlite.ts` 的旧 `SessionStore` 导出。给 `@packages/session/src/session.ts` 的内存 SessionStore 增加 `release(session: Session): void`，同一 ID 映射仍等于该实例时删除。现有 `prepare/publish/on` 的约定保持原样。

```ts
/**
 * 释放已退出生命周期的发布实例，原有订阅继续接收之后的发布。
 * @param session - 实际退出的实例；同 ID 的其他实例不受影响。
 */
release(session: Session): void {
  const { sessionId } = session.header;
  if (this.#sessions.get(sessionId) === session) this.#sessions.delete(sessionId);
}
```

- [ ] 在 `@apps/server/src/agent/react-agent.ts` 的 `AgentError` 联合加入 `"session/fork-unavailable"`。在 `@apps/server/src/commands.ts` 导入 `randomUUID`、`selectForkCut`，追加内部命令。命令对未找到父会话使用现有 `session/not-found`。非法 `atSeq` 由选择器返回 `RangeError`，合法但无法选取时使用 `session/fork-unavailable`。

```ts
/**
 * 从同一次父会话观察快照派生子会话，并以持久化的初始前缀发布子 Agent。
 * @param request - 父会话标识及可选事件位置，缺省时选择最近已结束的 Turn。
 * @returns 子会话初始批次得到确认并完成发布后的会话标识。
 * @throws 父会话不存在、找不到闭合 Turn、锚点无效、关闭或初始化失败时拒绝。
 */
async fork({ sessionId: parentSession, atSeq }: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }> {
  const sessionId = randomUUID();
  await this.agents.initializeFork({ sessionId, createdAt: Date.now(), parentSession, isSeeded: true }, async () => {
    const events = await this.agents.readForkSource(parentSession);
    const cut = selectForkCut(events, atSeq);
    if (cut === undefined) throw new AgentError("session/fork-unavailable");
    return events.slice(0, cut);
  });
  return { sessionId };
}
```

- [ ] 在 `@apps/server/src/agent/manager.ts` 扩充 `Persistence` 为 `Pick<SessionPersistence, "open" | "create">` 加既有 `bindWriter`，在 `@apps/server/src/agent/manager.test.ts` 三个 `new AgentManager({ ... })` 替身中添加 `create: (header, options) => store.create(header, options)`。添加以下方法与字段。`#bindWriter` 和 `#notifyLoaded` 从 `#load` 提取原语句，供恢复和 fork 共用。`#load` 原有异常与恢复行为保持，创建通知仅在新分支发布时发出。已从持久截点开始的 follow 会通过 `onLoaded` 接管实时事件，交接须在任何 `session/created` 监听器同步追加之前完成。

```ts
type Event = ReturnType<Session["snapshot"]>["events"][number];
type ForkHeader = Extract<SessionHeader, { isSeeded: true }>;

// AgentManager 字段
readonly #sessions = new MemorySessionStore();
readonly #lifetime = new AbortController();

/**
 * 观察之后成功发布的分支；回调可立即查询 Agent 和完整初始快照。
 * @param listener - 接收新发布 Session 的观察者。
 * @returns 解除订阅的函数。
 */
onSessionCreated(listener: (session: Session) => void): () => void {
  return this.#sessions.on("session/created", listener);
}

/**
 * 读取一次父会话前缀；已加载时同步截取内存，否则短暂持有只读句柄。
 * @param sessionId - 父会话标识。
 * @returns 一次完整前缀；从存储读取时，释放只读句柄后兑现。
 * @throws 父会话不存在，或只读访问及关闭失败时拒绝。
 */
async readForkSource(sessionId: string): Promise<readonly Event[]> {
  const agent = this.get(sessionId);
  if (agent) return agent.session.snapshot().events;
  const handle = await this.persistence.open(sessionId, "read");
  if (!handle) throw new AgentError("session/not-found");
  try { return await handle.read(); } finally { await handle.close(); }
}

/**
 * 保留子会话激活位置并准备完整首批；同 ID 的 load 等待该次初始化。
 * @param header - 尚未使用的子会话标识和直接父会话元数据。
 * @param readSeed - 读取并选择一次父快照，返回连续的继承前缀。
 * @returns 批次得到确认、绑定写入器且发布后的 Agent。
 * @throws 重复标识、提交前关闭、取种或初始化失败时拒绝。
 */
initializeFork(header: ForkHeader, readSeed: () => Promise<readonly Event[]>): Promise<ReActAgent> {
  if (this.#closing) return Promise.reject(new AgentError("agent_closed"));
  const { sessionId } = header;
  if (this.#loading.has(sessionId) || this.get(sessionId)) return Promise.reject(new Error("会话 ID 已占用"));
  // 先占据加载位置，防止首批提交后并发 load 再争夺同一写入权。
  const task = Promise.resolve().then(() => this.#initializeFork(header, readSeed)).finally(() => {
    this.#loading.delete(sessionId);
  });
  this.#loading.set(sessionId, task);
  return task;
}

async #initializeFork(header: ForkHeader, readSeed: () => Promise<readonly Event[]>): Promise<ReActAgent> {
  const signal = this.#lifetime.signal;
  signal.throwIfAborted();
  const events = await readSeed();
  signal.throwIfAborted();
  const session = this.#sessions.prepare(header, { kind: "fork", events });
  const handle = await this.persistence.create(session.header, { inheritedEventCount: session.inheritedEventCount, signal });
  let agent: ReActAgent | undefined;
  try {
    signal.throwIfAborted();
    await handle.append(session.snapshot().events);
    agent = new ReActAgent(session, this.runTurn, handle);
    this.#bindWriter(handle, agent);
    // append 一旦确认，对应分支已存在；关闭中的 Agent 在交给观察者前封住任务准入。
    if (signal.aborted) await agent.stop();
    this.#entries.set(header.sessionId, { agent, handle });
    // 持久快照的观察者须先接上增量，创建监听器可能同步追加。
    this.#notifyLoaded(agent);
    this.#sessions.publish(session);
    return agent;
  } catch (error) {
    try { await agent?.stop(); } finally { await handle.close(); }
    throw error;
  }
}

// load 中保留现有 closing 和 existing 检查；合并 pending 时检查关闭。
if (pending) return pending.then((agent) => {
  if (this.#closing) throw new AgentError("agent_closed");
  return agent;
});
```

- [ ] 更新 `@apps/server/src/agent/manager.ts` 的关闭方法。先同步设置管理器关闭标记，再同步封闭既有 Agent 准入。等待所有 `#loading` 中的操作，随后回收关闭期间确认并发布的子会话。首批尚未开始时以 `agent_closed` 结束并释放句柄，已开始时以 append 的实际结果决定是否发布。对于真实提交成功后的异常，关闭句柄并保留已经存在的持久记录，使后续重开可恢复；生产绑定使用已提交且未经其他绑定的新 Session。清理失败按原有 `AggregateError` 路径汇总。

```ts
close(): Promise<void> {
  if (!this.#closing) {
    let start!: () => void;
    this.#closing = new Promise<void>((resolve, reject) => {
      start = () => { void this.#close().then(resolve, reject); };
    });
    start();
  }
  return this.#closing;
}

async #close(): Promise<void> {
  this.#lifetime.abort(new AgentError("agent_closed"));
  const stopping = Promise.allSettled([...this.#entries.values()].map(({ agent }) => agent.stop()));
  const loading = await Promise.allSettled([...this.#loading.values()]);
  const errors: unknown[] = [];
  for (const result of loading) {
    if (result.status === "rejected" && !(result.reason instanceof AgentError && result.reason.code === "agent_closed")) {
      errors.push(result.reason);
    }
  }
  for (const result of await stopping) {
    if (result.status === "rejected") errors.push(result.reason);
  }
  // 关闭期间新发布的分支已由初始化路径停止，此处也需释放其写入权。
  for (const { agent, handle } of this.#entries.values()) {
    try { await handle.close(); } catch (error) { errors.push(error); }
    finally { this.#sessions.release(agent.session); }
  }
  this.#entries.clear();
  this.#listeners.clear();
  if (errors.length) throw new AggregateError(errors, "关闭 Agent 失败");
}
```

- [ ] 运行 `pnpm --filter @mharness/server exec node --import tsx --test src/session/fork.test.ts src/agent/manager.test.ts`。新测试及全部原管理器测试通过，关闭过程中损坏句柄的清理错误仍可观测。将 `#notifyLoaded(agent)` 临时移回 `#sessions.publish(session)` 之后，运行首个用例应报告创建通知先于加载通知，且已登记的实时观察者漏掉 `seq=4`。恢复发布顺序后重跑。

## 任务三　用真实 SQLite 验证回滚、重开和嵌套

- [ ] 在 `@apps/server/src/session/fork.test.ts` 追加以下 SQLite 联验。先把 `append` 前的准备与释放逻辑作为红灯实施。如果任务二的最小实现已使联验通过，保留测试作为该路径的回归证据，并暂时注入可控变体验证断言。分别跳过首批 `append` 和把活父源切换为存储读取，运行单测应分别在收到失败的提交与缺少闭合 Turn 处报错，随后撤销试验变体。

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteSessionPersistence } from "@mharness/session/server";

test("SQLite 首批拒绝标记时回滚子 header 和 seed，释放子写入权", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-fork-rollback-"));
  const path = join(dir, "events.sqlite");
  const storage = new SqliteSessionPersistence(path);
  const db = new DatabaseSync(path);
  const agents = new AgentManager(storage, async () => {});
  try {
    const parent = await storage.create({ sessionId: "parent", createdAt: 1 });
    await parent.append(parentRecords());
    await parent.close();
    let preparedHeader: SessionHeader | undefined;
    const create = storage.create.bind(storage);
    storage.create = (header, options) => {
      preparedHeader = header;
      return create(header, options);
    };
    db.exec(`CREATE TRIGGER reject_seed BEFORE INSERT ON mh_events WHEN NEW.seq = 3
      BEGIN SELECT RAISE(ABORT, '拒绝首次 seed 标记'); END`);
    let notices = 0;
    agents.onSessionCreated(() => { notices++; });
    await assert.rejects(new SessionCommandController(agents).fork({ sessionId: "parent" }), /拒绝首次 seed 标记/);
    assert.ok(preparedHeader);
    assert.equal(await storage.stat(preparedHeader.sessionId), undefined);
    assert.equal(await storage.open(preparedHeader.sessionId, "read"), undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mh_events WHERE session_id = ?").get(preparedHeader.sessionId)?.count, 0);
    assert.equal(agents.get(preparedHeader.sessionId), undefined);
    assert.equal(notices, 0);
    const retry = await create(preparedHeader, { inheritedEventCount: 3 });
    await retry.close();
  } finally {
    db.close();
    await agents.close();
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite 独立恢复比父持久历史更长的 seed 和嵌套谱系", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = await mkdtemp(join(tmpdir(), "mharness-fork-reopen-"));
  const path = join(dir, "events.sqlite");
  const storage = new SqliteSessionPersistence(path);
  const db = new DatabaseSync(path);
  const agents = new AgentManager(storage, async () => {});
  let reopened: SqliteSessionPersistence | undefined;
  let after: AgentManager | undefined;
  let parentWriteRejected = false;
  try {
    const header = await storage.create({ sessionId: "parent", createdAt: 1 });
    await header.flush();
    await header.close();
    const commands = new SessionCommandController(agents);
    await assert.rejects(commands.fork({ sessionId: "missing" }), { code: "session/not-found" });
    await assert.rejects(commands.fork({ sessionId: "parent" }), { code: "session/fork-unavailable" });
    assert.equal(agents.get("parent"), undefined);
    const { session } = await agents.load("parent");
    const seed = parentRecords();
    for (const event of seed.slice(0, 2)) {
      if (event.type === "turn/start" || event.type === "user/message") {
        const { seq: _, ...append } = event;
        session.append(append);
      }
    }
    await session.flush();
    await assert.rejects(commands.fork({ sessionId: "parent", atSeq: 1 }), { code: "session/fork-unavailable" });
    const end = seed[2];
    assert.ok(end.type === "turn/end");
    session.append({ type: "turn/end", time: end.time, data: end.data });
    db.exec(`CREATE TRIGGER reject_parent_tail BEFORE INSERT ON mh_events
      WHEN NEW.session_id = 'parent' AND NEW.seq = 2
      BEGIN SELECT RAISE(ABORT, '父尾部未提交'); END`);
    parentWriteRejected = true;
    const { sessionId: childId } = await commands.fork({ sessionId: "parent" });
    const child = agents.get(childId)?.session;
    assert.ok(child);
    assert.equal(child.inheritedEventCount, 3);
    assert.deepEqual(child.snapshot().events.slice(0, 3), seed);
    assert.equal((await storage.stat("parent"))?.eventCount, 2);
    assert.equal(session.seq, 3);
    const { sessionId: grandchildId } = await commands.fork({ sessionId: childId, atSeq: 3 });
    const grandchild = agents.get(grandchildId)?.session;
    assert.ok(grandchild);
    assert.equal(grandchild.inheritedEventCount, 4);
    assert.equal(grandchild.header.parentSession, childId);
    assert.deepEqual(grandchild.snapshot().events.filter((event) => event.type === "session/end-seed").map((event) => event.seq), [3, 4]);
    await assert.rejects(agents.close(), (error: unknown) => error instanceof AggregateError
      && error.errors.some((item: unknown) => item instanceof Error && item.message.includes("父尾部未提交")));
    await storage.close();

    reopened = new SqliteSessionPersistence(path);
    after = new AgentManager(reopened, async () => {});
    assert.equal((await reopened.stat("parent"))?.eventCount, 2);
    for (const original of [child, grandchild]) {
      const recovered: Session = (await after.load(original.header.sessionId)).session;
      assert.deepEqual(recovered.header, original.header);
      assert.equal(recovered.inheritedEventCount, original.inheritedEventCount);
      assert.deepEqual(recovered.snapshot().events, original.snapshot().events);
      assert.deepEqual(recovered.deriveMessages(), original.deriveMessages());
      assert.equal(recovered.seq, original.inheritedEventCount + 1);
    }
  } finally {
    await after?.close();
    await reopened?.close();
    db.close();
    if (parentWriteRejected) await agents.close().catch(() => {});
    else await agents.close();
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] 运行 `pnpm --filter @mharness/server exec node --import tsx --test src/session/fork.test.ts ../../packages/session/src/storage/sqlite-persistence.test.ts`。确认 SQLite 事务拒绝 seed 标记时连同已插入的种子和 header 回滚，可再次取得同 ID 的写入权。父缓冲保留在内存时子批次可立即独立恢复，SQLite 的两层 marker 和派生消息保持一致。仅在清理时预期故障注入拒绝父尾部。

## 任务四　启动入口、模型请求与真实 HTTP / SSE

- [ ] 在 `@apps/server/src/agent/request-context.test.ts` 写以下红灯用例。

```ts
test("没有请求头的闭合 seed 在分支首次生成仍写 resume", () => {
  const parent = session();
  parent.append({ type: "turn/start", data: { turn: 1 } });
  user(parent, "inherited");
  parent.append({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  const child = new Session({ sessionId: "child", parentSession: parent.header.sessionId, isSeeded: true, createdAt: 2 },
    { seed: { kind: "fork", events: parent.snapshot().events } });
  const prepare = createRequestPreparer({ runtime: new LlmRuntime({ mock: createMockAdapter(() => []) }),
    config: () => ({ provider: "mock", model: "m" }), systemPrompt: () => "sys" });
  assert.deepEqual(prepare(child).input.messages, [{ role: "user", text: "inherited" }]);
  const header = child.snapshot().events.at(-1);
  assert.ok(header?.type === "request/header");
  assert.equal(header.data.reason, "resume");
});
```

- [ ] 运行 `pnpm --filter @mharness/server exec node --import tsx --test --test-name-pattern '没有请求头的闭合 seed' src/agent/request-context.test.ts`。应报实际值 `initial`、期望值 `resume`。在 `@apps/server/src/agent/request-context.ts` 计算 `const resumes = priorHeader !== undefined || session.header.isSeeded === true;`，把首个 `request/header` 的理由改为 `!previous ? (resumes ? "resume" : "initial") : changed ? "change" : "series"`。沿用现有配置准备与 surface 输入逻辑。运行 `pnpm --filter @mharness/server exec node --import tsx --test src/agent/request-context.test.ts`，全部通过。

- [ ] 在 `@apps/server/src/session/routes-acceptance.test.ts` 添加下面的真实启动联验。用夹具创建已结算的父会话，然后通过正常 `createEventSessionApp` 启动。新测试先因为 Fastify 进程内的 `sessionCommands` 未装配而失败。SSE 解析抽取本文件已有的 TextDecoderStream 逻辑，两条测试都使用下面定义的 `followReader`。

```ts
async function followReader(origin: string, url: string, signal: AbortSignal) {
  const { followFrameSchema } = await import("@mharness/session/contracts");
  const response = await fetch(`${origin}${url}/follow`, { signal });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return { reader, async next() {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const item = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (item.startsWith("data: ")) return followFrameSchema.parse(JSON.parse(item.slice(6)) as unknown);
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE 提前关闭");
      buffer += chunk.value;
    }
  } };
}

test("真实启动应用的 fork 历史和 follow 保留原事件，继承编号可在子会话新受理", { timeout: 8000 }, async () => {
  const { rawSessionHistorySchema } = await import("@mharness/session/contracts");
  const { Session } = await import("@mharness/session/server");
  const { createEventSessionApp } = await import("../app.ts");
  const { createModelTurnDriver } = await import("../agent/model-turn.ts");
  const { createMockAdapter } = await import("../model/providers/mock.ts");
  const { LlmRuntime } = await import("../model/runtime.ts");
  const dir = await mkdtemp(join(tmpdir(), "mharness-fork-http-"));
  const path = join(dir, "events.sqlite");
  const seedStorage = new SqliteSessionPersistence(path);
  const parent = new Session({ sessionId: "parent", createdAt: 1 });
  parent.append({ type: "turn/start", data: { turn: 1 } });
  parent.append({ type: "step/start", data: { turn: 1, step: 1 } });
  parent.append({ type: "user/message", surfaceOp: "append", data: {
    turn: 1, role: "user", source: { kind: "user" }, id: "parent-user", requestId: "shared", content: [{ type: "text", text: "父消息" }],
  } });
  parent.append({ type: "request/header", data: { reason: "initial", header: { config: { provider: "mock", model: "test" }, system: "sys", tools: [] } } });
  parent.append({ type: "assistant/message", surfaceOp: "append", data: {
    turn: 1, step: 1, message: { id: "parent-assistant", role: "assistant", source: { provider: "mock", model: "test" }, content: [{ type: "text", text: "父回答" }] },
    finishReason: { kind: "stop" }, stream: [], includeInModelContext: true,
  } });
  parent.append({ type: "step/end", data: { turn: 1, step: 1 } });
  parent.append({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  const seed = parent.snapshot().events;
  const calls: Array<{ role: string; text: string }[]> = [];
  const driver = createModelTurnDriver({
    runtime: new LlmRuntime({ mock: createMockAdapter((request) => {
      calls.push(request.messages.map(({ role, text }) => ({ role, text })));
      return [{ chunk: { type: "text", delta: "子回答" } }, { chunk: { type: "finish", reason: { kind: "stop" } } }];
    }) }),
    config: () => ({ provider: "mock", model: "test" }), systemPrompt: () => "sys",
  });
  const controller = new AbortController();
  let app: Awaited<ReturnType<typeof createEventSessionApp>> | undefined;
  try {
    const handle = await seedStorage.create(parent.header);
    await handle.append(seed);
    await handle.close();
    await seedStorage.close();
    app = await createEventSessionApp(path, false, driver);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const commands = app.getDecorator<SessionCommandController>("sessionCommands");
    const { sessionId } = await commands.fork({ sessionId: "parent", atSeq: 2 });
    assert.equal(calls.length, 0);
    const url = `/api/sessions/${sessionId}`;
    const get = await app.inject({ method: "GET", url });
    assert.equal(get.statusCode, 200);
    const initial = rawSessionHistorySchema.parse(get.json());
    assert.equal(initial.inheritedEventCount, seed.length);
    assert.deepEqual(initial.records.slice(0, seed.length).map(({ event }) => event), seed);
    assert.equal(initial.records.at(-1)?.event.type, "session/end-seed");
    assert.equal(initial.cursor, seed.length);
    const { reader, next } = await followReader(origin, url, controller.signal);
    const snapshot = await next();
    assert.ok(snapshot.type === "snapshot");
    assert.deepEqual(snapshot.records, initial.records);
    assert.equal(snapshot.inheritedEventCount, initial.inheritedEventCount);
    assert.equal(snapshot.cursor, initial.cursor);
    const submit = (text: string) => app!.inject({ method: "POST", url: `${url}/messages`, payload: {
      requestId: "shared", content: [{ type: "text", text }],
    } });
    assert.deepEqual((await submit("子消息")).json(), { accepted: true });
    assert.deepEqual((await submit("重发内容")).json(), { accepted: true });
    const own = [];
    for (;;) {
      const frame = await next();
      assert.notEqual(frame.type, "error");
      if (frame.type !== "event") continue;
      assert.equal(frame.event.seq, initial.cursor + own.length + 1);
      own.push(frame);
      if (frame.event.type === "turn/end") break;
    }
    assert.deepEqual(own[0].event.data, { turn: 2 });
    assert.deepEqual(own.flatMap(({ event }) => event.type === "request/header" ? [event.data.reason] : []), ["resume"]);
    assert.deepEqual(calls, [[{ role: "user", text: "父消息" }, { role: "assistant", text: "父回答" }, { role: "user", text: "子消息" }]]);
    await reader.cancel();
    await app.close();
    app = await createEventSessionApp(path, false, driver);
    const restored = rawSessionHistorySchema.parse((await app.inject({ method: "GET", url })).json());
    assert.deepEqual(restored.records, [...initial.records, ...own]);
    assert.deepEqual((await submit("重开后重发")).json(), { accepted: true });
    assert.equal(calls.length, 1);
  } finally {
    controller.abort();
    await app?.close();
    await seedStorage.close();
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] 运行 `pnpm --filter @mharness/server exec node --import tsx --test --test-name-pattern '真实启动应用的 fork' src/session/routes-acceptance.test.ts`。预期红灯为 `FST_ERR_DEC_UNDECLARED`。在 `@apps/server/src/app.ts` 构建 `SessionCommandController` 后加 `app.decorate("sessionCommands", commands);`，并在原有 `createEventSessionApp` 的 `@returns` 中说明通过 `getDecorator("sessionCommands")` 获取进程内命令。测试调用已经注册的 GET / POST messages / follow 路由，fork 没有公共 HTTP 入口。

- [ ] 运行 `pnpm --filter @mharness/server exec node --import tsx --test src/session/routes-acceptance.test.ts src/agent/request-context.test.ts`。检查同一个子初始窗口在 GET 和 SSE 完全相等。首个自有事件从 marker 后开始，新编号进第二轮，继承同号用户消息之后只出现一次新模型调用，重开后自己的同号消息能够去重。

## 任务五　验证 Web 按当前会话继承边界确认受理

- [ ] 在 `@apps/web/src/app.test.jsx` `record` 夹具声明之后追加以下 Vitest JSX 用例。复用现有 `App` 渲染、`EventSource`、`fetch` 和 React `act` 辅助函数。浏览器提交发生在首帧仍待交付时，测试根据真实 POST 捕获编号。HTTP 响应保持挂起，只有正式自有增量事件可以接管占位。

```jsx
test("嵌套 fork 中只有子会话自有事件接管同编号发送占位", async () => {
  const connection = connections[0];
  expect(connection.url).toBe("/api/sessions/a/follow");
  fetch.mockImplementation(() => new Promise(() => {}));
  await enter("子消息");
  await submit();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe("/api/sessions/a/messages");
  const { requestId } = JSON.parse(fetch.mock.calls[0][1].body);
  const user = (seq, turn, id, text) => record(seq, "user/message", {
    id, turn, requestId, role: "user", source: { kind: "user" }, content: [{ type: "text", text }],
  }, { surfaceOp: "append" });
  const users = () => [...container.querySelectorAll("article.user")].map((item) => item.textContent);
  expect(users()).toEqual(["你子消息正在发送"]);

  await sendFrame(connection, { ...snapshot("a", [
    record(0, "turn/start", { turn: 1 }),
    record(1, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    record(2, "session/end-seed", { inherited: true }),
    record(3, "turn/start", { turn: 2 }),
    record(4, "step/start", { turn: 2, step: 1 }),
    user(5, 2, "parent-user", "父消息"),
    record(6, "step/end", { turn: 2, step: 1 }),
    record(7, "turn/end", { turn: 2, reason: { kind: "completed" } }),
    record(8, "session/end-seed", { inherited: true }),
  ]), inheritedEventCount: 8 });
  expect(users()).toEqual(["你父消息", "你子消息正在发送"]);

  await sendFrame(connection, record(9, "turn/start", { turn: 3 }));
  await sendFrame(connection, record(10, "step/start", { turn: 3, step: 1 }));
  expect(users()).toEqual(["你父消息", "你子消息正在发送"]);
  await sendFrame(connection, user(11, 3, "child-user", "子消息"));
  expect(users()).toEqual(["你父消息", "你子消息"]);
  expect(fetch).toHaveBeenCalledTimes(1);
});
```

- [ ] 运行 `pnpm --filter @mharness/web exec vitest run src/app.test.jsx -t '嵌套 fork 中只有子会话自有事件'`。基线的现有绑定应通过。分别对 `@apps/web/src/session/use-conversation.ts:94` 的 `onState` 调用和 `@apps/web/src/session/use-conversation.ts:209` 的渲染前 `confirmedRecord` 调用，把生产传入的继承计数临时替换成祖先计数 `2` 或 `0`，每次单独重跑命令。`onState` 错误时，初始快照后的占位会提前变为「已受理，等待同步」。渲染前调用错误时，占位会提前消失。两次都应在首帧后的「正在发送」断言失败。恢复原参数后重跑该测试和 `pnpm --filter @mharness/web test`，预期全绿。

## 任务六　完成验收

- [ ] 从工作树根目录运行以下命令，预期全部退出码为零。保留后端和 Web 实际测试数量，记录已知构建提示。手工检查本次导出、参数、失败时机、持久化提交点与生命周期 JSDoc，核对无 `any`。检查差异仅覆盖计划所列文件和获准的 1.7 清单更新。

```powershell
pnpm typecheck
pnpm --filter @mharness/server test
pnpm --filter @mharness/web test
pnpm --filter @mharness/web build
git diff --check
git status --short
```

- [ ] 依据完整结果核对 1.7。保持任务 8.4 未完成，准备用户已经选择的 `continue-review`。本计划覆盖的工作树和相关结果交给评审，现有 OpenSpec 压缩修订留在主工作区。

## 实施与复核记录

任务 1.7 已在 `codex/task-1.7-fork` 的独立工作区完成。GPT-6.2 Sol high 编写实施计划并由另一实例独立复核，GPT-6.1 Terra high 按 TDD 开发。

- 使用真实 SQLite 验证首批事务回滚、锁释放、活跃父会话未落盘尾部继承及嵌套独立重开。真实 HTTP 与 SSE 验证原始事件传输和模型请求恢复，React 联验验证继承消息无法确认子会话的新提交。
- 代码评审后的修订包括启动恢复完成后开放进程内命令、在初始化登记前校验锚点和父标识、区分正常命令拒绝与关闭错误，以及在关闭期间先封闭任务准入、完成分支发布和增量交付后再解除观察。
- MHarness 项目评审和 Codex 原生 review 已复核修订版，未发现剩余可操作问题。原生复核独立验证了首批提交等待及三种通知回调重入的关闭时序。
- 最终类型检查通过。后端 277 项、Web 109 项全部通过，前端构建通过。中文 JSDoc 已按实际 API 行为人工核对。独立压缩的完整联验由 8.4 验收。
