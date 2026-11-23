import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "./session.ts";

const end = (compactionId: string) => ({
  type: "compaction/end" as const,
  time: 1,
  data: { compactionId, turn: null, status: "succeeded" as const },
});

function bind(session: Session) {
  let submissions = 0;
  session.bindCheckpoint(async () => {}, async (_events, finish, beforeSubmit) => {
    beforeSubmit?.();
    submissions++;
    const result = { status: "committed" as const };
    finish(result);
    return result;
  });
  return () => submissions;
}

test("普通追加后的同 ID 暂存终态在持久化交接前拒绝", async () => {
  const session = new Session({ sessionId: "s", createdAt: 1 });
  const submissions = bind(session);
  session.append(end("a"));
  const before = session.snapshot();
  let guards = 0;
  let errors = 0;
  await assert.rejects(session.commitStaged(() => [end("a")], {
    beforeSubmit: () => { guards++; },
    onPersistenceError: () => { errors++; },
  }), /终态/);
  assert.deepEqual(session.snapshot(), before);
  assert.equal(submissions(), 0);
  assert.equal(guards, 0);
  assert.equal(errors, 0);
  assert.equal(session.stagedOccupied, false);
});

test("暂存终态提交后普通追加同 ID 被拒绝，不同 ID 仍可写入", async () => {
  const session = new Session({ sessionId: "s", createdAt: 1 });
  const submissions = bind(session);
  let guards = 0;
  assert.equal((await session.commitStaged(() => [end("a")], { beforeSubmit: () => { guards++; } })).status, "committed");
  const before = session.snapshot();
  assert.throws(() => session.append(end("a")), /终态/);
  assert.deepEqual(session.snapshot(), before);
  session.append(end("b"));
  assert.equal(submissions(), 1);
  assert.equal(guards, 1);
});

test("同一暂存批次中的重复终态整批拒绝", async () => {
  const session = new Session({ sessionId: "s", createdAt: 1 });
  const submissions = bind(session);
  const seen: number[] = [];
  session.on("session/event", (event) => { seen.push(event.seq); });
  await assert.rejects(session.commitStaged(() => [end("a"), end("b"), end("a")]), /终态/);
  assert.deepEqual(session.snapshot().events, []);
  assert.deepEqual(seen, []);
  assert.equal(submissions(), 0);
  assert.equal(session.stagedOccupied, false);
});

test("继承前缀中的终态同样限制新写入", async () => {
  const parent = new Session({ sessionId: "parent", createdAt: 1 });
  parent.append(end("inherited"));
  const child = new Session({ sessionId: "child", createdAt: 2, isSeeded: true, parentSession: "parent" }, {
    seed: { kind: "fork", events: parent.snapshot().events },
  });
  const submissions = bind(child);
  const before = child.snapshot();
  assert.throws(() => child.append(end("inherited")), /终态/);
  await assert.rejects(child.commitStaged(() => [end("inherited")]), /终态/);
  assert.deepEqual(child.snapshot(), before);
  assert.equal(submissions(), 0);
});

test("旧孤立及重复终态仍可原样回放，新写入仍受限", async () => {
  const events = [{ ...end("legacy"), seq: 0 }, { ...end("legacy"), seq: 1 }];
  const session = new Session({ sessionId: "s", createdAt: 1 }, {
    seed: { kind: "restore", events, inheritedEventCount: 0 },
  });
  assert.deepEqual(session.snapshot().events, events);
  assert.throws(() => session.append(end("legacy")), /终态/);
  session.append(end("new"));
});
