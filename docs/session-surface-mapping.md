# Session surface 与 DSH 的概念对应

本项目借鉴 DSH 按日志重建模型输入的思路，但契约由本项目定义，不依赖 DSH 实现。

| 本项目 | DSH 对应概念 | 本项目约束 |
| --- | --- | --- |
| Session 只追加事件 | Session 事件历史 | 原始记录不可变；替换追加新事件而不删除历史。 |
| surface 事件序列 | 模型可见消息视图 | 仅用户、正式 Assistant 和工具结果参与；顺序由操作决定，不按 seq 重新排序。 |
| surfaceOp replace 与 sourceEventSeqs | 历史替换及来源 | 端点按当前 surface 定位，来源覆盖整段，工具声明与结果不可拆散。 |
| deriveMessages 与 replaceGeneration | 上下文派生及失效 | 追加增量更新缓存，替换递增代次并失效；数组独立、消息节点复用不可变快照。 |
| 原始事件传输 | 客户端 Session 历史 | HTTP 已提交前缀与 follow 已接受前缀复用同一事件封装；聊天显示原始交互。 |
