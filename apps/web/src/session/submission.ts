import type { RawSessionEventFrame } from "@mharness/session/contracts";

/** 单次提交在受理确认前保留编号，以便网络结果不明时重发。 */
export interface Submission {
  requestId: string;
  text: string;
  status: "sending" | "uncertain" | "accepted" | "busy";
}
/** 同一未确认正文重发沿用编号，其他提交生成新编号。 */
export function makeSubmission(
  previous: Submission | undefined,
  text: string,
  createId: () => string,
): Submission {
  return {
    requestId:
      previous?.status === "uncertain" && previous.text === text
        ? previous.requestId
        : createId(),
    text,
    status: "sending",
  };
}
/** 仅本会话继承边界之后的真实用户追加可确认当前提交。 */
export function confirmFromRecords(
  submission: Submission,
  records: readonly RawSessionEventFrame[],
  inheritedEventCount: number,
): Submission {
  const found = records.some(
    ({ event }) =>
      event.seq >= inheritedEventCount &&
      event.type === "user/message" &&
      event.surfaceOp === "append" &&
      event.data.source.kind === "user" &&
      "requestId" in event.data &&
      event.data.requestId === submission.requestId,
  );
  return found ? { ...submission, status: "accepted" } : submission;
}
