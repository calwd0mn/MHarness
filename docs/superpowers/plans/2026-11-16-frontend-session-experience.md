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
