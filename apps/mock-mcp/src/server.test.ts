import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MockLedger } from "./ledger.ts";
import { startMockMcp } from "./server.ts";

test("真实 MCP 重复写入在重启后返回相同结果且只产生一次效果", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mock-mcp-"));
  const path = join(dir, "mock.sqlite");
  let server = await startMockMcp(0, path);
  const call = async (args: Record<string, string>) => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    try { return await client.callTool({ name: "mock_write", arguments: args }); }
    finally { await client.close(); }
  };
  try {
    const first = await call({ text: "hello", operationId: "op" });
    assert.deepEqual(await call({ operationId: "op", text: "hello" }), first);
    assert.deepEqual(server.effects(), ["hello"]);
    await server.close();
    server = await startMockMcp(0, path);
    assert.deepEqual(await call({ text: "hello", operationId: "op" }), first);
    assert.equal((await call({ text: "other", operationId: "op" })).isError, true);
    assert.deepEqual(server.effects(), ["hello"]);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

async function ready(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("子进程启动超时")), 5000);
    const finish = (error?: Error, value?: string) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error); else resolve(value!);
    };
    const onData = (chunk: Buffer) => finish(undefined, chunk.toString().trim());
    const onExit = () => finish(new Error(`子进程启动前退出: ${child.stderr.read()?.toString() ?? ""}`));
    const onError = (error: Error) => finish(error);
    child.stdout.once("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
    if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.stdin.on("error", () => {});
  child.stdin.end("stop\n");
  const timer = setTimeout(() => child.kill(), 2000);
  try { await exited; } finally { clearTimeout(timer); }
}

