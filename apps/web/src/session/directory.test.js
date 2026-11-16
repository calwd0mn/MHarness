import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDirectory, saveDirectory } from "./directory.ts";

test("恢复有效会话目录并拒绝无效选择", () => {
  const storage = { getItem: () => JSON.stringify({ sessions: ["a", "a", "", 2, "b"], selected: "missing" }), setItem() {} };
  assert.deepEqual(loadDirectory(storage), { sessions: ["a", "b"], selected: null });
  storage.getItem = () => JSON.stringify({ sessions: ["a", "b"], selected: "b" });
  assert.equal(loadDirectory(storage).selected, "b");
});
test("存储不可用或数据损坏时回退为空目录", () => {
  const storage = { getItem() { throw new Error(); }, setItem() { throw new Error(); } };
  assert.deepEqual(loadDirectory(storage), { sessions: [], selected: null });
  assert.doesNotThrow(() => saveDirectory(storage, { sessions: ["a"], selected: "a" }));
  assert.deepEqual(loadDirectory({ getItem: () => "{", setItem() {} }), { sessions: [], selected: null });
});
