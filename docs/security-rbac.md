# Kubernetes 插件权限矩阵

插件不绕过 Kubernetes RBAC；每个操作都使用当前连接的凭据执行。UI 遇到 `403 Forbidden` 时应直接展示资源和所需动作。

| 功能 | Kubernetes API 动作 | 典型资源 |
|---|---|---|
| 浏览资源 | `get`, `list`, `watch` | 目标资源及 `events` |
| 创建/编辑/删除 | `create`, `update`, `patch`, `delete` | 目标资源 |
| 事件与关联关系 | `list`, `get` | `events`, 关联资源 |
| Pod 日志 | `get` | `pods/log` |
| Pod Exec | `create` | `pods/exec` |
| 端口转发 | `create` | `pods/portforward` |
| Deployment 重启/扩缩容 | `patch` | `deployments/scale`、`deployments` |
| Node Cordon/Uncordon | `patch` | `nodes` |
| Node Drain | `get`, `list`, `patch`, `delete`, `create` | `nodes`、`pods`、`pods/eviction` |

## 安全约束

- kubeconfig、Token、客户端证书和私钥只进入 DBX secret store，不写入普通配置或日志。
- kubeconfig 的 exec credential 默认关闭，只有连接配置显式设置 `allow_exec` 才允许执行外部凭据插件。
- Secret 详情默认脱敏；用户显式选择显示时才返回明文。
- 删除、Drain、Exec 和端口转发必须由界面显示资源名称、命名空间和目标后确认。
- Drain 的强制模式和忽略裸 Pod 选项不会默认开启，并受请求参数控制。
- 临时调试资源必须带 `dbx.kubernetes/plugin=true` 标签，并在会话结束时清理。
- 所有长连接都有会话超时、取消和关闭路径，断开连接时统一回收。

