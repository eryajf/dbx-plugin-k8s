# Kite UI 复刻进度

- 源码基准：`tmp/kite-desktop/ui`，提交 `f9497303712fcd7cad0bcca8781f3d4f04a6280d`。
- 视觉基准：[Kite 节点页截图](kite-ui-baseline/kite-nodes.png)。
- 当前预览已恢复原版布局、导航、顶栏、主题与内存路由，并通过 DBX RPC 接入真实集群数据。

## 已验证

- 隔离 `about:srcdoc` 预览可启动，无 CSP 白屏。
- 概览页：节点、Pod、命名空间、Service、CPU/内存卡片及事件均来自当前集群。
- 资源查询适配：发现、列表、详情、创建/编辑/删除、收藏及 Watch。
- Pod 日志/终端、文件操作、端口转发已接入 DBX 会话接口。

## 待继续验收

- 需要按清单逐页做 Kite/DBX 叠图：节点、Pod、Deployment、Service、ConfigMap、Secret、存储、CRD、详情和操作弹窗。
- 当前集群指标接口不可用时显示能力错误/降级状态；不会填充假指标。
- 端口转发是 DBX 会话适配组件，Kite 源码中没有完全对应的独立组件。
