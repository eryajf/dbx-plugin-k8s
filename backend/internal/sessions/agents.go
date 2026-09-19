package sessions

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	core "k8s.io/api/core/v1"
	rbac "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	agentNamespace             = "kube-system"
	nodeAgentContainer         = "kite-node-terminal-agent"
	kubectlAgentContainer      = "kite-kubectl-agent"
	nodeAgentImage             = "docker.cnb.cool/znb/images/busybox:latest"
	kubectlAgentImage          = "docker.cnb.cool/znb/images/kubectl:latest"
	kubectlAgentServiceAccount = "kite-kubectl-admin"
)

func terminalAgentNamespace() string {
	if value := strings.TrimSpace(os.Getenv("NAMESPACE")); value != "" {
		return value
	}
	return agentNamespace
}

func terminalAgentImage(kind string) string {
	if kind == "node" {
		if value := strings.TrimSpace(os.Getenv("NODE_TERMINAL_IMAGE")); value != "" {
			return value
		}
		return nodeAgentImage
	}
	if value := strings.TrimSpace(os.Getenv("KUBECTL_TERMINAL_IMAGE")); value != "" {
		return value
	}
	return kubectlAgentImage
}

func (m *Manager) nodeExec(ctx context.Context, c *kube.Client, connection string, raw []byte) (any, error) {
	var request struct {
		Node string `json:"node"`
	}
	if err := decodeAgentRequest(raw, &request); err != nil {
		return nil, err
	}
	if request.Node == "" {
		return nil, fmt.Errorf("node is required")
	}
	if _, err := c.Core.CoreV1().Nodes().Get(ctx, request.Node, metav1.GetOptions{}); err != nil {
		return nil, err
	}

	namespace := terminalAgentNamespace()
	podName := agentName("kite-node-terminal", request.Node)
	pod := &core.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: podName, Namespace: namespace, Labels: map[string]string{"app": podName, "dbx.kubernetes/plugin": "true", "kite.io/component": "node-terminal"}},
		Spec: core.PodSpec{
			NodeName: request.Node, HostNetwork: true, HostPID: true, HostIPC: true,
			RestartPolicy: core.RestartPolicyNever,
			Tolerations:   []core.Toleration{{Operator: core.TolerationOpExists}},
			Volumes:       []core.Volume{{Name: "host", VolumeSource: core.VolumeSource{HostPath: &core.HostPathVolumeSource{Path: "/"}}}},
			Containers: []core.Container{{
				Name: nodeAgentContainer, Image: terminalAgentImage("node"), ImagePullPolicy: core.PullIfNotPresent,
				Stdin: true, StdinOnce: true, TTY: true,
				Command:         []string{"/bin/sh", "-c", "chroot /host || (exec /bin/zsh || exec /bin/bash || exec /bin/sh)"},
				SecurityContext: &core.SecurityContext{Privileged: boolPtr(true)},
				VolumeMounts:    []core.VolumeMount{{Name: "host", MountPath: "/host"}},
			}},
		},
	}
	if _, err := c.Core.CoreV1().Pods(namespace).Create(ctx, pod, metav1.CreateOptions{}); err != nil {
		return nil, fmt.Errorf("create node terminal agent: %w", err)
	}
	if err := waitForAgentPod(ctx, c, namespace, podName); err != nil {
		_ = deleteAgentPod(namespace, podName, c)
		return nil, fmt.Errorf("wait for node terminal agent: %w", err)
	}
	return m.openAgentExec(ctx, c, connection, namespace, podName, nodeAgentContainer, func() { _ = deleteAgentPod(namespace, podName, c) })
}

