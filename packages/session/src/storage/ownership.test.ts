import { test } from "node:test";
import { once } from "node:events";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { acquireInstanceOwnership, acquireSessionOwnership, OwnershipConflictError } from "./ownership.ts";

test("规范化路径共享实例锁，独立会话互不阻塞且释放后可重取", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-owner-"));
  try {
    const db = join(dir, "session.sqlite");
    const instance = await acquireInstanceOwnership(db);
    await assert.rejects(acquireInstanceOwnership(relative(process.cwd(), db)), OwnershipConflictError);
    const a = await acquireSessionOwnership(db, "a");
    await assert.rejects(acquireSessionOwnership(db, "a"), OwnershipConflictError);
    const b = await acquireSessionOwnership(db, "b");
    await a.release();
    const again = await acquireSessionOwnership(db, "a");
    await again.release(); await b.release(); await instance.release(); await instance.release();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("独立进程竞争并在持有者退出后释放所有权", async () => {
  const { spawn } = await import("node:child_process");

  const dir = await mkdtemp(join(tmpdir(), "mharness-process-"));
  const db = join(dir, "test.sqlite");
  const loader = new URL("../../../../apps/server/node_modules/tsx/dist/loader.mjs", import.meta.url).href;
  const moduleUrl = new URL("./ownership.ts", import.meta.url).href;
  const script = `const m = await import(${JSON.stringify(moduleUrl)}); await m.acquireInstanceOwnership(process.argv[1]); await m.acquireSessionOwnership(process.argv[1], "a"); console.log("ready"); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--import", loader, "--input-type=module", "-e", script, "test.sqlite"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const ready = await Promise.race([
      once(child.stdout, "data").then((data: unknown[]) => String(data[0])),
      once(child, "exit").then(() => { throw new Error("持锁进程提前退出"); }),
    ]);
    assert.match(ready, /ready/);
    await assert.rejects(acquireInstanceOwnership(db), OwnershipConflictError);
    await assert.rejects(acquireSessionOwnership(db, "a"), OwnershipConflictError);
    const b = await acquireSessionOwnership(db, "b"); await b.release();
    child.kill(); await once(child, "exit");
    const instance = await acquireInstanceOwnership(db);
    const a = await acquireSessionOwnership(db, "a");
    await a.release(); await instance.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); }
    await rm(dir, { recursive: true, force: true });
  }
});

test("锁连接关闭失败后再次释放不能虚报成功", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-owner-close-"));
  const db = join(dir, "session.sqlite");
  const lock = await acquireSessionOwnership(db, "a");
  const { DatabaseSync } = await import("node:sqlite");
  const close = DatabaseSync.prototype.close;
  let fail = true;
  let failedConnection: InstanceType<typeof DatabaseSync> | undefined;
  t.mock.method(DatabaseSync.prototype, "close", function (this: InstanceType<typeof DatabaseSync>) {
    if (fail && (!failedConnection || failedConnection === this)) { failedConnection = this; throw new Error("close fault"); }
    return close.call(this);
  });
  try {
    await assert.rejects(lock.release(), /close fault/);
    await assert.rejects(lock.release(), /close fault/);
    await assert.rejects(acquireSessionOwnership(db, "a"), OwnershipConflictError);
    fail = false;
    await lock.release();
    const next = await acquireSessionOwnership(db, "a");
    await next.release();
  } finally { fail = false; await lock.release(); if (failedConnection) { try { close.call(failedConnection); } catch {} } await rm(dir, { recursive: true, force: true }); }
});

test("连接实际关闭但回执异常时认可锁已释放", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-owner-receipt-"));
  const db = join(dir, "session.sqlite");
  const lock = await acquireSessionOwnership(db, "a");
  const { DatabaseSync } = await import("node:sqlite");
  const close = DatabaseSync.prototype.close;
  let first = true;
  t.mock.method(DatabaseSync.prototype, "close", function (this: InstanceType<typeof DatabaseSync>) {
    close.call(this);
    if (first) { first = false; throw new Error("receipt fault"); }
  });
  try {
    await lock.release();
    await lock.release();
    const next = await acquireSessionOwnership(db, "a");
    await next.release();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
