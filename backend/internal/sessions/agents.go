package sessions

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	core "k8s.io/api/core/v1"
	rbac "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

const (
	agentNamespace             = "kube-system"
	nodeAgentContainer         = "kite-node-terminal-agent"
	kubectlAgentContainer      = "kite-kubectl-agent"
	nodeAgentImage             = "docker.cnb.cool/znb/images/busybox:latest"
	kubectlAgentImage          = "docker.cnb.cool/znb/images/kubectl:latest"
	kubectlAgentServiceAccount = "kite-kubectl-admin"
	agentStartupTimeout        = 2 * time.Minute
	agentStartupLogTimeout     = 2 * time.Second
	agentStartupLogLimit       = 4096
)

// Probe inside the host root so absolute symlinks and dynamic loaders resolve
// there, not in the agent image. Once selected, exec owns the terminal lifetime:
// a shell exit (including nonzero) must not start a different shell.
const nodeAgentCommand = `for shell in /bin/bash /usr/bin/bash /bin/sh /usr/bin/sh; do
    if chroot /host "$shell" -c 'exit 0'; then
        exec chroot /host "$shell" -i
    fi
done
printf '%s\n' 'node terminal: no usable host shell (bash or sh); chroot probes failed' >&2
exit 127`

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

	resources, err := newAgentResources()
	if err != nil {
		return nil, err
	}
	namespace := terminalAgentNamespace()
	podName := agentName("kite-node-terminal", request.Node)
	// These interactive agents have no graceful shutdown work. Match kubectl's
	// zero grace rather than the default 30s, which exceeds the 8s cleanup budget.
	grace := int64(0)
	pod := &core.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: podName, Namespace: namespace, Labels: map[string]string{"app": podName, "dbx.kubernetes/plugin": "true", "kite.io/component": "node-terminal"}},
		Spec: core.PodSpec{
			NodeName: request.Node, HostNetwork: true, HostPID: true, HostIPC: true,
			RestartPolicy: core.RestartPolicyNever, TerminationGracePeriodSeconds: &grace,
			Tolerations: []core.Toleration{{Operator: core.TolerationOpExists}},
			Volumes:     []core.Volume{{Name: "host", VolumeSource: core.VolumeSource{HostPath: &core.HostPathVolumeSource{Path: "/"}}}},
			Containers: []core.Container{{
				Name: nodeAgentContainer, Image: terminalAgentImage("node"), ImagePullPolicy: core.PullIfNotPresent,
				Stdin: true, StdinOnce: true, TTY: true,
				Command:         []string{"/bin/sh", "-c", nodeAgentCommand},
				SecurityContext: &core.SecurityContext{Privileged: boolPtr(true)},
				VolumeMounts:    []core.VolumeMount{{Name: "host", MountPath: "/host"}},
			}},
		},
	}
	if err := createOwnedAgentResource(ctx, resources, c.Core.CoreV1().Pods(namespace), "Pod", pod); err != nil {
		return nil, errors.Join(fmt.Errorf("create node terminal agent: %w", err), resources.cleanup())
	}
	identity := agentPodIdentity{uid: resources.resources[len(resources.resources)-1].uid, owner: resources.owner}
	if err := waitForAgentPod(ctx, c, namespace, podName, identity); err != nil {
		// The request may already be cancelled; diagnostics get their own short,
		// bounded context and are read before the temporary Pod is removed.
		logs := nodeAgentStartupLogs(c, namespace, podName)
		primary := fmt.Errorf("wait for node terminal agent: %w", err)
		if logs != "" {
			primary = fmt.Errorf("%w; startup logs: %s", primary, logs)
		}
		return nil, errors.Join(primary, resources.cleanup())
	}
	if err := verifyAgentPod(ctx, c, namespace, podName, identity); err != nil {
		return nil, errors.Join(err, resources.cleanup())
	}
	return m.openAgentAttach(ctx, c, connection, namespace, podName, nodeAgentContainer, resources.cleanup)
}

func (m *Manager) kubectlExec(ctx context.Context, c *kube.Client, connection string, raw []byte) (any, error) {
	var request struct{}
	if err := decodeAgentRequest(raw, &request); err != nil {
		return nil, err
	}
	namespace := terminalAgentNamespace()
	serviceAccount, resources, err := ensureKubectlAccess(ctx, c, namespace)
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
	if err := createOwnedAgentResource(ctx, resources, c.Core.CoreV1().Pods(namespace), "Pod", pod); err != nil {
		return nil, errors.Join(fmt.Errorf("create kubectl terminal agent: %w", err), resources.cleanup())
	}
	identity := agentPodIdentity{uid: resources.resources[len(resources.resources)-1].uid, owner: resources.owner}
	if err := waitForAgentPod(ctx, c, namespace, podName, identity); err != nil {
		return nil, errors.Join(fmt.Errorf("wait for kubectl terminal agent: %w", err), resources.cleanup())
	}
	if err := verifyAgentPod(ctx, c, namespace, podName, identity); err != nil {
		return nil, errors.Join(err, resources.cleanup())
	}
	return m.openAgentExec(ctx, c, connection, namespace, podName, kubectlAgentContainer, resources.cleanup)
}

