import type { SessionEvent } from "./events.ts";

type ToolCall = {
  readonly turn: number;
  readonly step: number;
  readonly callId: string;
  readonly assistantSeq: number;
  readonly name: string;
  readonly arguments: string;
  callSeq?: number;
  operationId?: string;
  resultSeq?: number;
};

function callKey(turn: number, step: number, callId: string): string {
  return JSON.stringify([turn, step, callId]);
}

/** 维护一个会话中 Assistant 声明、调度、操作和结果的关联，供实时追加和重放使用。 */
export class SessionToolCalls {
  readonly #calls = new Map<string, ToolCall>();

  /**
   * 复制当前关联状态，供独立草稿校验而不修改原索引。
   * @returns 拥有独立可变关联项的新索引。
   */
  clone(): SessionToolCalls {
    const copy = new SessionToolCalls();
    for (const [key, call] of this.#calls) copy.#calls.set(key, { ...call });
    return copy;
  }

  /**
   * 依据已接受前缀校验候选工具关联，暂不更新索引。
   * @param event - 已通过事件 Schema 校验的候选记录。
   * @returns 整条事件被接受后须立即调用的更新函数；与工具关联无关时为 undefined。
   * @throws 调用引用、调度身份、操作标识或结果来源不匹配时抛出。
   */
  prepare(event: SessionEvent): (() => void) | undefined {
    switch (event.type) {
      case "assistant/message": {
        const { turn, step, message } = event.data;
        const declarations = message.content.filter((part) => part.type === "tool-call").map((part) => ({
          turn, step, callId: part.id, assistantSeq: event.seq, name: part.name, arguments: part.arguments,
        }));
        for (const { callId } of declarations) {
          if (this.#calls.has(callKey(turn, step, callId))) throw new Error("工具声明重复");
        }
        return () => {
          for (const call of declarations) this.#calls.set(callKey(turn, step, call.callId), call);
        };
      }
      case "tool/call": {
        const { turn, step, callId, name, arguments: rawArguments } = event.data;
        const call = this.#calls.get(callKey(turn, step, callId));
        if (!call || call.callSeq !== undefined || call.resultSeq !== undefined ||
          call.name !== name || call.arguments !== rawArguments) {
          throw new Error("工具调用与 Assistant 声明不一致");
        }
        return () => { call.callSeq = event.seq; };
      }
      case "tool/operation": {
        const { turn, step, callId, toolName, operationId } = event.data;
        const call = this.#calls.get(callKey(turn, step, callId));
        if (call?.callSeq === undefined || call.operationId !== undefined ||
          call.resultSeq !== undefined || call.name !== toolName) {
          throw new Error("工具操作与调度不一致");
        }
        return () => { call.operationId = operationId; };
      }
      case "tool/result": {
        const { turn, step, message, operationId } = event.data;
        const call = this.#calls.get(callKey(turn, step, message.source.callId));
        if (!call || call.operationId !== operationId) {
          throw new Error("工具结果缺少有效声明或操作");
        }
        if (event.surfaceOp === "append") {
          if (call.resultSeq !== undefined || !event.sourceEventSeqs.includes(call.callSeq ?? call.assistantSeq)) {
            throw new Error("工具结果引用不匹配");
          }
        } else if (call.resultSeq === undefined || !event.sourceEventSeqs.includes(call.resultSeq)) {
          throw new Error("工具结果替换不匹配");
        }
        return () => { call.resultSeq = event.seq; };
      }
    }
  }

  /**
   * 按 Assistant 声明顺序读取指定 Turn 中尚无结果的调用。
   * @param turn - 要结算的活动 Turn。
   * @returns 未结算调用，包含恢复时需要引用的事件位置和已有操作标识。
   */
  unsettled(turn: number): readonly Readonly<ToolCall>[] {
    return [...this.#calls.values()].filter((call) => call.turn === turn && call.resultSeq === undefined);
  }
}
