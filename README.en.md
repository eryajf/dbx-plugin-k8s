
# DBX Kubernetes Plugin

[中文](./README.md) | [English](./README.en.md)

<div align="center">

**Connect to, inspect, and manage Kubernetes clusters from DBX**

[![DBX](https://img.shields.io/badge/DBX-%3E%3D0.6.17-4c8bf5)](https://github.com/t8y2/dbx)
[![License](https://img.shields.io/github/license/eryajf/dbx-plugin-k8s)](./LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-eryajf%2Fdbx--plugin--k8s-181717?logo=github)](https://github.com/eryajf/dbx-plugin-k8s)

</div>

## Overview

The DBX Kubernetes plugin provides a Kubernetes workbench for everyday operations. After connecting a cluster, you can start with a health overview, browse resources by type, search and inspect objects, and perform common actions from resource details and row menus without constantly switching to a terminal.

The plugin supports built-in Kubernetes resources and discovers additional resources and custom resources through the cluster API Discovery endpoint. The workbench defaults to Chinese and can be switched to English from the workbench header.

## Features

### Cluster connections

Three authentication modes are available:

- **Kubeconfig**: choose a local file or paste YAML, with optional Context selection.
- **API Server + Token**: provide the API Server, Bearer Token, and an optional CA certificate.
- **API Server + Client Certificate**: provide the API Server, client certificate, client key, and an optional CA certificate.

The connection form also supports request timeouts, a default namespace, TLS verification settings, and kubeconfig exec credentials. Sensitive fields use DBX secret bindings. Enable exec credentials only for kubeconfig files you trust.

Kubeconfig connections can use DBX SSH jump hosts or SOCKS5 transport layers to reach the API Server; this requires DBX 0.6.17 or later. This provider does not declare static host/port bindings, so HTTP tunnels and non-SOCKS5 proxy layers are not supported; use a transport path that provides the SOCKS5 `proxy_route` capability.

### Overview and monitoring

- Inspect node count and readiness, namespaces, Pod count, and container restarts.
- Review aggregated CPU and memory capacity.
- View Pod and Node metrics when the cluster exposes the Metrics API, typically through Metrics Server.
- Review recent Kubernetes Events and quickly spot warnings and affected objects.
- Refresh manually or configure an automatic refresh interval for resource lists.

### Resource browsing and search

Resources are grouped into:

- **Cluster**: Nodes, Namespaces, Events
- **Workloads**: Pods, Deployments, ReplicaSets, StatefulSets, DaemonSets, Jobs, CronJobs, and HPAs
- **Network**: Services, Ingresses, NetworkPolicies, Endpoints, Gateways, HTTPRoutes, and more
- **Configuration**: ConfigMaps, Secrets, ResourceQuotas, and LimitRanges
- **Storage**: PersistentVolumes, PersistentVolumeClaims, and StorageClasses
- **Security**: Roles, RoleBindings, ClusterRoles, ClusterRoleBindings, and ServiceAccounts
- **Extensions**: other resources and CRDs returned by cluster Discovery

Resource lists include namespace selection, name or label filters, sorting, pagination, column preferences, and CSV export. Global search looks across resource types by name, namespace, or labels. You can favorite common objects and reopen them from Recent resources.

### Resource details and changes

- Inspect object details, status, labels, annotations, related resources, and events.
- View and edit resource YAML; create, update, patch, and delete resources.
- Delete multiple selected objects after an explicit confirmation.
- Resource actions follow the verbs returned by the Kubernetes API and are enabled only when the connected identity has the matching permission.

### Workload and node operations

- Restart, scale, inspect rollout history, and roll back Deployments, StatefulSets, and DaemonSets.
- Trigger or suspend CronJobs.
- Cordon, uncordon, and drain Nodes.
- Edit common workload settings such as container images, probes, environment variables, and volume mounts.

### Pod sessions and networking

- Stream Pod logs.
- Open a shell in a Pod container; with the required permissions, open a Node terminal or a Kubernetes command terminal.
- Browse, read, upload, and delete files in a Pod.
- Create port forwards for Pods, Services, and Deployments.
- Manage active log, terminal, and port-forward sessions from the session panel.

## Installation and use

1. Install **Kubernetes Manager** from DBX.
2. Create a Kubernetes connection in the DBX sidebar, choose an authentication mode, and provide the required values.
3. Select **Test connection** to verify API Server reachability and credentials.
4. Select **Connect** to open the Kubernetes workbench.

The plugin requires DBX <code>>=0.6.17</code>. The cluster identity must have the Kubernetes RBAC permissions for the resources and actions you want to use. A read-only identity is sufficient for inspection. Logs, terminals, file operations, port forwarding, node maintenance, and resource changes each require their corresponding Kubernetes permissions.

## Security and data

- Kubeconfigs, tokens, client certificates, and private keys are handled as DBX secret fields.
- Favorites and Recent resources store only resource references such as type, name, and namespace; complete Secret contents are not written to favorite data.
- <code>Skip TLS verification</code> and kubeconfig exec credentials weaken connection verification. Enable them only when you understand the implications.
- Kubernetes RBAC remains the authority for every resource operation; the plugin does not bypass cluster permissions.

## Acknowledgements

We thank the following open source projects for their foundational capabilities, product ideas, and implementation references:

- [Kite](https://github.com/kite-org/kite): the foundation for Kubernetes management and resource operations.
- [Kite Desktop](https://github.com/eryajf/kite-desktop): references for desktop delivery, interaction design, and local capability integration.

## Project status

The plugin is being improved around the daily Kubernetes workflow, keeping connection, observation, diagnosis, and resource operations together in DBX. The UI and connection form support Chinese and English; some advanced features depend on the DBX host version, Kubernetes API version, Metrics API, and RBAC configuration.

## Development and packaging

To run the plugin from source:

~~~
# Verify Kubernetes connectivity
kubectl cluster-info

# Start the DBX plugin development host
dbx-plugin dev --path . --port 5190

# Test the backend and build the frontend
cd backend && go test ./...
cd ../ui && pnpm install --frozen-lockfile && pnpm run build

# Build an installable candidate
cd .. && dbx-plugin package .
~~~

Release workflows produce unsigned candidates for supported targets. DBX Store reviews, signs, and publishes the installable packages. See <code>scripts/</code>, <code>dbx-plugin.toml</code>, and the CI configuration for engineering details.

## Links

- [DBX](https://github.com/t8y2/dbx)
- [DBX Plugin Store](https://github.com/t8y2/dbx-store)
- [Issues and feature requests](https://github.com/eryajf/dbx-plugin-k8s/issues)
- [Awesome DBX plugins](https://github.com/eryajf/awesome-dbx-plugins)
- [License](./LICENSE)

[Chinese documentation](./README.md)
