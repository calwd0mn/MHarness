import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import Ajv2020 from "ajv/dist/2020.js";
import { defineLocalToolOutput, HarnessError, normalizeLocalToolResult as normalizeDefinedResult, normalizeToolError } from "./result.ts";

function normalizeLocalToolResult<Args, Value>(
  definition: { schema: z.ZodType<Value>; render: (args: Args, value: Value) => unknown; presentationMeta?: (args: Args, value: Value) => unknown },
  args: Args, candidate: unknown, concludeTurn?: boolean,
) {
  return normalizeDefinedResult(defineLocalToolOutput(definition), args, candidate, concludeTurn);
}
const schema = z.strictObject({ text: z.string(), nested: z.strictObject({ count: z.number() }) });

test("校验并冻结独立快照，同一值派生内容和展示数据", () => {
  const candidate = { text: "原文", nested: { count: 1 } };
  const args = { path: "/a" };
  const result = normalizeLocalToolResult({
    schema,
    render: (input, value) => [{ type: "text", text: `${input.path}:${value.text}:${value.nested.count}` }],
    presentationMeta: (input, value) => ({ path: input.path, count: value.nested.count }),
  }, args, candidate, true);
  candidate.nested.count = 9;
  args.path = "/b";
  assert.equal(result.isError, false);
  if (result.isError) return;
  assert.deepEqual(result.value, { text: "原文", nested: { count: 1 } });
  assert.deepEqual(result.content, [{ type: "text", text: "/a:原文:1" }]);
  assert.deepEqual(result.meta, { path: "/a", count: 1 });
  assert.equal(result.concludeTurn, true);
  assert.ok(Object.isFrozen(result.value.nested));
});

test("无效值不调用渲染，输出契约失败不泄漏成功值或异常", () => {
  let calls = 0;
  const output = { schema, render: () => { calls++; return []; } };
  for (const candidate of [{ text: "secret", nested: { count: "bad" } }, { text: "secret", nested: { count: NaN } }]) {
    const result = normalizeLocalToolResult(output, {}, candidate, true);
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal("value" in result, false);
    assert.equal("concludeTurn" in result, false);
    if (result.isError) assert.equal(result.error.info?.code, "INVALID_TOOL_OUTPUT");
  }
  assert.equal(calls, 0);
});

test("渲染不能修改参数或值，渲染异常和无效 content 安全失败", () => {
  const candidate = { text: "secret", nested: { count: 1 } };
  const args = { path: "/a" };
  for (const render of [
    (input: typeof args) => { input.path = "modified"; return []; },
    () => { throw new Error("secret exception"); },
    () => [undefined],
  ]) {
    const result = normalizeLocalToolResult({ schema, render }, args, candidate, true);
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal("concludeTurn" in result, false);
  }
  assert.equal(args.path, "/a");
});

test("无效展示数据和派生异常均安全失败", () => {
  for (const presentationMeta of [() => ({ missing: undefined }), () => { throw new Error("secret"); }]) {
    const result = normalizeLocalToolResult({ schema, render: () => ["ok"], presentationMeta }, {}, { text: "x", nested: { count: 1 } }, true);
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal("value" in result, false);
    assert.equal("concludeTurn" in result, false);
  }
});

test("普通错误只返回安全说明，可信 HarnessError 保留稳定分类", () => {
  const plain = normalizeToolError(Object.assign(new Error("password"), { concludeTurn: true }));
  assert.equal(JSON.stringify(plain).includes("password"), false);
  assert.equal("concludeTurn" in plain, false);
  assert.equal(plain.error.info, undefined);
  const trusted = normalizeToolError(new HarnessError("安全说明", "BusinessError", "BUSINESS_ERROR"));
  assert.deepEqual(trusted.error.info, { name: "BusinessError", code: "BUSINESS_ERROR" });
  assert.equal(trusted.error.message, "安全说明");
});

test("值快照不可被渲染修改，失败后不调用展示派生", () => {
  let metaCalls = 0;
  const candidate = { text: "原文", nested: { count: 1 } };
  const result = normalizeLocalToolResult({
    schema,
    render: (_args, value) => { value.nested.count = 42; return ["unexpected"]; },
    presentationMeta: () => { metaCalls++; return {}; },
  }, {}, candidate, true);
  assert.equal(result.isError, true);
  assert.equal(metaCalls, 0);
  assert.equal(candidate.nested.count, 1);
});

test("拒绝不能无损保存的值和展示数据", () => {
  const invalidValues: unknown[] = [undefined, NaN, Infinity, -0, () => 1, { extra: undefined }, [1, , 3]];
  for (const invalid of invalidValues) {
    const result = normalizeLocalToolResult({ schema: z.string(), render: () => [] }, {}, invalid);
    assert.equal(result.isError, true);
  }
  for (const invalid of invalidValues) {
    const result = normalizeLocalToolResult({ schema: z.string(), render: () => [], presentationMeta: () => invalid }, {}, "ok");
    assert.equal(result.isError, true);
  }
});

test("输出定义公开同源 JSON Schema 并拒绝不可等价的 Zod 规则", () => {
  const output = defineLocalToolOutput({ schema: z.strictObject({ count: z.number().int().min(1) }), render: () => [] });
  assert.equal(output.schema.type, "object");
  assert.deepEqual(output.schema.required, ["count"]);
  assert.equal(output.schema.additionalProperties, false);
  for (const invalid of [z.string().transform((s) => s.trim()), z.string().refine(() => true), z.coerce.number(), z.string().default("x")] as z.ZodType[]) {
    assert.throws(() => defineLocalToolOutput({ schema: invalid, render: () => [] }));
  }
});

test("输出 JSON Schema 与实际值校验对边界输入一致", () => {
  const output = defineLocalToolOutput({
    schema: z.strictObject({ count: z.number().int().min(1).max(5), text: z.string().min(2) }),
    render: (_args: object, value) => [value.text],
  });
  const validate = new Ajv2020().compile(output.schema);
  for (const candidate of [
    { count: 1, text: "ok" }, { count: 0, text: "ok" }, { count: 6, text: "ok" },
    { count: 2.5, text: "ok" }, { count: "2", text: "ok" }, { count: 2 },
    { count: 2, text: "a" }, { count: 2, text: "ok", extra: true },
  ]) {
    assert.equal(!normalizeDefinedResult(output, {}, candidate).isError, validate(candidate));
  }
  assert.ok(Object.isFrozen(output.schema));
  assert.ok(Object.isFrozen(output.schema.properties));
});
