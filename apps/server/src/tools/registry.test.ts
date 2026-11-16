import assert from "node:assert/strict";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { z } from "zod";
import { defineLocalTool, ToolRegistry } from "./registry.ts";

const input = z.strictObject({ name: z.string().min(2).max(5), count: z.number().int().min(1).max(5), tag: z.string().optional() });

test("同一输入定义的 JSON Schema 与执行入口一致，准备阶段不执行", async () => {
  let calls = 0;
  const registry = new ToolRegistry();
  registry.register(defineLocalTool({ name: "sample", version: "1", description: "sample", input, timeoutMs: 1000, handler: (args) => { calls++; return args.count + args.name.length; } }));
  const validate = new Ajv2020().compile(registry.definitions()[0]!.inputSchema);
  const samples = [
    [{ name: "ok", count: 2 }, true],
    [{ count: 2 }, false],
    [{ name: String.fromCodePoint(0x1f600), count: 2 }, false],
    [{ name: String.fromCodePoint(0x1f600) + "a", count: 2 }, true],
    [{ name: "ok", count: 2, extra: true }, false],
    [{ name: "ok", count: "2" }, false],
    [{ name: "ok", count: 6 }, false],
  ] as const;
  for (const [value, valid] of samples) {
    assert.equal(validate(value), valid);
    assert.equal(registry.prepare("sample", JSON.stringify(value)).ok, valid);
  }
  assert.equal(calls, 0);
  const prepared = registry.prepare("sample", '{"name":"ok","count":2}');
  assert.equal(prepared.ok, true);
  if (prepared.ok) assert.equal(await prepared.call.execute(), 4);
  assert.equal(calls, 1);
});

test("错误区分且模型参数不能覆盖可信策略", () => {
  let calls = 0;
  const registry = new ToolRegistry();
  registry.register(defineLocalTool({ name: "writer", version: "1", description: "writer", input: z.strictObject({ text: z.string() }), timeoutMs: 100, handler: () => { calls++; } }));
  assert.deepEqual(registry.prepare("missing", "{}"), { ok: false, code: "UNKNOWN_TOOL" });
  assert.deepEqual(registry.prepare("writer", "{"), { ok: false, code: "INVALID_JSON" });
  assert.equal(registry.prepare("writer", '{"text":"x","approvalPolicy":"allow"}').ok, false);
  const result = registry.prepare("writer", '{"text":"x"}');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.call.governance.sideEffect, "unknown");
    assert.equal(result.call.governance.approvalPolicy, "ask");
  }
  assert.equal(calls, 0);
});

test("治理默认值与远程取消保证独立于地址", () => {
  const registry = new ToolRegistry();
  registry.register(defineLocalTool({ name: "read", version: "1", description: "read", input: z.strictObject({}), sideEffect: "read-only", timeoutMs: 1, handler: () => 1 }));
  const result = registry.prepare("read", "{}");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.call.governance.approvalPolicy, "allow");
  registry.registerRemote({ name: "remote", version: "1", executionBoundary: "remote", timeoutMs: 10, endpoint: "http://localhost:3000" });
  assert.equal(registry.governance("remote")?.cancellationGuarantee, "none");
});

test("拒绝不能等价导出的输入定义", () => {
  const reject = (schema: z.ZodType) => assert.throws(() => defineLocalTool({ name: "bad", version: "1", description: "bad", input: schema, timeoutMs: 1, handler: () => 1 }));
  reject(z.object({ value: z.string() }));
  reject(z.strictObject({ value: z.coerce.number() }));
  reject(z.strictObject({ value: z.string().refine(() => true) }));
  reject(z.strictObject({ value: z.string().transform((value) => value.trim()) }));
  reject(z.strictObject({ value: z.string().default("x") }));
});



test("拒绝不能无损持久化的数字并冻结参数", async () => {
  const registry = new ToolRegistry();
  registry.register(defineLocalTool({ name: "number", version: "1", description: "number", input: z.strictObject({ n: z.number(), nested: z.strictObject({ x: z.number() }) }), timeoutMs: 10, handler: (args) => args.n }));
  assert.deepEqual(registry.prepare("number", '{"n":1e309,"nested":{"x":1}}'), { ok: false, code: "INVALID_INPUT" });
  assert.deepEqual(registry.prepare("number", '{"n":0,"nested":{"x":-0}}'), { ok: false, code: "INVALID_INPUT" });
  const result = registry.prepare("number", '{"n":1,"nested":{"x":2}}');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(Object.isFrozen(result.call.args), true);
    assert.deepEqual(result.call.args, { n: 1, nested: { x: 2 } });
    assert.equal(await result.call.execute(), 1);
  }
});