func (m *Manager) kubectlExec(ctx context.Context, c *kube.Client, connection string, raw []byte) (any, error) {
	var request struct{}
	if err := decodeAgentRequest(raw, &request); err != nil {
		return nil, err
	}
	namespace := terminalAgentNamespace()
	serviceAccount, cleanupAccess, err := ensureKubectlAccess(ctx, c, namespace)
	if err != nil {
		return nil, err
	}
	podName := agentName("kite-kubectl-agent", connection)
	grace := int64(0)
	pod := &core.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: podName, Namespace: namespace, Labels: map[string]string{"app.kubernetes.io/managed-by": "dbx-plugin-k8s", "dbx.kubernetes/plugin": "true", "kite.io/component": "kubectl-terminal"}},
		Spec: core.PodSpec{
			RestartPolicy: core.RestartPolicyNever, ServiceAccountName: serviceAccount,
			AutomountServiceAccountToken: boolPtr(true), Hostname: "kubectl", TerminationGracePeriodSeconds: &grace,
			Containers: []core.Container{{Name: kubectlAgentContainer, Image: terminalAgentImage("kubectl"), ImagePullPolicy: core.PullIfNotPresent, Stdin: true, StdinOnce: true, TTY: true, Command: []string{"bash", "-c", "exec bash"}}},
		},
	}
	if _, err := c.Core.CoreV1().Pods(namespace).Create(ctx, pod, metav1.CreateOptions{}); err != nil {
		cleanupAccess()
		return nil, fmt.Errorf("create kubectl terminal agent: %w", err)
	}
	if err := waitForAgentPod(ctx, c, namespace, podName); err != nil {
		_ = deleteAgentPod(namespace, podName, c)
		cleanupAccess()
		return nil, fmt.Errorf("wait for kubectl terminal agent: %w", err)
	}
	return m.openAgentExec(ctx, c, connection, namespace, podName, kubectlAgentContainer, func() {
		_ = deleteAgentPod(namespace, podName, c)
		cleanupAccess()
	})
}

func ensureKubectlAccess(ctx context.Context, c *kube.Client, namespace string) (string, func(), error) {
	serviceAccount := agentName(kubectlAgentServiceAccount, namespace)
	roleBinding := serviceAccount
	labels := map[string]string{"dbx.kubernetes/plugin": "true", "app.kubernetes.io/managed-by": "dbx-plugin-k8s"}
	_, err := c.Core.CoreV1().ServiceAccounts(namespace).Create(ctx, &core.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: serviceAccount, Namespace: namespace, Labels: labels}}, metav1.CreateOptions{})
	if err != nil {
		return "", func() {}, fmt.Errorf("create kubectl terminal service account: %w", err)
	}
	_, err = c.Core.RbacV1().ClusterRoleBindings().Create(ctx, &rbac.ClusterRoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: roleBinding, Labels: labels},
		Subjects:   []rbac.Subject{{Kind: "ServiceAccount", Name: serviceAccount, Namespace: namespace}},
		RoleRef:    rbac.RoleRef{Kind: "ClusterRole", Name: "cluster-admin", APIGroup: "rbac.authorization.k8s.io"},
	}, metav1.CreateOptions{})
	if err != nil {
		_ = deleteKubectlAccess(namespace, serviceAccount, roleBinding, c)
		return "", func() {}, fmt.Errorf("create kubectl terminal role binding: %w", err)
	}
	return serviceAccount, func() {
		_ = deleteKubectlAccess(namespace, serviceAccount, roleBinding, c)
	}, nil
}

func deleteKubectlAccess(namespace, serviceAccount, roleBinding string, c *kube.Client) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := c.Core.RbacV1().ClusterRoleBindings().Delete(ctx, roleBinding, metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	if err := c.Core.CoreV1().ServiceAccounts(namespace).Delete(ctx, serviceAccount, metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	return nil
}

func waitForAgentPod(ctx context.Context, c *kube.Client, namespace, name string) error {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		pod, err := c.Core.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if !apierrors.IsNotFound(err) {
				return fmt.Errorf("read agent pod: %w", err)
			}
		} else {
			for _, condition := range pod.Status.Conditions {
				if condition.Type == core.PodReady && condition.Status == core.ConditionTrue {
					return nil
				}
			}
			if pod.Status.Phase == core.PodFailed {
				return fmt.Errorf("agent pod failed: %s", pod.Status.Reason)
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func deleteAgentPod(namespace, name string, c *kube.Client) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return c.Core.CoreV1().Pods(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func decodeAgentRequest(raw []byte, target any) error {
	if err := json.Unmarshal(raw, target); err != nil {
		return err
	}
	return nil
}

func agentName(prefix, value string) string {
	value = strings.ToLower(value)
	var b strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	suffix := randomSuffix()
	base := strings.Trim(b.String(), "-.")
	if base == "" {
		base = "target"
	}
	max := 63 - len(prefix) - len(suffix) - 2
	if len(base) > max {
		base = strings.TrimRight(base[:max], "-.")
	}
	return fmt.Sprintf("%s-%s-%s", prefix, base, suffix)
}

func randomSuffix() string {
	b := make([]byte, 3)
	if _, err := rand.Read(b); err != nil {
		return "000"
	}
	return fmt.Sprintf("%02x%02x%02x", b[0], b[1], b[2])
}

func boolPtr(value bool) *bool { return &value }
