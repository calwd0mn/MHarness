import {
  fitSurfaceToolPrefix, indexSurfaceToolGroups, isCompleteSurfaceToolRange, type Session, type SurfaceNode,
} from "@mharness/session/server";
import type { ModelTool } from "../model/adapter.ts";
import type { SurfaceMessage } from "../model/request-projection.ts";
import type { PreparedModel } from "../model/runtime.ts";
import { estimateSurfaceMessageTokens } from "../model/token-meter.ts";

/** 一次选区捕获的完整节点与当时的业务模型估算。 */
export type CompactionSelection = Readonly<{
  /** 按当前 surface 顺序排列的不可变日志节点，不包含保留尾部。 */
  nodes: readonly SurfaceNode[];
  /** 起止事件序号均包含在范围内，按 surface 位置解释。 */
  shadowedRange: Readonly<{ start: number; end: number }>;
  /** 所选完整节点序列的事件序号，未按数值排序。 */
  shadowedSeqs: readonly number[];
  /** 选中节点的输入 token 估算，不含 system、工具定义或输出预留。 */
  shadowedTokens: number;
}>;

/** 以固定业务投影估算单条当前消息，返回非负整数 token 数。 */
export type CompactionWeight = (message: SurfaceMessage) => number;

function weightOf(node: SurfaceNode, weight: CompactionWeight): number {
  return weight(node.type === "user/message" ? node.data : node.data.message);
}

type StepSettlement = { closed: boolean; hasAssistant: boolean; missingResult: boolean };
type TurnSettlement = { steps: Map<number, StepSettlement>; firstStep?: StepSettlement };

function limitToSettledPrefix(
  session: Session, nodes: readonly SurfaceNode[], groups: ReturnType<typeof indexSurfaceToolGroups>, end: number,
): number {
  const activeTurns = new Map<number, TurnSettlement>();
  for (const event of session.snapshot().events) {
    if (event.type === "turn/start") activeTurns.set(event.data.turn, { steps: new Map() });
    else if (event.type === "turn/end") activeTurns.delete(event.data.turn);
    else if (event.type === "step/start") {
      const turn = activeTurns.get(event.data.turn);
      if (!turn) continue;
      const step = { closed: false, hasAssistant: false, missingResult: false };
      turn.steps.set(event.data.step, step);
      turn.firstStep ??= step;
    } else if (event.type === "step/end" || event.type === "assistant/message") {
      const step = activeTurns.get(event.data.turn)?.steps.get(event.data.step);
      if (!step) continue;
      if (event.type === "step/end") step.closed = true;
      else step.hasAssistant = true;
    }
  }
  for (const group of groups) {
    if (group.complete) continue;
    const node = nodes[group.assistant];
    if (node?.type !== "assistant/message") continue;
    const step = activeTurns.get(node.data.turn)?.steps.get(node.data.step);
    if (step) step.missingResult = true;
  }
  for (let position = 0; position < end; position++) {
    const node = nodes[position]!;
    if (node.type === "user/message") {
      if (!("turn" in node.data)) continue;
      const turn = activeTurns.get(node.data.turn);
      if (!turn) continue;
      const first = turn.firstStep;
      // step/end 也可能来自失败收尾，缺少正式答复或工具结果时不能遮蔽用户输入。
      if (!first?.closed || !first.hasAssistant || first.missingResult) return position;
    } else {
      const step = activeTurns.get(node.data.turn)?.steps.get(node.data.step);
      if (step && !step.closed) return position;
    }
  }
  return end;
}

/**
 * 从当前 surface 同步选择连续旧前缀，保留至少一个完整尾部节点。
 * @param session - 读取当前节点的会话。
 * @param retainTokens - 尾部保留预算，单位为非负整数 token。
 * @param weight - 与接受摘要时一致的节点计量，不得修改会话。
 * @returns 完整候选，或无安全范围时返回 undefined；不调用模型，不写入会话。
 */
export function selectCompactionPrefix(
  session: Session, retainTokens: number, weight: CompactionWeight,
): CompactionSelection | undefined {
  const nodes = session.deriveSurfaceNodes();
  if (nodes.length < 2) return undefined;
  let end = nodes.length;
  let retained = 0;
  do {
    retained += weightOf(nodes[--end]!, weight);
  } while (end > 0 && retained < retainTokens);
  const groups = indexSurfaceToolGroups(nodes);
  end = fitSurfaceToolPrefix(groups, limitToSettledPrefix(session, nodes, groups, end));
  if (end === 0) return undefined;

  const selected = nodes.slice(0, end);
  return {
    nodes: selected,
    shadowedRange: { start: selected[0]!.seq, end: selected[end - 1]!.seq },
    shadowedSeqs: selected.map(({ seq }) => seq),
    shadowedTokens: selected.reduce((sum, node) => sum + weightOf(node, weight), 0),
  };
}

/**
 * 用已固定的业务 Adapter 投影选择旧前缀，不计系统提示、工具定义或输出预留。
 * @param session - 读取当前节点的会话。
 * @param retainTokens - 尾部保留预算，单位为非负整数 token。
 * @param prepared - 与业务请求一致的固定模型。
 * @param tools - 业务请求的工具定义；可能影响助手推理是否参与计量。
 * @returns 完整候选，或无安全范围时返回 undefined；不启动生成。
 */
export function selectModelCompactionPrefix(
  session: Session, retainTokens: number, prepared: PreparedModel, tools: readonly ModelTool[],
): CompactionSelection | undefined {
  return selectCompactionPrefix(session, retainTokens, (message) => estimateSurfaceMessageTokens(prepared, message, tools));
}

/**
 * 同步复验原 Session 的完整当前前缀、结算状态和配对关系；不重新选择预算。
 * @param session - 捕获选区时的 Session 实例。
 * @param selection - 生成前捕获的选区。
 * @returns 完整前缀仍可替换时为 true；此结果不是锁或持久化许可。
 */
export function revalidateCompactionSelection(session: Session, selection: CompactionSelection): boolean {
  const nodes = session.deriveSurfaceNodes();
  const { nodes: selected, shadowedRange, shadowedSeqs } = selection;
  const end = selected.length;
  if (end === 0 || end >= nodes.length || shadowedSeqs.length !== end ||
    nodes[0]?.seq !== shadowedRange.start || nodes[end - 1]?.seq !== shadowedRange.end) return false;
  for (let position = 0; position < end; position++) {
    const node = nodes[position]!;
    if (node !== selected[position] || node.seq !== shadowedSeqs[position]) return false;
  }
  const groups = indexSurfaceToolGroups(nodes);
  return limitToSettledPrefix(session, nodes, groups, end) === end && isCompleteSurfaceToolRange(groups, 0, end);
}
