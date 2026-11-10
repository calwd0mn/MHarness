# 问题跟踪：本地 Markdown

本项目使用 `.scratch/` 保存本地问题、探索记录和技能产出。

## 文件约定

- 每项工作使用 `.scratch/<feature-slug>/`。
- 每个 issue 独立保存为 `issues/<NN>-<slug>.md`，从 01 编号。
- issue 顶部使用 `Status:` 记录分类状态，取值见 triage-labels.md。
- 讨论追加到文件底部的 `## Comments`，不覆盖已有讨论。
- 发布 issue 表示创建本地文件，不创建 GitHub Issue。
- 读取 ticket 时，按用户提供的路径或所属工作目录与编号定位；
  编号在不同工作目录之间不保证唯一。

## 与 OpenSpec 的关系

- 正式变更的提案、规范、设计与实施任务以 `openspec/` 为准。
- 已关联 OpenSpec 的本地 issue 引用对应变更、需求或任务编号，
  不复制维护另一份正式规范或任务完成状态。
- 技能需要 `.scratch/<feature-slug>/spec.md` 时，
  对已有 OpenSpec 变更仅记录变更位置及必要摘要；
  尚未进入 OpenSpec 的工作可先保存探索草稿。
- 草稿转为正式变更后，标明对应 OpenSpec 位置。
- 本配置不改变代码修改授权或现有 OpenSpec 工作流要求。

## Wayfinder

- 工作地图保存为 `.scratch/<effort>/map.md`，
  记录 Notes、Decisions-so-far 与 Fog。
- 子票据使用 `issues/NN-<slug>.md`。
- `Type:` 使用 research、prototype、grilling 或 task。
- Wayfinder 子票据使用独立工作状态：
  `Status: open`、`Status: claimed`、`Status: resolved`；
  不与普通 issue 的分类状态混用。
- `Blocked by: NN, NN` 引用同一工作目录中的阻塞票据。
- 按编号选择未认领且所有阻塞票据均已 resolved 的开放票据。
- 开始工作前保存 claimed；完成后追加 `## Answer`，
  更新为 resolved，并向地图追加结论与来源路径。
