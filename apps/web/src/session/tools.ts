import type { RawSessionEventFrame } from "@mharness/session/contracts";

type Event = RawSessionEventFrame["event"];
type Operation = Extract<Event, { type: "tool/operation" }>;
type Result = Extract<Event, { type: "tool/result" }>;
type Asked = Extract<Event, { type: "approval/asked" }>;
type Decided = Extract<Event, { type: "approval/decided" }>;

/** 工具卡片聚合的已记录事实；标识在同一会话内由轮次、步骤和调用编号组成。 */
export interface ToolView {
  key: string; order: number; turn: number; step: number; callId: string; name: string; rawArguments: string;
  status: string; operationId?: string; version?: string; validatedArgs?: Operation["data"]["validatedArgs"];
  result?: Result["data"]; approval?: Asked["data"]; decision?: Decided["data"]["outcome"];
}

/** 从完整原始事件窗口派生工具事实，重复调用不跨步骤配对。
 * @param records - 当前会话按序接收的原始事件窗口。
 * @returns 按首次调用顺序排列的独立卡片；替换结果不改变历史展示，未开始恢复结果可依据声明建卡。
 */
export function projectTools(records: readonly RawSessionEventFrame[]): ToolView[] {
  const tools = new Map<string, ToolView>();
  const declarations = new Map<string, ToolView>();
  const key = (turn: number, step: number, callId: string) => JSON.stringify([turn, step, callId]);
  for (const { event } of records) {
    if (event.type === "assistant/message") {
      for (const block of event.data.message.content) if (block.type === "tool-call") {
        const id = key(event.data.turn, event.data.step, block.id);
        declarations.set(id, { key: id, order: event.seq, turn: event.data.turn, step: event.data.step, callId: block.id, name: block.name, rawArguments: block.arguments, status: "准备调用" });
      }
    } else if (event.type === "tool/call") {
      const id = key(event.data.turn, event.data.step, event.data.callId);
      const previous = tools.get(id);
      tools.set(id, { ...previous, key: id, order: event.seq, turn: event.data.turn, step: event.data.step, callId: event.data.callId, name: event.data.name, rawArguments: event.data.arguments, status: "准备调用" });
    } else if (event.type === "tool/operation") {
      const tool = tools.get(key(event.data.turn, event.data.step, event.data.callId));
      if (tool) Object.assign(tool, { operationId: event.data.operationId, version: event.data.toolVersion, validatedArgs: event.data.validatedArgs, status: "已校验" });
    } else if (event.type === "approval/asked") {
      const tool = [...tools.values()].find((item) => item.operationId === event.data.operationId);
      if (tool) Object.assign(tool, { approval: event.data, status: "等待审批" });
    } else if (event.type === "approval/decided") {
      const tool = [...tools.values()].find((item) => item.approval?.id === event.data.id);
      if (tool) Object.assign(tool, { decision: event.data.outcome, status: event.data.outcome === "allowed-once" ? "等待结果" : "审批已结束" });
    } else if (event.type === "tool/result") {
      if (event.surfaceOp !== "append") continue;
      const id = key(event.data.turn, event.data.step, event.data.message.source.callId);
      let tool = tools.get(id);
      if (!tool && event.data.error?.code === "TOOL_NOT_STARTED") {
        tool = declarations.get(id);
        if (tool) tools.set(id, tool);
      }
      if (tool) {
        const code = event.data.error?.code;
        const status = code === "TOOL_NOT_STARTED" ? "未开始" : code === "TOOL_OUTCOME_UNKNOWN" ? "结果未确认" : code?.includes("TIMEOUT") ? "超时" : code?.includes("CANCEL") || code?.includes("ABORT") ? "已取消" : event.data.message.content[0].isError ? "失败" : "成功";
        Object.assign(tool, { result: event.data, status });
      }
    } else if (event.type === "turn/end") {
      for (const tool of tools.values()) if (tool.turn === event.data.turn && tool.approval && !tool.decision && !tool.result) tool.status = "审批已失效";
    }
  }
  return [...tools.values()];
}
