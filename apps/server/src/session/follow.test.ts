import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "@mharness/session/server";
import type { AgentManager } from "../agent/manager.ts";
import { ReActAgent } from "../agent/react-agent.ts";
import { followSession } from "./follow.ts";

function emptyManager(): Pick<AgentManager, "get" | "onLoaded"> {
  return { get: () => undefined, onLoaded: () => () => {} };
}

function observedAgent(session: Session): ReActAgent {
  return new ReActAgent(session, async () => {}, {
    id: session.header.sessionId,
    header: session.header,
    access: "write",
    inheritedEventCount: 0,
    read: async () => session.snapshot().events,
    append: async () => {},
    flush: async () => {},
    close: async () => {},
  });
}

test("快照读取失败只交付一个终止帧并释放观察", async () => {
  let released = false;
  const manager = { ...emptyManager(), onLoaded: () => () => { released = true; } };
  const frames = [];
  for await (const frame of followSession(manager, async () => { throw new Error("private"); }, "s", new AbortController().signal)) {
    frames.push(frame);
  }
  assert.equal(frames.length, 1);
  assert.match(frames[0] ?? "", /"type":"error"/);
  assert.doesNotMatch(frames[0] ?? "", /private/);
  assert.equal(released, true);
});

test("持久快照等待期间首次加载的内存前缀原子接管观察", async () => {
  const session = new Session({ sessionId: "s", createdAt: 1 });
  const agent = observedAgent(session);
  let loaded: ((value: ReActAgent) => void) | undefined;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const manager = { get: () => undefined, onLoaded: (listener: (value: ReActAgent) => void) => { loaded = listener; return () => {}; } };
  const signal = new AbortController();
  const stream = followSession(manager, async () => {
    await gate;
    return { sessionId: "s", inheritedEventCount: 0, cursor: -1, records: [] };
  }, "s", signal.signal);
  try {
    const first = stream.next();
    assert.ok(loaded);
    loaded(agent);
    session.append({ type: "turn/start", data: { turn: 1 } });
    release?.();
    const snapshot = await first;
    assert.match(snapshot.value ?? "", /"cursor":0/);
    assert.match(snapshot.value ?? "", /"type":"turn\/start"/);
    session.append({ type: "step/start", data: { turn: 1, step: 1 } });
    assert.match((await stream.next()).value ?? "", /"seq":1/);
  } finally {
    signal.abort();
    await stream.return(undefined);
    await agent.stop();
  }
});

test("来源事件缺号时在异常事件前终止发送", async () => {
  const agent = observedAgent(new Session({ sessionId: "s", createdAt: 1 }));
  let publish: Parameters<ReActAgent["onObservation"]>[0] | undefined;
  let released = false;
  agent.onObservation = (listener) => {
    publish = listener;
    return () => { released = true; };
  };
  const stream = followSession({ get: () => agent, onLoaded: () => () => {} }, async () => undefined, "s", new AbortController().signal);
  await stream.next();
  assert.ok(publish);
  publish({ type: "event", event: { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } } });
  const failure = await stream.next();
  assert.match(failure.value ?? "", /"expectedSeq":0,"actualSeq":1/);
  assert.doesNotMatch(failure.value ?? "", /"type":"turn\/start"/);
  assert.equal((await stream.next()).done, true);
  assert.equal(released, true);
  await agent.stop();
});

test("慢消费者的待发送窗口超限后以终止错误要求重新同步", async () => {
  const agent = observedAgent(new Session({ sessionId: "s", createdAt: 1 }));
  let publish: Parameters<ReActAgent["onObservation"]>[0] | undefined;
  agent.onObservation = (listener) => { publish = listener; return () => {}; };
  const stream = followSession({ get: () => agent, onLoaded: () => () => {} }, async () => undefined, "s", new AbortController().signal);
  await stream.next();
  assert.ok(publish);
  publish({ type: "assistant-stream", frame: {
    type: "chunk", attemptId: "a", revision: 1, index: 0,
    chunk: { type: "text", delta: "x".repeat(1_048_576) },
  } });
  const result = await stream.next();
  assert.match(result.value ?? "", /"type":"error"/);
  assert.doesNotMatch(result.value ?? "", /"type":"chunk"/);
  assert.equal((await stream.next()).done, true);
  await agent.stop();
});
