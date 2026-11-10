import { sessionHistoryResponseSchema } from "@mharness/protocol";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { createApp } from "../app.ts";
import { SessionStore } from "./session-store.ts";

function temporaryDatabase(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "mharness-storage-"));
  const path = join(directory, "sessions.sqlite");
  t.after(() => {
    rmSync(path, { force: true });
    rmdirSync(directory);
  });
  return path;
}

test("重开数据库后可按序恢复 Turn 与待审批状态", (t) => {
  const path = temporaryDatabase(t);
  const store = new SessionStore(path);
  try {
    assert.deepEqual(store.acceptTurn("missing", "t0", "消息"), { status: "not_found" });
    store.createSession("s1");
    store.createSession("s2");
    assert.deepEqual(store.readSession("s1"), { cursor: 0, records: [] });
    assert.equal(store.acceptTurn("s1", "t1", "查询后写入").status, "accepted");
    assert.equal(store.acceptTurn("s2", "t2", "另一个会话").status, "accepted");

    const call = { turnId: "t1", stepId: "step1", callId: "c1" };
    store.appendRecords("s1", [
      {
        type: "assistant/message",
        data: {
          turnId: "t1",
          stepId: "step1",
          attemptId: "a1",
          includeInModelContext: true,
          text: "我先准备写入。",
          toolCalls: [{ callId: "c1", name: "write", arguments: '{"value":1}' }],
        },
      },
      {
        type: "approval/requested",
        data: {
          ...call,
          operationId: "op1",
          toolName: "write",
          toolVersion: "1",
          arguments: { value: 1 },
        },
      },
      { type: "turn/status", data: { turnId: "t1", status: "awaiting_approval" } },
    ]);
  } finally {
    store.close();
  }

  const reopened = new SessionStore(path);
  try {
    const history = reopened.readSession("s1");
    assert.ok(history);
    assert.equal(history.cursor, 5);
    assert.deepEqual(history.records.map(({ seq }) => seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(history.records.at(-1)?.data, { turnId: "t1", status: "awaiting_approval" });
    const pending = history.records.find((record) => record.type === "approval/requested");
    assert.equal(pending?.data.operationId, "op1");
    assert.deepEqual(pending?.data.arguments, { value: 1 });
    assert.equal(reopened.readSession("s2")?.cursor, 2);
    assert.deepEqual(reopened.acceptTurn("s1", "t3", "重复提交"), { status: "busy" });
    assert.deepEqual(reopened.readSession("s1"), history);
  } finally {
    reopened.close();
  }
});

test("批次后段写入失败时，先前写入的状态和序号同时回滚", () => {
  const store = new SessionStore(":memory:");
  try {
    store.createSession("s1");
    assert.throws(() => store.acceptTurn("s1", "t1", ""));
    assert.deepEqual(store.readSession("s1"), { cursor: 0, records: [] });
    assert.equal(store.acceptTurn("s1", "t1", "有效消息").status, "accepted");

    const finish = { type: "turn/status", data: { turnId: "t1", status: "succeeded" } } as const;
    assert.throws(() =>
      store.appendRecords("s1", [
        finish,
        {
          type: "tool/result",
          data: { turnId: "missing", stepId: "step1", callId: "c1", status: "succeeded" },
        },
      ]),
    );
    assert.equal(store.readSession("s1")?.cursor, 2);
    assert.equal(store.acceptTurn("s1", "t2", "仍然有活动 Turn").status, "busy");

    assert.deepEqual(store.appendRecords("s1", [finish]).map(({ seq }) => seq), [3]);
    assert.equal(store.acceptTurn("s1", "t2", "开始下一轮").status, "accepted");
    assert.deepEqual(store.readSession("s1")?.records.map(({ seq }) => seq), [1, 2, 3, 4, 5]);
  } finally {
    store.close();
  }
});

test("独立进程同时提交时只持久化一个 Turn 和一条用户消息", async (t) => {
  const path = temporaryDatabase(t);
  const store = new SessionStore(path);
  try {
    store.createSession("s1");

    const submit = `
      import { SessionStore } from ${JSON.stringify(new URL("./session-store.ts", import.meta.url).href)};
      const [, databasePath, turnId] = process.argv;
      const store = new SessionStore(databasePath);
      try {
        console.log(store.acceptTurn("s1", turnId, turnId).status);
      } finally {
        store.close();
      }
    `;
    const execute = promisify(execFile);
    const results = await Promise.allSettled(["t1", "t2"].map((turnId) =>
      execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", submit, path, turnId]),
    ));
    const statuses = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value.stdout.trim();
    });
    assert.deepEqual(statuses.sort(), ["accepted", "busy"]);

    const history = store.readSession("s1");
    assert.ok(history);
    assert.equal(history.cursor, 2);
    assert.deepEqual(history.records.map(({ type }) => type), ["user/message", "turn/status"]);
    assert.equal(history.records[0]?.data.turnId, history.records[1]?.data.turnId);
  } finally {
    store.close();
  }
});

