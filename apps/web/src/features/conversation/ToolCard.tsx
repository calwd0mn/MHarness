import type { ToolView } from "../../session/tools.ts";
import styles from "./ToolCard.module.css";

/** 展示工具调用的已记录参数、结果和可检查元数据。 */
export function ToolCard({ tool }: { tool: ToolView }) {
  return <details className={styles.card}><summary>{tool.name} · {tool.status}</summary>
    <dl><dt>原始参数</dt><dd><pre>{tool.rawArguments}</pre></dd>
    {tool.version && <><dt>工具版本</dt><dd>{tool.version}</dd></>}
    {tool.validatedArgs !== undefined && <><dt>已校验参数</dt><dd><pre>{JSON.stringify(tool.validatedArgs, null, 2)}</pre></dd></>}
    {tool.result && <><dt>结果</dt><dd><pre>{JSON.stringify(tool.result, null, 2)}</pre></dd></>}
    </dl></details>;
}