func ensureKubectlAccess(ctx context.Context, c *kube.Client, namespace string) (string, *agentResources, error) {
	resources, err := newAgentResources()
	if err != nil {
		return "", nil, err
	}
	serviceAccount := agentName(kubectlAgentServiceAccount, namespace)
	roleBinding := serviceAccount
	labels := map[string]string{"dbx.kubernetes/plugin": "true", "app.kubernetes.io/managed-by": "dbx-plugin-k8s"}
	err = createOwnedAgentResource(ctx, resources, c.Core.CoreV1().ServiceAccounts(namespace), "ServiceAccount", &core.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: serviceAccount, Namespace: namespace, Labels: labels}})
	if err != nil {
		return "", nil, errors.Join(fmt.Errorf("create kubectl terminal service account: %w", err), resources.cleanup())
	}
	err = createOwnedAgentResource(ctx, resources, c.Core.RbacV1().ClusterRoleBindings(), "ClusterRoleBinding", &rbac.ClusterRoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: roleBinding, Labels: labels},
		Subjects:   []rbac.Subject{{Kind: "ServiceAccount", Name: serviceAccount, Namespace: namespace}},
		RoleRef:    rbac.RoleRef{Kind: "ClusterRole", Name: "cluster-admin", APIGroup: "rbac.authorization.k8s.io"},
	})
	if err != nil {
		return "", nil, errors.Join(fmt.Errorf("create kubectl terminal role binding: %w", err), resources.cleanup())
	}
	return serviceAccount, resources, nil
}

type agentPodIdentity struct {
	uid   types.UID
	owner string
}

func (identity agentPodIdentity) verify(pod *core.Pod) error {
	if identity.uid == "" || pod.UID != identity.uid {
		return fmt.Errorf("agent pod UID mismatch (created %q, observed %q)", identity.uid, pod.UID)
	}
	if identity.owner == "" || pod.Labels[agentOwnerLabel] != identity.owner {
		return fmt.Errorf("agent pod owner token mismatch")
	}
	if pod.DeletionTimestamp != nil {
		return fmt.Errorf("agent pod is terminating (deletionTimestamp=%s)", pod.DeletionTimestamp)
	}
	return nil
}

// This final GET narrows, but cannot eliminate, the name-based attach/exec race:
// Kubernetes' streaming APIs have no atomic UID precondition.
func verifyAgentPod(ctx context.Context, c *kube.Client, namespace, name string, identity agentPodIdentity) error {
	pod, err := c.Core.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("verify agent pod before stream: %w", err)
	}
	return identity.verify(pod)
}

func waitForAgentPod(ctx context.Context, c *kube.Client, namespace, name string, identity agentPodIdentity) error {
	ctx, cancel := context.WithTimeout(ctx, agentStartupTimeout)
	defer cancel()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	lastStatus := "pod not yet observed"
	for {
		pod, err := c.Core.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			if ctx.Err() != nil {
				return fmt.Errorf("wait for agent pod: %w; last status: %s", ctx.Err(), lastStatus)
			}
			if !apierrors.IsNotFound(err) {
				return fmt.Errorf("read agent pod: %w", err)
			}
		} else {
			if err := identity.verify(pod); err != nil {
				return err
			}
			var failed bool
			lastStatus, failed = agentPodStartupStatus(pod)
			// A stale Ready condition must never mask a stopped container or a
			// startup error (including an image pull backoff).
			if failed {
				return fmt.Errorf("agent pod startup failed: %s", lastStatus)
			}
			for _, condition := range pod.Status.Conditions {
				if condition.Type == core.PodReady && condition.Status == core.ConditionTrue {
					return nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("wait for agent pod: %w; last status: %s", ctx.Err(), lastStatus)
		case <-ticker.C:
		}
	}
}

func agentPodStartupStatus(pod *core.Pod) (string, bool) {
	details := []string{fmt.Sprintf("phase=%s reason=%s message=%s", pod.Status.Phase, pod.Status.Reason, pod.Status.Message)}
	failed := pod.Status.Phase == core.PodFailed || pod.Status.Phase == core.PodSucceeded
	for _, group := range []struct {
		statuses []core.ContainerStatus
		init     bool
	}{{pod.Status.InitContainerStatuses, true}, {pod.Status.ContainerStatuses, false}} {
		for _, status := range group.statuses {
			if waiting := status.State.Waiting; waiting != nil {
				details = append(details, fmt.Sprintf("container %s waiting: %s: %s", status.Name, waiting.Reason, waiting.Message))
				switch waiting.Reason {
				case "ErrImagePull", "ImagePullBackOff", "ErrImageNeverPull", "InvalidImageName", "CreateContainerConfigError", "CreateContainerError", "RunContainerError", "CrashLoopBackOff":
					failed = true
				}
			}
			if terminated := status.State.Terminated; terminated != nil {
				details = append(details, fmt.Sprintf("container %s terminated: exitCode=%d signal=%d reason=%s message=%s", status.Name, terminated.ExitCode, terminated.Signal, terminated.Reason, terminated.Message))
				if !group.init || terminated.ExitCode != 0 {
					failed = true
				}
			}
		}
	}
	return strings.Join(details, "; "), failed
}

func nodeAgentStartupLogs(c *kube.Client, namespace, name string) string {
	ctx, cancel := context.WithTimeout(context.Background(), agentStartupLogTimeout)
	defer cancel()
	tail, limit := int64(100), int64(agentStartupLogLimit)
	reader, err := c.Core.CoreV1().Pods(namespace).GetLogs(name, &core.PodLogOptions{
		Container: nodeAgentContainer, TailLines: &tail, LimitBytes: &limit,
	}).Stream(ctx)
	if err != nil {
		return ""
	}
	defer reader.Close()
	// Do not trust the API server to honor LimitBytes.
	logs, _ := io.ReadAll(io.LimitReader(reader, agentStartupLogLimit))
	return strings.TrimSpace(string(logs))
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
