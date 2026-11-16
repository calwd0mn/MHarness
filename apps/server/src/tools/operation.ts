import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Session } from "@mharness/session/server";
import { ToolRegistry, type PreparedToolCall } from "./registry.ts";
import { appendToolResult } from "./result-event.ts";

type SessionEvent = ReturnType<Session["snapshot"]>["events"][number];
/** 在会话内唯一定位一次模型工具调用。 */
export interface ToolOperationIdentity { readonly turn: number; readonly step: number; readonly callId: string }
/** 操作已接受或调用已有结果；ready 不表示审批、持久化检查点或派发已完成。 */
export type OperationPreparation =
  | { readonly kind: "ready"; readonly operation: Extract<SessionEvent, { type: "tool/operation" }>; readonly call: PreparedToolCall; readonly decision: "allow" | "ask" }
  | { readonly kind: "settled"; readonly result: Extract<SessionEvent, { type: "tool/result" }> };
/** 由可信服务根据绑定工具决定执行前策略，不从模型参数获取策略。 */
export type PreExecutePolicy = (call: PreparedToolCall) => "allow" | "deny" | "ask";

/**
 * 校验已调度调用并接受操作，再根据可信策略决定后续处理；拒绝或参数错误直接追加配对结果。
 * 重传已有结果时返回原结果；已有操作时校验工具版本和参数并复用标识。
 * 此方法不执行工具、不请求审批，也不等待持久化；调用方须完成后续检查点和取消检查。
 * @param session - 持有调用声明、调度及操作事件的会话。
 * @param registry - 提供可信工具定义和参数校验的注册表。
 * @param identity - 已调度调用的会话内范围。
 * @param policy - 可信策略服务；缺省使用注册工具的审批策略。
 * @returns 待检查点或审批的操作，或已接受的配对结果。
 * @throws 调用未调度，或已有操作与当前工具定义或参数不一致时抛出。
 */
export function prepareToolOperation(session: Session, registry: ToolRegistry, identity: ToolOperationIdentity, policy: PreExecutePolicy = (call) => call.governance.approvalPolicy): OperationPreparation {
  const { turn, step, callId } = identity;
  const events = session.snapshot().events;
  const callEvent = events.find((event) => event.type === "tool/call" && event.data.turn === turn && event.data.step === step && event.data.callId === callId);
  if (!callEvent || callEvent.type !== "tool/call") throw new Error("工具调用尚未调度");
  const result = events.findLast((event) => event.type === "tool/result" && event.data.turn === turn && event.data.step === step && event.data.message.source.callId === callId);
  if (result?.type === "tool/result") return { kind: "settled", result };
  const existing = events.find((event) => event.type === "tool/operation" && event.data.turn === turn && event.data.step === step && event.data.callId === callId);
  const prepared = registry.prepare(callEvent.data.name, callEvent.data.arguments);
  if (!prepared.ok) {
    if (existing) throw new Error("已有操作与当前工具定义不一致");
    const message = prepared.code === "INVALID_JSON" ? "工具参数不是有效的 JSON。" : prepared.code === "INVALID_INPUT" ? "工具参数校验失败。" : "工具未注册。";
    return { kind: "settled", result: appendToolResult(session, { ...identity, messageId: randomUUID() }, {
      isError: true, error: { message, info: { name: "ToolPreparationError", code: prepared.code } }, content: [{ type: "text", text: message }],
    }) };
  }
  const call = prepared.call;
  if (existing?.type === "tool/operation" && (existing.data.toolName !== call.name || existing.data.toolVersion !== call.version || !isDeepStrictEqual(existing.data.validatedArgs, call.args))) {
    throw new Error("已有操作与当前工具定义或参数不一致");
  }
  // 保留原始 JSON 键；Session 追加时会独立校验并制作不可变快照。
  const operation = existing?.type === "tool/operation" ? existing : session.append({ type: "tool/operation", data: {
    ...identity, operationId: randomUUID(), toolName: call.name, toolVersion: call.version, validatedArgs: call.args as Extract<SessionEvent, { type: "tool/operation" }>["data"]["validatedArgs"],
  } });
  const decision = policy(call);
  if (decision === "deny") {
    const message = "工具调用被策略拒绝。";
    return { kind: "settled", result: appendToolResult(session, { ...identity, messageId: randomUUID() }, {
      isError: true, error: { message }, content: [{ type: "text", text: message }],
    }) };
  }
  return { kind: "ready", operation, call, decision };
}
