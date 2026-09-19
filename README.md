<a id="chinese"></a>

# DBX Kubernetes 插件

[中文](./README.md) | [English](./README.en.md)

<div align="center">

**在 DBX 中连接、查看和管理 Kubernetes 集群**

[![DBX](https://img.shields.io/badge/DBX-%3E%3D0.6.16-4c8bf5)](https://github.com/t8y2/dbx)
[![License](https://img.shields.io/github/license/eryajf/dbx-plugin-k8s)](./LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-eryajf%2Fdbx--plugin--k8s-181717?logo=github)](https://github.com/eryajf/dbx-plugin-k8s)

</div>

## 插件简介

DBX Kubernetes 插件为 DBX 提供一个面向日常运维的 Kubernetes 工作台。连接集群后，可以从概览开始查看集群状态，再按资源类型浏览、搜索、检查和操作对象；常用操作集中在资源详情页和行操作菜单中，无需频繁切换到命令行。

插件支持 Kubernetes 原生资源，也会根据集群 API Discovery 自动发现可用资源和自定义资源。界面默认使用中文，并可在工作台内切换为英文。

## 主要功能

### 集群连接

支持三种认证方式：

- **Kubeconfig**：选择本地文件或直接粘贴 YAML，可指定 Context。
- **API Server + Token**：填写 API Server、Bearer Token 和可选的 CA 证书。
- **API Server + 客户端证书**：填写 API Server、客户端证书、客户端私钥和可选的 CA 证书。

连接表单还支持请求超时、默认命名空间、TLS 校验和 kubeconfig exec 凭据开关。敏感字段通过 DBX 的 secret 绑定保存；只有在确认 kubeconfig 来源可信时才建议启用 exec 凭据。

### 集群概览与监控

- 查看节点数量、就绪状态、命名空间、Pod 数量和容器重启次数。
- 汇总 CPU、内存等集群容量信息。
- 查看 Pod 和 Node 的资源指标（需要集群提供 Metrics API，通常由 Metrics Server 提供）。
- 查看最近的 Kubernetes Events，快速定位 Warning 和异常对象。
- 支持手动刷新，也可为资源列表设置自动刷新间隔。

### 资源浏览与检索

资源按以下类别组织：

- **集群**：节点、命名空间、事件
- **工作负载**：Pod、Deployment、ReplicaSet、StatefulSet、DaemonSet、Job、CronJob、HPA
- **网络**：Service、Ingress、NetworkPolicy、Endpoint、Gateway、HTTPRoute 等
- **配置**：ConfigMap、Secret、ResourceQuota、LimitRange
- **存储**：PersistentVolume、PersistentVolumeClaim、StorageClass
- **安全**：Role、RoleBinding、ClusterRole、ClusterRoleBinding、ServiceAccount
- **扩展**：集群 Discovery 返回的其他资源和 CRD

资源列表提供命名空间选择、名称或标签筛选、排序、分页、列显示设置和 CSV 导出。全局搜索可跨资源类型查找名称、命名空间和标签；常用对象可以收藏，也可以从“最近访问”快速返回。

### 资源详情与变更

- 查看对象详情、状态、标签、注解、关联资源和事件。
- 查看或编辑资源 YAML，创建、更新、Patch、删除资源。
- 支持批量删除，并在执行前显示确认信息。
- 对具备相应 RBAC 权限的资源，操作菜单会根据 API 返回的 verbs 自动启用或禁用。

### 工作负载与节点操作

- Deployment、StatefulSet、DaemonSet 等工作负载：重启、扩缩容、查看历史版本和回滚。
- CronJob：立即触发任务或暂停/恢复调度。
- Node：Cordon、Uncordon 和 Drain。
- 容器镜像、探针、环境变量和挂载等常见配置可在编辑界面中调整。

### Pod 会话与网络

- 查看 Pod 日志。
- 打开 Pod 容器终端；在具备权限时也可打开 Node 终端或 Kubernetes 命令终端。
- 浏览、读取、上传和删除 Pod 文件。
- 为 Pod、Service 或 Deployment 建立端口转发。
- 在会话面板中管理正在运行的日志、终端和转发会话。

## 安装与使用

1. 在 DBX 中安装 **Kubernetes Manager** 插件。
2. 在 DBX 左侧创建一个 Kubernetes 连接，选择认证方式并填写对应信息。
3. 点击 **测试连接**，确认 API Server 可访问且凭据有效。
4. 点击 **连接**，进入 Kubernetes 工作台。

插件要求 DBX <code>>=0.6.16</code>。集群账号需要拥有对应资源的 Kubernetes RBAC 权限；如果只需要查看，可以使用只读权限。日志、终端、文件操作、端口转发、节点维护和资源变更分别需要额外的 Kubernetes 权限。

## 安全与数据

- Kubeconfig、Token、客户端证书和私钥等敏感字段按 DBX secret 字段处理。
- 插件只对收藏和最近访问保存资源的引用信息（资源类型、名称、命名空间等），不会把完整 Secret 内容写入收藏数据。
- <code>Skip TLS verification</code> 和 kubeconfig exec 凭据会降低连接校验强度，请仅在明确了解风险时启用。
- 资源操作最终由 Kubernetes API Server 的 RBAC 策略决定，插件不会绕过集群权限。

## 致谢

感谢以下开源项目为本插件提供的基础能力、产品思路和实现参考：

- [Kite](https://github.com/kite-org/kite)：提供 Kubernetes 管理能力和资源操作的基础。
- [Kite Desktop](https://github.com/eryajf/kite-desktop)：提供桌面化运行、交互设计和本地能力集成方面的参考。

## 项目状态

插件目前围绕 Kubernetes 日常管理持续完善，重点是让连接、观察、定位和处理资源的流程集中在 DBX 内。界面和连接表单已支持中文/英文切换；部分高级能力会受到 DBX 宿主版本、集群 API 版本、Metrics API 和 RBAC 配置影响。

## 开发与构建

如果你要从源码运行插件：

~~~
# 检查 Kubernetes 连接
kubectl cluster-info

# 启动 DBX 插件开发主机
dbx-plugin dev --path . --port 5190

# 测试后端并构建前端
cd backend && go test ./...
cd ../ui && pnpm install --frozen-lockfile && pnpm run build

# 构建可安装候选包
cd .. && dbx-plugin package .
~~~

发布流程会生成适配不同目标平台的未签名候选包，最终由 DBX Store 完成审核、签名和发布。完整的工程约定和脚本说明见仓库中的 <code>scripts/</code>、<code>dbx-plugin.toml</code> 与 CI 配置。

## 相关链接

- [DBX 项目](https://github.com/t8y2/dbx)
- [DBX Plugin Store](https://github.com/t8y2/dbx-store)
- [问题反馈与功能建议](https://github.com/eryajf/dbx-plugin-k8s/issues)
- [DBX 插件精选列表](https://github.com/eryajf/awesome-dbx-plugins)
- [许可证](./LICENSE)
