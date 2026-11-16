import {
  createSessionRequestSchema,
  createSessionResponseSchema,
  promptRequestSchema,
  promptResponseSchema,
  rawSessionHistorySchema,
  sessionParamsSchema,
} from "@mharness/session/contracts";
import { createPersistedSession, readPersistedSessionHistory, type SessionPersistence } from "@mharness/session/server";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { AgentManager } from "../agent/manager.ts";
import { AgentError } from "../agent/react-agent.ts";
import type { SessionCommandController } from "../commands.ts";
import { followSession } from "./follow.ts";

/**
 * 注册 Session 的 HTTP 和 SSE 边界。应用开始关闭时释放所有订阅。
 * @param app - 拥有 HTTP 连接的应用。
 * @param path - 会话集合路由。
 * @param persistence - 在线存储，创建提交及历史读取在此完成。
 * @param commands - 接收已校验的提交和取消命令。
 * @param agents - 供 follow 观察已加载 Agent，订阅不触发加载。
 */
export function registerSessionRoutes(
  app: FastifyInstance,
  path: string,
  persistence: SessionPersistence,
  commands: Pick<SessionCommandController, "prompt" | "cancel">,
  agents: Pick<AgentManager, "get" | "onLoaded">,
): void {
  const single = `${path}/:sessionId`;
  const connections = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const close of connections) close();
  });

  app.post(path, async (request, reply) => {
    if (!createSessionRequestSchema.safeParse(request.body === undefined ? {} : request.body).success) {
      return reply.code(400).send({ code: "invalid_request" });
    }
    const sessionId = randomUUID();
    await createPersistedSession(persistence, { sessionId, createdAt: Date.now() });
    return reply.code(201).send(createSessionResponseSchema.parse({ sessionId }));
  });

  app.post(`${single}/messages`, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = promptRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ code: "invalid_request" });
    try {
      const result = await commands.prompt({ ...params.data, ...body.data });
      return reply.code(202).send(promptResponseSchema.parse(result));
    } catch (error: unknown) {
      if (!(error instanceof AgentError)) throw error;
      if (error.code === "session/not-found") return reply.code(404).send({ code: error.code });
      if (error.code === "agent_busy") return reply.code(409).send({ code: error.code });
      return reply.code(503).send({ code: error.code });
    }
  });

  app.post(`${single}/cancel`, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: "invalid_request" });
    try {
      return reply.code(202).send(await commands.cancel(params.data.sessionId));
    } catch (error: unknown) {
      if (error instanceof AgentError && error.code === "session/not-found") {
        return reply.code(404).send({ code: error.code });
      }
      throw error;
    }
  });

  app.get(single, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: "invalid_request" });
    const history = await readPersistedSessionHistory(persistence, params.data.sessionId);
    if (!history) return reply.code(404).send({ code: "session_not_found" });
    return rawSessionHistorySchema.parse(history);
  });

  app.get(`${single}/follow`, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: "invalid_request" });
    const { sessionId } = params.data;
    const connection = new AbortController();
    const release = () => {
      connections.delete(close);
      connection.abort();
    };
    reply.raw.once("close", release);
    const stream = Readable.from(followSession(
      agents,
      () => readPersistedSessionHistory(persistence, sessionId),
      sessionId,
      connection.signal,
      (error) => app.log.error({ err: error }, "会话订阅失败"),
    ));
    const close = () => {
      connection.abort();
      stream.destroy();
      reply.raw.destroy();
    };
    connections.add(close);
    stream.once("close", release);
    return reply
      .header("Cache-Control", "no-cache")
      .type("text/event-stream; charset=utf-8")
      .send(stream);
  });
}
