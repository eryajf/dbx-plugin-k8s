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
| Node Terminal | `get` nodes；`create`, `get`, `delete` pods；POST attach 需要 `create`，GET attach 需要 `get` | `nodes`、临时 Pod 所在命名空间的 `pods`、`pods/attach` |
| Node Terminal 启动诊断（可选） | `get` | `pods/log`；无此权限仍保留原始启动失败原因 |
| Kubectl Terminal 临时身份和清理 | `create`, `get`, `delete` | 临时命名空间的 `serviceaccounts`、`pods`，以及集群级 `clusterrolebindings`；交互执行还需 `pods/exec` 的 `create`/`get`（取决于传输方式） |

## 终端身份与清理

Node Terminal 使用当前连接身份读取目标 Node、创建临时特权 Pod，并 attach 到已启动的宿主 shell；不需要为此创建 ServiceAccount 或 ClusterRoleBinding，也不会自动扩充当前身份的权限。应只向确有节点管理需要的身份授予上述最小权限，并同时遵守集群准入策略。`pods/attach` 的 POST/SPDY 与 GET/WebSocket 路径分别对应 RBAC `create` 与 `get`；可选的 `pods/log` 只用于启动失败诊断，不是终端必需权限。

Kubectl Terminal 保持既有行为：创建临时 ServiceAccount 和指向 `cluster-admin` 的 ClusterRoleBinding，再用该身份运行 kubectl。这是既有高权限功能，不代表 Node Terminal 也需要该授权。本次资源清理修复不增加 kubectl 的业务授权；当前连接仍须已具备创建该绑定所需的权限并通过 Kubernetes 的 bind / 防权限提升检查，插件不自动授予或申请额外权限。临时资源的 `get` 用于在删除前核验身份及对模糊创建结果进行补偿。

每次终端初始化生成不可猜测的随机 `dbx.kubernetes/owner-token` 标签。`dbx.kubernetes/plugin=true` 等通用标签只用于识别，不作为删除授权。清理核验本次 owner token 和资源 UID，所有 DELETE 都携带 UID precondition；创建请求发生超时、网络断开、服务端错误或 HTTP 201 空/损坏响应时，只在按生成的名称 GET 后 token 匹配才补偿。client-go 可能内部重试 POST，因此最终的 AlreadyExists（409）也须只读核验：若资源带本次 token，则可以补偿本次已提交的资源；外来 token 的同名资源一律拒绝删除并报告错误。明确的 Forbidden、Unauthorized、Invalid、BadRequest 等拒绝，以及发送前发现的非法名称/命名空间、已取消上下文，不纳入补偿；其他无法确认是否提交的错误保守纳入核验，不凭错误文本认定是本地失败。

初始化失败、会话退出或关闭时，在独立于会话取消的总计最多 8 秒预算内尝试清理 Pod、ClusterRoleBinding 和 ServiceAccount，并为其余资源预留公平份额。每个资源的瞬态失败操作最多尝试 3 次；观察性 GET 轮询可以超过 3 次，Forbidden 等永久错误不重试。已知 UID 的 NotFound 表示该资源已消失；模糊 Create 且尚未取得 UID 时，首次乃至多次 NotFound 都不能证明创建失败，需继续观察至该资源预算耗尽，仍未知则明确报告 `uncertain create outcome`，不能报告清理成功。延迟提交超过观察预算仍可能遗留资源。

DELETE 成功（包括 HTTP 202）仅表示已受理，随后继续有界 GET 确认原 UID 消失；NotFound 或不同 UID 表示原资源已消失，不删除、不等待替换者。原 UID 持续存在（例如 Terminating 或 finalizer 阻塞）时，超时明确报告 UID、deletionTimestamp 和 finalizers。Node 与 Kubectl 临时交互 Pod 都设置 `terminationGracePeriodSeconds: 0`：它们不需要业务优雅停机工作，默认 30 秒会超过总计 8 秒的清理预算。这不是强制删除：插件不额外覆盖 DELETE grace、不跳过 API 的 UID 前置条件、不移除 finalizer；也不能保证节点失联时容器进程已停止。

启动等待逐次核验创建返回的 UID 和本次 token，并拒绝带 deletionTimestamp 的 Pod；在调用 attach/exec 前再 GET 核验一次，以缩小替换窗口。Node 仍 attach 到原有 chroot shell，Kubectl 仍使用原有 exec 流程。但 Kubernetes attach/exec API 按名称寻址，没有原子 UID precondition；最后一次核验和实际建立流之间仍存在 TOCTOU 窗口（包括传输回退/重连），不能宣称完全防止连接到同名替换 Pod。owner token 也不是针对具有读取并修改 Pod 标签权限的恶意管理员的安全隔离。

某个资源失败不阻止其他资源的清理，最终失败会向界面或后端日志报告。但权限撤销、API 持续不可用、进程异常退出等仍可能遗留资源：插件没有持久化后台 GC，需要管理员依据错误中的资源名称、命名空间和已知 UID，并检查实际资源的本次 owner token 后人工处理，尤其应及时检查遗留的高权限绑定。不要仅凭通用 plugin 标签批量删除资源。

## 安全约束

- kubeconfig、Token、客户端证书和私钥只进入 DBX secret store，不写入普通配置或日志。
- kubeconfig 的 exec credential 默认关闭，只有连接配置显式设置 `allow_exec` 才允许执行外部凭据插件。
- Secret 详情默认脱敏；用户显式选择显示时才返回明文。
- 删除、Drain、Exec 和端口转发必须由界面显示资源名称、命名空间和目标后确认。
- Drain 的强制模式和忽略裸 Pod 选项不会默认开启，并受请求参数控制。
- 临时调试资源必须带 `dbx.kubernetes/plugin=true` 标签，并在会话结束时清理。
- 所有长连接都有会话超时、取消和关闭路径，断开连接时统一回收。

