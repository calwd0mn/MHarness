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
