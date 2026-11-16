import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSessionResponseSchema, rawSessionEventFrameSchema, rawSessionHistorySchema, type RawSessionEventFrame } from "@mharness/session/contracts";
import { Session, SqliteSessionPersistence } from "@mharness/session/server";
import { createEventSessionApp } from "./app.ts";

test("新版 HTTP 创建提交空 header，启动修复后按原始事件读取", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-online-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  const seed = new SqliteSessionPersistence(path);
  try {
    const handle = await seed.create({ sessionId: "interrupted", createdAt: 0 });
    await handle.append([{ type: "turn/start", seq: 0, time: 10, data: { turn: 1 } }]);
    await handle.close();
  } finally {
    await seed.close();
  }

  const app = await createEventSessionApp(path);
  try {
    const history = await app.inject({ method: "GET", url: "/api/sessions/interrupted" });
    assert.equal(history.statusCode, 200);
    const recovered = rawSessionHistorySchema.parse(history.json());
    assert.equal(recovered.cursor, 1);
    assert.deepEqual(recovered.records[0]?.event, { type: "turn/start", seq: 0, time: 10, data: { turn: 1 } });
    assert.deepEqual(recovered.records[1]?.event.data, { turn: 1, reason: { kind: "interrupted" } });

    const creation = await app.inject({ method: "POST", url: "/api/sessions" });
    assert.equal(creation.statusCode, 201);
    const { sessionId } = createSessionResponseSchema.parse(creation.json());
    const observer = new SqliteSessionPersistence(path, { readOnly: true });
    try {
      assert.equal((await observer.stat(sessionId))?.eventCount, 0);
    } finally {
      await observer.close();
    }
    const empty = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    assert.deepEqual(rawSessionHistorySchema.parse(empty.json()), { sessionId, inheritedEventCount: 0, cursor: -1, records: [] });
    await assert.rejects(createEventSessionApp(path), { name: "OwnershipConflictError" });
  } finally {
    await app.close();
  }

  const reopened = await createEventSessionApp(path);
  try {
    const history = await reopened.inject({ method: "GET", url: "/api/sessions/interrupted" });
    assert.equal(rawSessionHistorySchema.parse(history.json()).cursor, 1);
  } finally {
    await reopened.close();
  }
});

test("SQLite、HTTP 与浏览器契约保留事件的原始 JSON 键", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-wire-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  const storage = new SqliteSessionPersistence(path);
  const session = new Session({ sessionId: "会话🧪", createdAt: 0 });
  const validatedArgs = { nested: { ["__proto__"]: { kept: true }, constructor: 42 } };
  let operation: Extract<RawSessionEventFrame["event"], { type: "tool/operation" }>;
  try {
    const handle = await storage.create(session.header);
    await handle.flush();
    storage.bindWriter(handle, session);
    session.append({ type: "turn/start", data: { turn: 1 } });
    session.append({ type: "step/start", data: { turn: 1, step: 1 } });
    session.append({
      type: "assistant/message", surfaceOp: "append", data: {
        turn: 1, step: 1, finishReason: { kind: "tool_calls" }, stream: [], includeInModelContext: true,
        message: { id: "a", role: "assistant", source: { provider: "p", model: "m" }, content: [
          { type: "tool-call", id: "call", name: "read", arguments: JSON.stringify(validatedArgs) },
        ] },
      },
    });
    session.append({ type: "tool/call", data: {
      turn: 1, step: 1, callId: "call", name: "read", arguments: JSON.stringify(validatedArgs),
    } });
    operation = session.append({ type: "tool/operation", data: {
      turn: 1, step: 1, callId: "call", operationId: "op", toolName: "read", toolVersion: "1", validatedArgs,
    } });
    await session.flush();
    assert.deepEqual((await handle.read(operation.seq, 1))[0], operation);
  } finally {
    await storage.close();
  }

  const app = await createEventSessionApp(path);
  try {
    const response = await app.inject({ method: "GET", url: `/api/sessions/${encodeURIComponent(session.header.sessionId)}` });
    assert.equal(response.statusCode, 200);
    const raw: { records: unknown[] } = response.json();
    assert.deepEqual(raw.records[operation.seq], { type: "event", event: operation });
    const history = rawSessionHistorySchema.parse(raw);
    assert.equal(history.cursor, 7);
    assert.deepEqual(history.records[operation.seq]?.event, operation);
    assert.deepEqual(rawSessionEventFrameSchema.parse(raw.records[operation.seq]).event, operation);
    assert.deepEqual(history.records.at(-1)?.event.data, { turn: 1, reason: { kind: "interrupted" } });
    const invalid = await app.inject({ method: "GET", url: "/api/sessions/bad%00id" });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("不同端口的独立进程不能抢占在线库，持有者退出后可恢复遗留记录", { timeout: 15_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-instance-"));
  const path = join(dir, "events.sqlite");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const moduleUrl = new URL("./app.ts", import.meta.url).href;
  const script = `
    const [path, port, role] = process.argv.slice(1);
    const { createEventSessionApp } = await import(${JSON.stringify(moduleUrl)});
    const { SqliteSessionPersistence } = await import("@mharness/session/server");
    try {
      const app = await createEventSessionApp(path);
      const url = await app.listen({ host: "127.0.0.1", port: Number(port) });
      if (role === "owner") {
        const storage = new SqliteSessionPersistence(path);
        const writer = await storage.create({ sessionId: "active", createdAt: 0 });
        await writer.append([{ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }]);
      }
      process.send({ url });
    } catch (error) {
      process.send({ error: error.name }, () => process.exit(1));
    }
  `;
  const start = (port: number, role: string) => spawn(
    process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path, String(port), role],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const owner = start(0, "owner");
  let competitor: ReturnType<typeof start> | undefined;
  const message = (child: ReturnType<typeof start>) => Promise.race([
    once(child, "message"),
    once(child, "exit").then(([code, signal]) => {
      throw new Error(`测试后端提前退出: ${code ?? signal}`);
    }),
  ]);
  try {
    const [ownerMessage]: unknown[] = await message(owner);
    assert.ok(ownerMessage && typeof ownerMessage === "object" && "url" in ownerMessage && typeof ownerMessage.url === "string");
    const ownerPort = Number(new URL(ownerMessage.url).port);
    competitor = start(ownerPort === 65535 ? 65534 : ownerPort + 1, "competitor");
    const competitorExit = once(competitor, "exit");
    const [competition]: unknown[] = await message(competitor);
    assert.deepEqual(competition, { error: "OwnershipConflictError" });
    assert.equal((await competitorExit)[0], 1);
    const observer = new SqliteSessionPersistence(path, { readOnly: true });
    try {
      const handle = await observer.open("active", "read");
      assert.deepEqual((await handle?.read())?.map(({ type }) => type), ["turn/start"]);
    } finally {
      await observer.close();
    }

    const exited = once(owner, "exit");
    owner.kill();
    await exited;
    const replacement = await createEventSessionApp(path);
    try {
      const response = await replacement.inject({ method: "GET", url: "/api/sessions/active" });
      const history = rawSessionHistorySchema.parse(response.json());
      assert.deepEqual(history.records.map(({ event }) => event.type), ["turn/start", "turn/end"]);
      assert.deepEqual(history.records[1]?.event.data, { turn: 1, reason: { kind: "interrupted" } });
    } finally {
      await replacement.close();
    }
  } finally {
    for (const child of [owner, competitor]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }
  }
});
