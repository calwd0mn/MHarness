import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ErrorCode, ListToolsResultSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import Ajv2020 from "ajv/dist/2020.js";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv from "ajv";
import { z } from "zod";
import { toolGovernance, type RegisteredTool, type ToolGovernance, type ToolRegistry } from "./registry.ts";
import { snapshotToolJson, type ToolResult } from "./result.ts";

/** 由受信任配置指定工具版本和治理策略。 */
export type McpToolConfig = { name: string; version: string } & Partial<Omit<ToolGovernance, "executionBoundary" | "cancellationGuarantee">>;
const defaults: McpToolConfig[] = [
  { name: "mock_read", version: "1", sideEffect: "read-only", approvalPolicy: "allow" },
  { name: "mock_write", version: "1", sideEffect: "side-effect", approvalPolicy: "ask" },
];
const rawResult = z.unknown();
function failure(code: string, message: string): ToolResult {
  return { isError: true, error: { message, info: { name: code === "INVALID_TOOL_OUTPUT" ? "InvalidToolOutputError" : "McpError", code } }, content: [{ type: "text", text: message }] };
}
function modelSchema(schema: Record<string, unknown>): { schema: Record<string, unknown>; inject: boolean } {
  const declared = typeof schema.properties === "object" && schema.properties !== null && Object.hasOwn(schema.properties, "operationId");
  if (!declared) return { schema, inject: false };
  const hasReference = (value: unknown): boolean => typeof value === "object" && value !== null && Object.entries(value).some(([key, child]) => ["$ref", "$dynamicRef", "$recursiveRef"].includes(key) || hasReference(child));
  if (hasReference(schema)) throw new Error("MCP 保留字段 Schema 不支持引用");
  const allowed = new Set(["$schema", "$id", "type", "properties", "required", "additionalProperties", "description", "title"]);
  if (Object.keys(schema).some((key) => !allowed.has(key)) || schema.type !== "object" || typeof schema.properties !== "object" || schema.properties === null || Array.isArray(schema.properties) || !Array.isArray(schema.required) || !schema.required.includes("operationId")) throw new Error("MCP 输入 Schema 无法安全排除 operationId");
  const properties = { ...schema.properties as Record<string, unknown> };
  if (typeof properties.operationId !== "object" || properties.operationId === null || Reflect.get(properties.operationId, "type") !== "string") throw new Error("MCP operationId 必须是字符串");
  delete properties.operationId;
  return { schema: { ...schema, properties, required: schema.required.filter((key) => key !== "operationId"), not: { required: ["operationId"] } }, inject: true };
}
/**
 * 连接 MCP 并注册可信配置选择的工具；批次注入 operationId 后复验完整输入。
 * @param registry - 接收远端工具的注册表。
 * @param endpoint - MCP Streamable HTTP 地址。
 * @param selected - 可信版本与治理策略；省略时使用模拟工具配置。
 * @returns 持有 SDK 连接的关闭接口，调用方须在退出时关闭。
 * @throws 连接、目录或 Schema 不受支持时 Promise 拒绝。
 */
export async function connectMcpTools(registry: ToolRegistry, endpoint: string, selected: readonly McpToolConfig[] = defaults): Promise<{ close(): Promise<void> }> {
  const client = new Client({ name: "mharness", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const listed = await client.request({ method: "tools/list" }, ListToolsResultSchema);
    const validator = (schema: Record<string, unknown>) => {
      const dialect = schema.$schema;
      const ajv = dialect === "http://json-schema.org/draft-07/schema#" ? new Ajv({ strict: false })
        : dialect === "https://json-schema.org/draft/2019-09/schema" ? new Ajv2019({ strict: false })
        : new Ajv2020({ strict: false });
      return ajv.compile(schema);
    };
    for (const config of selected) {
      const remote = listed.tools.find((tool) => tool.name === config.name);
      if (!remote) throw new Error(`MCP 工具不存在: ${config.name}`);
      const projection = modelSchema(remote.inputSchema);
      const projected = projection.schema;
      const validateModel = validator(projected);
      const validateFull = validator(remote.inputSchema);
      const validateOutput = remote.outputSchema ? validator(remote.outputSchema) : undefined;
      const policy = toolGovernance({ ...config, cancellationGuarantee: "none" }, "remote");
      const definition = { name: remote.name, description: remote.description ?? "", inputSchema: projected };
      const tool: RegisteredTool = { name: remote.name, definition, governance: policy,
        prepare(value) {
          if (!value || typeof value !== "object" || Array.isArray(value) || (projection.inject && Object.hasOwn(value, "operationId")) || !validateModel(value)) return { ok: false, code: "INVALID_INPUT" };
          const args = structuredClone(value);
          const freeze = (item: object): void => { for (const child of Object.values(item)) if (child && typeof child === "object") freeze(child); Object.freeze(item); };
          freeze(args);
          const execute = async (signal = new AbortController().signal, operationId?: string): Promise<unknown> => {
            const full = projection.inject ? { ...args, operationId } : args;
            if (!validateFull(full)) throw new Error("完整工具参数校验失败。");
            return client.request({ method: "tools/call", params: { name: remote.name, arguments: full } }, rawResult, { signal });
          };
          const executeNormalized = async (signal: AbortSignal, operationId?: string): Promise<ToolResult> => {
            const full = projection.inject ? { ...args, operationId } : args;
            if (!validateFull(full)) return failure("INVALID_INPUT", "完整工具参数校验失败。");
            let result: unknown;
            try { result = await execute(signal, operationId); }
            catch (error) {
              if (error instanceof z.ZodError) return failure("INVALID_TOOL_OUTPUT", "工具输出不符合结果契约。");
              const protocol = error instanceof SyntaxError || (error instanceof McpError && error.code !== ErrorCode.ConnectionClosed && error.code !== ErrorCode.RequestTimeout);
              return failure(protocol ? "MCP_PROTOCOL_ERROR" : "MCP_TRANSPORT_ERROR", "MCP 调用失败。");
            }
            if (!remote.outputSchema && (typeof result !== "object" || result === null || !Object.hasOwn(result, "content"))) return failure("INVALID_TOOL_OUTPUT", "工具输出不符合结果契约。");
            const parsed = CallToolResultSchema.safeParse(result);
            if (!parsed.success) return failure("INVALID_TOOL_OUTPUT", "工具输出不符合结果契约。");
            let content;
            try { content = snapshotToolJson(parsed.data.content); }
            catch { return failure("INVALID_TOOL_OUTPUT", "工具输出不符合结果契约。"); }
            if (!Array.isArray(content)) return failure("INVALID_TOOL_OUTPUT", "工具输出不符合结果契约。");
            if (parsed.data.isError) return { isError: true, error: { message: "MCP 工具返回错误。", info: { name: "McpToolError", code: "MCP_TOOL_ERROR" } }, content };
            if (validateOutput && (parsed.data.structuredContent === undefined || !validateOutput(parsed.data.structuredContent))) return failure("INVALID_TOOL_OUTPUT", "工具输出不符合结果契约。");
            try { return { isError: false, content, ...(parsed.data.structuredContent !== undefined ? { value: snapshotToolJson(parsed.data.structuredContent) } : {}) }; }
            catch { return failure("INVALID_TOOL_OUTPUT", "工具输出不符合结果契约。"); }
          };
          return { ok: true, call: { name: remote.name, version: config.version, governance: policy, args, execute, executeNormalized } };
        },
      };
      registry.register(tool);
    }
    return { close: () => client.close() };
  } catch (error) { await client.close(); throw error; }
}
