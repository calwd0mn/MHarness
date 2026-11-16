import { sessionParamsSchema } from "@mharness/session/contracts";
import type { SessionPersistence } from "@mharness/session/server";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentManager } from "../agent/manager.ts";
import { approvalDecisionRequestSchema } from "./contracts.ts";
import type { ApprovalService } from "./service.ts";

/**
 * 注册审批决定入口；历史查询不加载 Agent，已提交决定直接复用，不排空在线尾部。
 * @param app - HTTP 应用。
 * @param path - 会话集合路径。
 * @param persistence - 提供未加载会话的已提交历史。
 * @param agents - 提供在线会话快照。
 * @param approvals - 在线审批结算服务。
 */
export function registerApprovalRoutes(app: FastifyInstance, path: string, persistence: Pick<SessionPersistence, "open">, agents: Pick<AgentManager, "get">, approvals: ApprovalService): void {
  app.post(`${path}/:sessionId/approvals/:approvalId/decision`, async (request, reply) => {
    const params = z.object({ sessionId: sessionParamsSchema.shape.sessionId, approvalId: z.string().min(1) }).safeParse(request.params);
    const body = approvalDecisionRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ code: "invalid_request" });
    const { sessionId, approvalId } = params.data;
    const session = agents.get(sessionId)?.session;
    const handle = await persistence.open(sessionId, "read");
    if (!handle) return reply.code(404).send({ code: "approval_not_found" });
    try {
      const events = await handle.read();
      const committed = events.some((event) => event.type === "approval/decided" && event.data.id === approvalId);
      const result = session && !committed
        ? await approvals.respond(sessionId, approvalId, body.data.outcome, session.snapshot().events, session)
        : await approvals.respond(sessionId, approvalId, body.data.outcome, events);
      return reply.code(result.status).send(result.body);
    } finally { await handle.close(); }
  });
}