test("独立 MCP 进程在数据库写锁竞争中共同去重", { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mock-mcp-concurrent-"));
  const path = join(dir, "mock.sqlite");
  const children: ChildProcessWithoutNullStreams[] = [];
  const serverScript = `import { writeSync } from 'node:fs';
    import { MockLedger } from './src/ledger.ts';
    import { startMockMcp } from './src/server.ts';
    const write = MockLedger.prototype.write;
    MockLedger.prototype.write = function (...args) { writeSync(1, 'entered\\n'); return write.apply(this, args); };
    const server = await startMockMcp(0, process.argv[1]);
    console.log(server.url);
    process.stdin.once('data', async () => { await server.close(); process.exit(0); });`;
  const lockScript = `import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('locked');
    process.stdin.once('data', () => { db.exec('COMMIT'); db.close(); process.exit(0); });`;
  try {
    const urls: string[] = [];
    for (let i = 0; i < 2; i++) {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", serverScript, path]);
      children.push(child);
      urls.push(await ready(child));
    }
    const lock = spawn(process.execPath, ["--input-type=module", "-e", lockScript, path]);
    children.push(lock);
    assert.equal(await ready(lock), "locked");
    const clients = await Promise.all(urls.map(async (url) => {
      const client = new Client({ name: "test", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      return client;
    }));
    try {
      const entered = Promise.all(children.slice(0, 2).map(ready));
      const calls = Promise.all(clients.map((client) => client.callTool({ name: "mock_write", arguments: { text: "one", operationId: "shared" } }, undefined, { signal: AbortSignal.timeout(7000) })));
      void calls.catch(() => {});
      assert.deepEqual(await entered, ["entered", "entered"]);
      await stop(lock);
      const results = await calls;
      assert.deepEqual(results[0], results[1]);
      assert.equal(results[0]?.isError, undefined);
      const db = new DatabaseSync(path);
      try {
        assert.equal(db.prepare("SELECT count(*) AS n FROM mock_effects").get()?.n, 1);
        assert.equal(db.prepare("SELECT count(*) AS n FROM mock_operations").get()?.n, 1);
        const saved = db.prepare("SELECT result FROM mock_operations").get();
        assert.deepEqual(JSON.parse(String(saved?.result)), results[0]);
      } finally { db.close(); }
    } finally { await Promise.all(clients.map((client) => client.close())); }
  } finally {
    await Promise.all(children.map(stop));
    await rm(dir, { recursive: true, force: true });
  }
});

test("台账规范化对象键并拒绝跨工具和参数冲突", () => {
  const ledger = new MockLedger(":memory:");
  try {
    const first = ledger.write("op", "tool-a", { text: "x", meta: { a: 1, b: 2 } });
    assert.deepEqual(ledger.write("op", "tool-a", { meta: { b: 2, a: 1 }, text: "x" }), first);
    assert.equal(ledger.write("op", "tool-b", { text: "x", meta: { a: 1, b: 2 } }), undefined);
    assert.equal(ledger.write("op", "tool-a", { text: "y", meta: { a: 1, b: 2 } }), undefined);
    assert.deepEqual(ledger.effects(), ["x"]);
  } finally { ledger.close(); }
});

test("结果保存失败时效果和操作记录均回滚", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mock-mcp-rollback-"));
  const path = join(dir, "mock.sqlite");
  const ledger = new MockLedger(path);
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TRIGGER fail_operation BEFORE INSERT ON mock_operations BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
    assert.throws(() => ledger.write("op", "tool", { text: "x" }), /forced failure/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mock_effects").get()?.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mock_operations").get()?.n, 0);
    db.exec("DROP TRIGGER fail_operation");
    assert.ok(ledger.write("op", "tool", { text: "x" }));
    assert.deepEqual(ledger.effects(), ["x"]);
  } finally { db.close(); ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test("操作标识和效果中的 NUL 与未配对代理项在重启后无损区分", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mock-mcp-unicode-"));
  const path = join(dir, "mock.sqlite");
  let server = await startMockMcp(0, path);
  const call = async (operationId: string, text: string) => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    try { return await client.callTool({ name: "mock_write", arguments: { operationId, text } }); }
    finally { await client.close(); }
  };
  try {
    const inputs = [["id\u0000a", "text\u0000a"], ["id\u0000b", "text\u0000b"], ["\ud800", "\ud800"], ["\ud801", "\ud801"]] as const;
    const first = [];
    for (const [id, text] of inputs) first.push(await call(id, text));
    assert.deepEqual(server.effects(), inputs.map(([, text]) => text));
    await server.close();
    server = await startMockMcp(0, path);
    for (let i = 0; i < inputs.length; i++) assert.deepEqual(await call(inputs[i]![0], inputs[i]![1]), first[i]);
    assert.deepEqual(server.effects(), inputs.map(([, text]) => text));
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("成功提交后丢失响应，显式重发返回保存结果且不重复产生效果", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mock-mcp-response-loss-"));
  const path = join(dir, "mock.sqlite");
  const server = await startMockMcp(0, path, { dropResponseOnceForOperationId: "target" });
  let calls = 0;
  const client = new Client({ name: "test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    fetch: async (input, init) => {
      if (typeof init?.body === "string" && JSON.parse(init.body).method === "tools/call") calls++;
      return fetch(input, init);
    },
  });
  try {
    await client.connect(transport);
    assert.equal((await client.callTool({ name: "mock_read", arguments: { operationId: "target", text: "read" } })).isError, undefined);
    assert.equal((await client.callTool({ name: "mock_write", arguments: { operationId: "target", text: "" } })).isError, true);
    assert.equal((await client.callTool({ name: "mock_write", arguments: { operationId: "other", text: "other" } })).isError, undefined);
    assert.equal((await client.callTool({ name: "mock_write", arguments: { operationId: "other", text: "conflict" } })).isError, true);
    const args = { operationId: "target", text: "once" };
    await assert.rejects(client.callTool({ name: "mock_write", arguments: args }, undefined, { signal: AbortSignal.timeout(5000) }));
    assert.equal(calls, 5);
    const db = new DatabaseSync(path);
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM mock_effects WHERE operation_id = ?").get(JSON.stringify("target"))?.n, 1);
      const row = db.prepare("SELECT result FROM mock_operations WHERE operation_id = ?").get(JSON.stringify("target"));
      const saved: unknown = JSON.parse(String(row?.result));
      assert.deepEqual(saved, { content: [{ type: "text", text: "once" }], structuredContent: { text: "once", operationId: "target" } });
      assert.deepEqual(await client.callTool({ name: "mock_write", arguments: args }), saved);
      assert.equal(calls, 6);
      assert.equal(db.prepare("SELECT count(*) AS n FROM mock_effects WHERE operation_id = ?").get(JSON.stringify("target"))?.n, 1);
    } finally { db.close(); }
  } finally { await client.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("目标操作冲突不消耗故障，未重新配置的服务重启后不再注入", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mock-mcp-fault-scope-"));
  const path = join(dir, "mock.sqlite");
  const ledger = new MockLedger(path);
  const saved = ledger.write("target", "mock_write", { text: "original" });
  ledger.close();
  let server = await startMockMcp(0, path, { dropResponseOnceForOperationId: "target" });
  const call = async (text: string) => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    try { return await client.callTool({ name: "mock_write", arguments: { operationId: "target", text } }, undefined, { signal: AbortSignal.timeout(5000) }); }
    finally { await client.close(); }
  };
  try {
    assert.equal((await call("conflict")).isError, true);
    await assert.rejects(call("original"));
    assert.deepEqual(await call("original"), saved);
    await server.close();
    server = await startMockMcp(0, path);
    assert.deepEqual(await call("original"), saved);
    assert.deepEqual(server.effects(), ["original"]);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});
