# 前端会话体验实施计划

范围：已确认的 OpenSpec 6.10–6.16；6.3/6.4 继续等待正式后端联调。工作树基线 4856b44。每项通过公开界面先写失败测试、实现、复测并独立提交；任务间共享文件以提交边界划分审查。不得访问真实数据库或执行工具。

## 依赖与测试边界

Markdown 固定采用 react-markdown 10.1.0，官方发布页 https://github.com/remarkjs/react-markdown/releases 与 README https://github.com/remarkjs/react-markdown 确认版本、React 兼容和默认安全行为；不引入 raw HTML 插件，明确限制链接协议。测试以真实 App DOM、公开事件投影、HTTP 替身和既有 Session 控制器为边界，不测试私有实现。

## 顺序和验证

1. 6.10：主题与复用控件；先测禁用、进行中和可访问名称；Web test/typecheck/build。
2. 6.11：控制层、导航/顶栏/消息/输入拆分和每会话草稿；先测切换、焦点、待受理隔离；Web test/typecheck。
3. 6.12：安全 Markdown 和复制；先测 HTML/链接、未闭合结构、复制、节点稳定；Web test/typecheck/build。
4. 6.13：按会话阅读位置及返回最新；先测跟随、上滚、切换、展开；Web test/typecheck。
5. 6.14：原始事件纯投影与工具卡片；先测跨 Step 配对、状态和未知内容；Web test/typecheck/build。
6. 6.15：审批适配及交互；先测请求锁、HTTP 各结果、事件收敛、迟到回调和键盘边界；Web test/typecheck。
7. 6.16：完整事件窗口与受控 HTTP 组装测试；全仓 typecheck、Web test/build、浏览器依赖链和 JSDoc 人工核验。

浏览器验收通过隔离事件与 HTTP 夹具启动真实 App，不接用户数据库；逐项记录桌面/窄屏、明暗、长内容、低高度/缩放、触屏 hover、焦点、reduced motion 及截图。真实布局若受环境阻碍，列为未验收，DOM 测试不能替代。测试入口必须纳入 `pnpm --filter @mharness/web test`。每项记录 red/green、提交 SHA 与父 SHA、文件及共享文件后续触及情况，供独立 review。

## 执行证据（2026-11-16）

- 规划：`bf05210`，父 `4856b44`。
- 6.10 初始控件：`f4675a6`，父 `bf05210`；补充导航、主题、CSS Modules 和按钮状态在 `e6e65ba`。
- 6.11：`ab906c9`，父 `f4675a6`；后续组装与控制层审批入口在 `e6e65ba`。
- 6.12：`e189793`，父 `ab906c9`；代码节点稳定、取消和截断说明在 `e6e65ba`。
- 6.13：`2202a36`，父 `e189793`；延迟快照恢复在 `cb96bb1`，ResizeObserver 在 `e6e65ba`。
- 6.14：`cb96bb1`，父 `2202a36`；声明与结果替换语义、事件顺序在 `e6e65ba`。
- 6.15/6.16：`e6e65ba`，父 `cb96bb1`；审批适配、受控组装和隔离夹具。共享文件 `ConversationView.tsx`、`app.test.jsx` 和 `view.ts` 跨任务修改，审查按对应函数和测试划分。

测试先行记录：按钮模块缺失、会话草稿泄露、原文空白丢失、Markdown 模块缺失、流式推理缺失、阅读位置缺失、空快面恢复夹取、尺寸变化跟随、工具投影缺失、声明提前建卡、工具顺序、审批模块缺失、409 cancelled/unavailable、代码节点重挂载、导航折叠、取消/截断及 HTTP 先确认摘要均先观察失败，再实现并通过对应回归。其余参数化用例为补充覆盖，不声称均单独经历 red。

新鲜验证：`pnpm typecheck` 全仓通过；`pnpm --filter @mharness/web test` 通过 Session 40 项、App 35 项；`pnpm --filter @mharness/web build` 通过，Zod 的 Rollup 注释警告沿用基线。使用 Vite 自带 esbuild 对 `src/main.tsx` 以 browser 平台建立完整 metafile，291 个输入中未发现 Fastify、SQLite、Node 内置资源或 Session 服务端实现路径；公开契约入口及其本地传递导入仅到 Zod、事件和会话标识。变更声明已人工对照实现核对中文 JSDoc；未发现专用 JSDoc 静态检查，未声称自动覆盖。

隔离夹具：`apps/web/fixture.html`，本地模拟 follow、HTTP；`?theme=light`/`?theme=dark` 可切换夹具主题，不接数据库或真实工具。开发中 IAB 实验：深色 1280×720 与 390×844 无横向溢出且输入可见；展开工具后 resize 到窄屏底部差约 0.14px；640×320 文档可滚动，输入聚焦后可见；浅色窄屏导航折叠、新建及切换草稿和审批答复可操作。以上是开发中初验，最终提交重载、截图及触屏 hover、真实媒体偏好、缩放等尚由独立浏览器验收确认，不以 DOM 测试替代。6.3/6.4 正式后端联调未完成，不予勾选。

最终浏览器复验（IAB Chromium，代码提交 `e6e65ba`）：light 1280×720 的新建、取消、允许、拒绝均实测 H36/R12；审批详情 Enter 确认后摘要为等待结果、详情为已允许且按钮移除。dark 390×844 导航折叠及审批可操作、无横向溢出，Tab 聚焦允许按钮具有实线焦点轮廓。截图：`C:/Users/Risc4/.codex/visualizations/2026/11/16/01a1e461-3f4e-7bf1-9044-a968c96bc170/frontend-session-desktop-light.jpg`、`C:/Users/Risc4/.codex/visualizations/2026/11/16/01a1e461-3f4e-7bf1-9044-a968c96bc170/frontend-session-mobile-dark.jpg`。真实系统主题切换、触屏 hover 媒体仿真、reduced-motion 媒体仿真、实际浏览器缩放未验收；夹具强制主题和 viewport 不等同这些检查。
