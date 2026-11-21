import {
  compactRequestSchema,
  compactResponseSchema,
  compactErrorSchema,
  compactRejectionSchema,
  type CompactRequest,
  type CompactResponse,
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

const jsonMediaType = /^[\t ]*application\/json[\t ]*(?:;[\t ]*(?:[!#$%&'*+.^_`|~\w-]+=(?:[!#$%&'*+.^_`|~\w-]+|"(?:[\t !#-\[\]-~\x80-\xff]|\\[\t -~\x80-\xff])*")[\t ]*)?)*$/i;

/** 压缩命令由调用方持有；冲突表示该标识已被使用且本次未受理。 */
export interface CompactCommands {
  /** 等待已知终态；成功须确认批次并等待 flush，HTTP 连接关闭不会取消操作。 */
  compact?(request: CompactRequest & { sessionId: string }): Promise<CompactResponse | { code: "compaction_id_conflict" } | { commandId: string; result: { kind: "error"; text: string } }>;
}

/**
 * 注册 Session 的 HTTP 和 SSE 边界；压缩入口在调用命令前校验媒体类型、参数和正文，处理器异常返回脱敏错误。应用开始关闭时释放所有订阅。
 * @param app - 拥有 HTTP 连接的应用。
 * @param path - 会话集合路由。
 * @param persistence - 在线存储，创建提交及历史读取在此完成。
 * @param commands - 接收已校验的提交和取消命令；未提供压缩处理器时返回不可用。
 * @param agents - 供 follow 观察已加载 Agent，订阅不触发加载。
 */
export function registerSessionRoutes(
  app: FastifyInstance,
  path: string,
  persistence: SessionPersistence,
  commands: Pick<SessionCommandController, "prompt" | "cancel"> & CompactCommands,
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

  app.post(`${single}/compact`, {
    onRequest(request, reply, done) {
      if (!jsonMediaType.test(request.headers["content-type"] ?? "")) {
        void reply.code(415).send({ commandId: null, result: { kind: "error", text: "不支持的媒体类型" } });
        return;
      }
      done();
    },
    errorHandler(error, _request, reply) {
      if (error.code === "FST_ERR_CTP_INVALID_JSON_BODY" || error.code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
        return reply.code(400).send({ commandId: null, result: { kind: "error", text: "压缩请求无效" } });
      }
      if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") return reply.code(413).send({ commandId: null, result: { kind: "error", text: "压缩请求正文过大" } });
      if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") return reply.code(415).send({ commandId: null, result: { kind: "error", text: "不支持的媒体类型" } });
      return reply.code(500).send({ code: "compaction_internal_error" });
    },
  }, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = compactRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ commandId: null, result: { kind: "error", text: "压缩请求无效" } });
    if (!commands.compact) return reply.code(503).send({ code: "compaction_unavailable" });
    try {
      const result = await commands.compact({ ...params.data, ...body.data });
      const rejection = compactErrorSchema.safeParse(result);
      if (rejection.success && rejection.data.code === "compaction_id_conflict") return reply.code(409).send(rejection.data);
      const busy = compactRejectionSchema.safeParse(result);
      if (busy.success && busy.data.commandId !== null) return reply.code(409).send(busy.data);
      const parsed = compactResponseSchema.parse(result);
      if (parsed.compactionId !== body.data.compactionId) throw new Error("压缩标识不匹配");
      return reply.code(200).send(parsed);
    } catch (error: unknown) {
      if (!(error instanceof AgentError)) return reply.code(500).send({ code: "compaction_internal_error" });
      if (error.code === "session/not-found") return reply.code(404).send({ code: error.code });
      if (error.code === "storage_blocked" || error.code === "agent_closed") return reply.code(503).send({ code: error.code });
      return reply.code(500).send({ code: "compaction_internal_error" });
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
