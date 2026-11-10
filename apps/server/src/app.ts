import {
  createSessionRequestSchema,
  createSessionResponseSchema,
  healthPath,
  healthResponseSchema,
  sessionHistoryResponseSchema,
  sessionParamsSchema,
  submitMessageRequestSchema,
  submitMessageResponseSchema,
} from "@mharness/protocol";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { localConfig } from "../../../config/local.ts";
import type { SessionStore } from "./storage/session-store.ts";

/**
 * 组装会话 HTTP 接口，并在开始处理请求前结算遗留 Turn。
 * 调用方应独占数据库并在退出前关闭返回的应用。恢复失败时应用启动失败。
 * @param store - 由应用接管的会话存储，关闭应用时一并释放。
 * @param logger - 是否输出 HTTP 日志，默认关闭。
 * @returns 尚未监听端口的 Fastify 应用，可用于请求注入测试。
 */
export function createApp(store: SessionStore, logger = false) {
  const app = Fastify({ logger });
  const sessionsPath = `${localConfig.apiPrefix}/sessions`;

  app.addHook("onReady", async () => {
    store.recoverInterruptedTurns();
  });

  app.addHook("onClose", async () => {
    store.close();
  });

  app.get(`${localConfig.apiPrefix}${healthPath}`, async () =>
    healthResponseSchema.parse({ status: "ok" }),
  );

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
