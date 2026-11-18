import {
  createSessionRequestSchema,
  createSessionResponseSchema,
  sessionHistoryResponseSchema,
  sessionParamsSchema,
  submitMessageRequestSchema,
  submitMessageResponseSchema,
} from "@mharness/session/contracts";
import {
  acquireInstanceOwnership,
  recoverInterruptedSession,
  SqliteSessionPersistence,
  type SessionStore,
} from "@mharness/session/server";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { healthPath, healthResponseSchema } from "../../../config/health.ts";
import { localConfig } from "../../../config/local.ts";
import { AgentManager } from "./agent/manager.ts";
import { createModelTurnDriver } from "./agent/model-turn.ts";
import { ToolRegistry } from "./tools/registry.ts";
import type { RunTurn } from "./agent/react-agent.ts";
import { SessionCommandController } from "./commands.ts";
import { createMockAdapter } from "./model/providers/mock.ts";
import { createDeepSeekAdapter } from "./model/providers/deepseek.ts";
import type { ModelConfig } from "./model/runtime.ts";
import { LlmRuntime } from "./model/runtime.ts";
import { registerSessionRoutes } from "./session/routes.ts";
import { ApprovalService } from "./approval/service.ts";
import { registerApprovalRoutes } from "./approval/routes.ts";

const sessionsPath = `${localConfig.apiPrefix}/sessions`;

const deepseekModel = "deepseek-v4-pro";

function configuredBudget(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) throw new TypeError(`${name} 必须是十进制正整数`);
  return Number(value);
}

function configuredModel(): ModelConfig {
  const provider = process.env.MHARNESS_MODEL_PROVIDER ?? "mock";
  if (provider === "mock") return { provider, model: "test-model" };
  if (provider !== "deepseek") throw new TypeError("不支持的模型 Provider");
  const number = (name: string) => process.env[name] === undefined ? undefined : Number(process.env[name]);
  const stopValue = process.env.MHARNESS_MODEL_STOP;
  const stop: unknown = stopValue === undefined ? undefined : JSON.parse(stopValue);
  if (stop !== undefined && (!Array.isArray(stop) || stop.some((value: unknown) => typeof value !== "string"))) throw new TypeError("MHARNESS_MODEL_STOP 需要 JSON 字符串数组");
  const maxOutputTokens = number("MHARNESS_MODEL_MAX_TOKENS");
  const temperature = number("MHARNESS_MODEL_TEMPERATURE");
  const reasoningEffort = process.env.MHARNESS_MODEL_REASONING_EFFORT;
  return { provider, model: deepseekModel, params: {
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(stop === undefined ? {} : { stop: stop as string[] }),
  } };
}

function createHttpApp(logger: boolean) {
  const app = Fastify({ logger });
  app.get(`${localConfig.apiPrefix}${healthPath}`, async () =>
    healthResponseSchema.parse({ status: "ok" }),
  );
  return app;
}

/**
 * 组装会话 HTTP 接口，并在开始处理请求前结算遗留 Turn。
 * 调用方应独占数据库并在退出前关闭返回的应用。恢复失败时应用启动失败。
 * @param store - 由应用接管的会话存储，关闭应用时一并释放。
 * @param logger - 是否输出 HTTP 日志，默认关闭。
 * @returns 尚未监听端口的 Fastify 应用，可用于请求注入测试。
 */
export function createApp(store: SessionStore, logger = false) {
  const app = createHttpApp(logger);

  app.addHook("onReady", async () => {
    store.recoverInterruptedTurns();
  });

  app.addHook("onClose", async () => {
    store.close();
  });

  app.post(sessionsPath, async (request, reply) => {
    const body = createSessionRequestSchema.safeParse(
      request.body === undefined ? {} : request.body,
    );
    if (!body.success) return reply.code(400).send({ code: "invalid_request" });

    const sessionId = randomUUID();
    store.createSession(sessionId);
    return reply.code(201).send(createSessionResponseSchema.parse({ sessionId }));
  });

  app.post(`${sessionsPath}/:sessionId/messages`, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = submitMessageRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ code: "invalid_request" });
    }

    const { sessionId } = params.data;
    const turnId = randomUUID();
    const result = store.acceptTurn(sessionId, turnId, body.data.text);
    if (result.status === "not_found") {
      return reply.code(404).send({ code: "session_not_found" });
    }
    if (result.status === "busy") return reply.code(409).send({ code: "turn_active" });

    return reply.code(202).send(submitMessageResponseSchema.parse({ sessionId, turnId }));
  });

  app.get(`${sessionsPath}/:sessionId`, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: "invalid_request" });

    const { sessionId } = params.data;
    const history = store.readSession(sessionId);
    if (!history) return reply.code(404).send({ code: "session_not_found" });

    const latestTurn = history.records.findLast((record) => record.type === "turn/status");
    return sessionHistoryResponseSchema.parse({
      sessionId,
      ...history,
      latestTurn: latestTurn?.data ?? null,
    });
  });

  return app;
}

