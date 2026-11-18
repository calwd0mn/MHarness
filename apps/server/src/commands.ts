import { randomUUID } from "node:crypto";
import { selectForkCut } from "@mharness/session/server";
import { sessionParamsSchema, type PromptRequest, type PromptResponse } from "@mharness/session/contracts";
import { AgentManager } from "./agent/manager.ts";
import { AgentError } from "./agent/react-agent.ts";

/** 按命令选择激活策略；prompt 按需加载，取消只查询已加载实例。 */
export class SessionCommandController {
  constructor(private readonly agents: AgentManager) {}
  /**
   * 从同一次父会话观察快照派生子会话，并以持久化的初始前缀发布子 Agent。
   * @param request - 父会话标识须符合会话标识契约；事件位置缺省时选择最近已结束的 Turn。
   * @returns 子会话初始批次得到确认并完成发布后的会话标识。
   * @throws 父会话标识无效或不存在、找不到闭合 Turn、锚点无效、关闭或初始化失败时拒绝。
   */
  async fork({ sessionId: parentSession, atSeq }: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }> {
    sessionParamsSchema.parse({ sessionId: parentSession });
    if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq < 0)) {
      throw new RangeError("分支锚点必须是非负安全整数");
    }
    const sessionId = randomUUID();
    await this.agents.initializeFork({ sessionId, createdAt: Date.now(), parentSession, isSeeded: true }, async () => {
      const events = await this.agents.readForkSource(parentSession);
      const cut = selectForkCut(events, atSeq);
      if (cut === undefined) throw new AgentError("session/fork-unavailable");
      return events.slice(0, cut);
    });
    return { sessionId };
  }
  /** 首次提交按需加载 Agent；重发和首次受理均返回确认，不等待执行结束。 */
  async prompt(request: PromptRequest & { sessionId: string }): Promise<PromptResponse> {
    const agent = await this.agents.load(request.sessionId);
    return agent.prompt(request);
  }
  /** 请求取消当前活动；未加载会话返回 session/not-found，不触发加载。 */
  async cancel(sessionId: string): Promise<{ accept: true }> {
    const agent = this.agents.get(sessionId);
    if (!agent) throw new AgentError("session/not-found");
    agent.cancel(); return { accept: true };
  }
}
