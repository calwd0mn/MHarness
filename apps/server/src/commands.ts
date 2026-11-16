import type { PromptRequest, PromptResponse } from "@mharness/session/contracts";
import { AgentManager } from "./agent/manager.ts";
import { AgentError } from "./agent/react-agent.ts";

/** 按命令选择激活策略；prompt 按需加载，取消只查询已加载实例。 */
export class SessionCommandController {
  constructor(private readonly agents: AgentManager) {}
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