/**
 * 取得新版库的在线实例锁并组装会话创建和持久历史接口。应用开始服务前完成遗留会话修复。
 * @param path - 新版库路径，父目录必须存在。
 * @param logger - 是否启用 HTTP 日志，默认关闭。
 * @param runTurn - 可替换的 Turn 驱动，默认使用进程内模拟模型。
 * @param options - 可注入工具注册表、共享审批服务和模型 HTTP 传输；默认提供 HTTP 审批渠道。
 * @returns 尚未开始监听的应用；调用方须关闭应用以释放存储及实例锁。
 * @throws 实例锁冲突或存储格式不受支持时拒绝；后续修复失败会使应用启动失败。
 */
export async function createEventSessionApp(path: string, logger = false, runTurn?: RunTurn, options: { approvalService?: ApprovalService; toolRegistry?: ToolRegistry; modelFetch?: typeof fetch } = {}) {
  const ownership = await acquireInstanceOwnership(path);
  let persistence: SqliteSessionPersistence;
  try {
    persistence = new SqliteSessionPersistence(path);
  } catch (error) {
    await ownership.release();
    throw error;
  }
  const app = createHttpApp(logger);
  const approvalService = options.approvalService ?? new ApprovalService();
  const driver = runTurn ?? createModelTurnDriver({
    toolRegistry: options.toolRegistry, approvalService,
    runtime: new LlmRuntime({ mock: { ...createMockAdapter((request) => {
      const text = request.messages.findLast((message) => message.role === "user")?.text ?? "";
      return [
        { delayMs: 100, chunk: { type: "text", delta: "模拟回答：" } },
        { delayMs: 150, chunk: { type: "text", delta: text } },
        { chunk: { type: "finish", reason: { kind: "stop" } } },
      ];
    }), modelBudgets: { "test-model": { contextWindow: 100_000, defaultOutputTokens: 2_000 } } }, deepseek: () => {
      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (!apiKey?.trim()) throw new TypeError("DEEPSEEK_API_KEY 必须配置");
      const contextWindow = configuredBudget("MHARNESS_MODEL_CONTEXT_WINDOW");
      const defaultOutputTokens = configuredBudget("MHARNESS_MODEL_DEFAULT_OUTPUT_TOKENS");
      return { ...createDeepSeekAdapter({ apiKey, ...(options.modelFetch ? { fetch: options.modelFetch } : {}) }),
        modelBudgets: { [deepseekModel]: { ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(defaultOutputTokens === undefined ? {} : { defaultOutputTokens }) } } };
    } }),
    config: configuredModel,
    systemPrompt: () => "你是一个中文助手。",
  });
  const agents = new AgentManager(persistence, driver);
  const commands = new SessionCommandController(agents);
  app.addHook("onReady", async () => {
    for (const { header } of await persistence.list()) {
      const handle = await persistence.open(header.sessionId, "write");
      if (!handle) throw new Error(`待恢复会话已不可见: ${header.sessionId}`);
      try {
        await recoverInterruptedSession(handle);
      } finally {
        await handle.close();
      }
    }
  });
  app.addHook("onClose", async () => {
    try {
      try {
        await agents.close();
      } finally {
        await persistence.close();
      }
    } finally {
      await ownership.release();
    }
  });
  registerSessionRoutes(app, sessionsPath, persistence, commands, agents);
  registerApprovalRoutes(app, sessionsPath, persistence, agents, approvalService);
  return app;
}