test("应用重启时结算遗留 Turn，保留已知结果且不重复追加记录", async (t) => {
  const path = temporaryDatabase(t);
  const beforeRestart = new SessionStore(path);
  const known = { turnId: "t1", stepId: "step1", callId: "c1" };
  const unconfirmed = { turnId: "t1", stepId: "step2", callId: "c1" };
  const awaitingApproval = { turnId: "t2", stepId: "step1", callId: "c2", operationId: "op3" };
  try {
    beforeRestart.createSession("running");
    beforeRestart.acceptTurn("running", "t1", "运行中");
    beforeRestart.appendRecords("running", [
      { type: "tool/started", data: { ...known, operationId: "op1" } },
      { type: "tool/result", data: { ...known, status: "succeeded", result: "已完成" } },
      { type: "tool/started", data: { ...unconfirmed, operationId: "op2" } },
    ]);

    beforeRestart.createSession("waiting");
    beforeRestart.acceptTurn("waiting", "t2", "等待审批");
    beforeRestart.appendRecords("waiting", [
      {
        type: "approval/requested",
        data: { ...awaitingApproval, toolName: "write", toolVersion: "1", arguments: {} },
      },
      { type: "turn/status", data: { turnId: "t2", status: "awaiting_approval" } },
    ]);

    beforeRestart.createSession("finished");
    beforeRestart.acceptTurn("finished", "t3", "已经完成");
    beforeRestart.appendRecords("finished", [
      { type: "turn/status", data: { turnId: "t3", status: "succeeded" } },
    ]);
  } finally {
    beforeRestart.close();
  }

  const app = createApp(new SessionStore(path));
  try {
    const response = await app.inject({ method: "GET", url: "/api/sessions/running" });
    assert.equal(response.statusCode, 200);
    const running = sessionHistoryResponseSchema.parse(response.json<unknown>());
    assert.equal(running.cursor, 7);
    assert.deepEqual(running.records.slice(5).map(({ type, data }) => ({ type, data })), [
      { type: "tool/result", data: { ...unconfirmed, status: "unknown", reason: "process_interrupted" } },
      { type: "turn/status", data: { turnId: "t1", status: "interrupted", reason: "process_interrupted" } },
    ]);
    assert.deepEqual(running.records[3]?.data, { ...known, status: "succeeded", result: "已完成" });
    assert.equal(running.latestTurn?.status, "interrupted");

    const waitingResponse = await app.inject({ method: "GET", url: "/api/sessions/waiting" });
    const waiting = sessionHistoryResponseSchema.parse(waitingResponse.json<unknown>());
    assert.deepEqual(waiting.records.slice(4).map(({ type, data }) => ({ type, data })), [
      { type: "approval/resolved", data: { ...awaitingApproval, status: "cancelled" } },
      { type: "turn/status", data: { turnId: "t2", status: "interrupted", reason: "process_interrupted" } },
    ]);

    const finishedResponse = await app.inject({ method: "GET", url: "/api/sessions/finished" });
    const finished = sessionHistoryResponseSchema.parse(finishedResponse.json<unknown>());
    assert.equal(finished.cursor, 3);
    assert.equal(finished.latestTurn?.status, "succeeded");
  } finally {
    await app.close();
  }

  const restarted = createApp(new SessionStore(path));
  try {
    const response = await restarted.inject({ method: "GET", url: "/api/sessions/running" });
    assert.equal(sessionHistoryResponseSchema.parse(response.json<unknown>()).cursor, 7);
    const newTurn = await restarted.inject({
      method: "POST",
      url: "/api/sessions/running/messages",
      payload: { text: "重启后发起新一轮" },
    });
    assert.equal(newTurn.statusCode, 202);
  } finally {
    await restarted.close();
  }
});
