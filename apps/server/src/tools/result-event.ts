import { Session } from "@mharness/session/server";
import type { ToolResult } from "./result.ts";

/** 工具结算在会话内的调用范围与消息身份。 */
export interface ToolResultIdentity {
  /** 声明所属的 Turn。 */
  turn: number;
  /** 声明所属的 Step。 */
  step: number;
  /** Assistant 声明的调用标识。 */
  callId: string;
  /** 本次结果的稳定消息标识。 */
  messageId: string;
}

/**
 * 将规范化工具结果追加到会话；仅保存模型内容、展示元数据和可公开错误标识。
 * 来源和操作标识从当前日志中按调用范围取得；结果追加本身不等待持久化提交。
 * @param session - 接收结果的会话，调用方负责持久化检查点。
 * @param identity - 已声明调用的范围和新结果消息身份。
 * @param result - 已规范化的结果；原始值和结束意向不会写入日志。
 * @returns 已由会话接受的不可变结果事件。
 * @throws 找不到调用声明，或会话拒绝无效关联、重复结算或载荷时抛出。
 */
export function appendToolResult<Value>(session: Session, identity: ToolResultIdentity, result: ToolResult<Value>) {
  const { turn, step, callId, messageId } = identity;
  const events = session.snapshot().events;
  const declaration = events.find((event) => event.type === "assistant/message" && event.data.turn === turn
    && event.data.step === step && event.data.message.content.some((part) => part.type === "tool-call" && part.id === callId));
  if (!declaration) throw new Error("工具结果缺少有效声明");
  const call = events.find((event) => event.type === "tool/call" && event.data.turn === turn
    && event.data.step === step && event.data.callId === callId);
  const operation = events.find((event) => event.type === "tool/operation" && event.data.turn === turn
    && event.data.step === step && event.data.callId === callId);
  return session.append({
    type: "tool/result", surfaceOp: "append", sourceEventSeqs: [call?.seq ?? declaration.seq], data: {
      turn, step,
      ...(operation?.type === "tool/operation" ? { operationId: operation.data.operationId } : {}),
      ...(result.meta !== undefined ? { meta: result.meta } : {}),
      ...(result.isError && result.error.info !== undefined ? { error: { name: result.error.info.name, code: result.error.info.code } } : {}),
      message: { id: messageId, role: "user", source: { kind: "tool", callId }, content: [{
        type: "tool-result", toolCallId: callId, isError: result.isError, content: result.content,
      }] },
    },
  });
}
