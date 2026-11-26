import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sessionDirectorySnapshotSchema } from "@mharness/session/contracts";
import { SqliteSessionPersistence } from "@mharness/session/server";
import { createEventSessionApp } from "../app.ts";
import { SessionDirectory } from "./directory.ts";

const exitDuringFirstTurn = `
  import assert from "node:assert/strict";
  import { Session, SqliteSessionPersistence } from "@mharness/session/server";
  const [path, mode] = process.argv.slice(1);
  const store = new SqliteSessionPersistence(path);
  store.upgradeDirectoryMetadata();
  const session = new Session({ sessionId: "first-turn", createdAt: 10 });
  const handle = await store.create(session.header);
  await handle.flush();
  store.bindWriter(handle, session);
  session.append({ type: "turn/start", time: 20, data: { turn: 1 } });
  assert.equal(session.listMetadata.blank, false);
  if (mode === "committed") await session.flush();
  process.exit(0);
`;

for (const mode of ["uncommitted", "committed"] as const) {
  const blank = mode === "uncommitted";
  test(blank ? "首个 Turn 尚未提交时重启保留空检查点" : "首个 Turn 已提交时重启沿用可见的冷摘要", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "mharness-directory-restart-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "events.sqlite");
    await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module",
      "-e", exitDuringFirstTurn, path, mode], { cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 10_000 });

    const expected = { revision: 0, sessions: [
      { sessionId: "first-turn", createdAt: 10, updatedAt: 10, running: false, blank },
    ] };
    const reopened = new SqliteSessionPersistence(path, { readOnly: true });
    try {
      const [entry] = await reopened.list();
      assert.equal(entry?.eventCount, blank ? 0 : 1);
      assert.deepEqual(entry?.listMetadata, { blank: true, lastPromptAt: null, eventCount: 0, inheritedEventCount: 0 });
      // 应用启动会修复未结束的 Turn，须在修复前验证落后检查点的冷摘要。
      t.mock.method(reopened, "open", async () => { assert.fail("冷目录不应打开事件日志"); });
      const directory = await SessionDirectory.restore(reopened);
      assert.deepEqual(directory.snapshot(), expected);
      assert.deepEqual(await directory.query(reopened, () => undefined), expected);
    } finally {
      await reopened.close();
    }

    const app = await createEventSessionApp(path);
    try {
      const result = await app.inject({ method: "GET", url: "/api/sessions" });
      assert.equal(result.statusCode, 200);
      assert.deepEqual(sessionDirectorySnapshotSchema.parse(result.json()), expected);
    } finally {
      await app.close();
    }
  });
}
