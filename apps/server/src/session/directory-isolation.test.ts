import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSessionResponseSchema, sessionDirectorySnapshotSchema } from "@mharness/session/contracts";
import { createEventSessionApp } from "../app.ts";

test("独立数据库的会话目录在重开前后保持隔离", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mharness-directory-isolation-"));
  const apps: Array<Awaited<ReturnType<typeof createEventSessionApp>>> = [];
  const closeApps = async () => {
    const closed = await Promise.allSettled(apps.splice(0).map(async app => app.close()));
    const failed = closed.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
  };
  t.after(async () => {
    const [closed] = await Promise.allSettled([closeApps()]);
    try {
      await rm(dir, { recursive: true, force: true });
    } finally {
      if (closed.status === "rejected") throw closed.reason;
    }
  });
  const paths = [join(dir, "a.sqlite"), join(dir, "b.sqlite")];
  for (const path of paths) apps.push(await createEventSessionApp(path));

  const ids: string[] = [];
  for (const app of apps) {
    const response = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    assert.equal(response.statusCode, 201);
    ids.push(createSessionResponseSchema.parse(response.json()).sessionId);
  }
  assert.notEqual(ids[0], ids[1]);

  for (let i = 0; i < apps.length; i++) {
    const response = await apps[i].inject({ method: "GET", url: "/api/sessions" });
    assert.equal(response.statusCode, 200);
    const snapshot = sessionDirectorySnapshotSchema.parse(response.json());
    assert.deepEqual(snapshot.sessions.map(session => session.sessionId), [ids[i]]);
    assert.equal(snapshot.revision, 1);
  }

  await closeApps();
  for (const path of paths) apps.push(await createEventSessionApp(path));
  for (let i = 0; i < apps.length; i++) {
    const response = await apps[i].inject({ method: "GET", url: "/api/sessions" });
    assert.equal(response.statusCode, 200);
    const snapshot = sessionDirectorySnapshotSchema.parse(response.json());
    assert.deepEqual(snapshot.sessions.map(session => session.sessionId), [ids[i]]);
    assert.equal(snapshot.revision, 0);
  }
});
