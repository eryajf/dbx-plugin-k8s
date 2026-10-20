package sessions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	core "k8s.io/api/core/v1"
	rbac "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

func agentTestClient(t *testing.T, handler http.HandlerFunc) *kube.Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	config := &rest.Config{Host: server.URL}
	client, err := kubernetes.NewForConfig(config)
	if err != nil {
		t.Fatal(err)
	}
	return &kube.Client{Core: client, Config: config, Context: context.Background()}
}

func readyAgentStatus() core.PodStatus {
	return core.PodStatus{Phase: core.PodRunning, Conditions: []core.PodCondition{{Type: core.PodReady, Status: core.ConditionTrue}}}
}

func TestWaitForAgentPodStatus(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status core.PodStatus
		want   []string
	}{
		{"ready", readyAgentStatus(), nil},
		{"failed before ready", core.PodStatus{Phase: core.PodFailed, Reason: "Evicted", Message: "node pressure", Conditions: readyAgentStatus().Conditions}, []string{"Failed", "Evicted", "node pressure"}},
		{"succeeded before ready", core.PodStatus{Phase: core.PodSucceeded, Conditions: readyAgentStatus().Conditions}, []string{"Succeeded"}},
		{"terminated before ready", core.PodStatus{Phase: core.PodRunning, Conditions: readyAgentStatus().Conditions, ContainerStatuses: []core.ContainerStatus{{Name: nodeAgentContainer, State: core.ContainerState{Terminated: &core.ContainerStateTerminated{ExitCode: 127, Reason: "Error", Message: "host shell missing"}}}}}, []string{"terminated", "exitCode=127", "Error", "host shell missing"}},
		{"clean shell exit", core.PodStatus{Phase: core.PodRunning, ContainerStatuses: []core.ContainerStatus{{Name: nodeAgentContainer, State: core.ContainerState{Terminated: &core.ContainerStateTerminated{ExitCode: 0, Reason: "Completed"}}}}}, []string{"exitCode=0", "Completed"}},
		{"image backoff before ready", core.PodStatus{Phase: core.PodPending, Conditions: readyAgentStatus().Conditions, ContainerStatuses: []core.ContainerStatus{{Name: nodeAgentContainer, State: core.ContainerState{Waiting: &core.ContainerStateWaiting{Reason: "ImagePullBackOff", Message: "image unavailable"}}}}}, []string{"waiting", "ImagePullBackOff", "image unavailable"}},
		{"init failure", core.PodStatus{Phase: core.PodPending, InitContainerStatuses: []core.ContainerStatus{{Name: "init", State: core.ContainerState{Terminated: &core.ContainerStateTerminated{ExitCode: 1, Reason: "Error"}}}}}, []string{"container init", "exitCode=1"}},
		{"completed init", core.PodStatus{Phase: core.PodRunning, Conditions: readyAgentStatus().Conditions, InitContainerStatuses: []core.ContainerStatus{{Name: "init", State: core.ContainerState{Terminated: &core.ContainerStateTerminated{ExitCode: 0}}}}}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := agentTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(&core.Pod{ObjectMeta: metav1.ObjectMeta{UID: "test-uid", Labels: map[string]string{agentOwnerLabel: "test-owner"}}, Status: tc.status})
			})
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			err := waitForAgentPod(ctx, client, "test", "agent", agentPodIdentity{uid: "test-uid", owner: "test-owner"})
			if len(tc.want) == 0 {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("expected immediate startup error, got %v", err)
			}
			for _, want := range tc.want {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error %q missing %q", err, want)
				}
			}
		})
	}
}

func TestWaitForAgentPodTimeoutDetail(t *testing.T) {
	client := agentTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(&core.Pod{ObjectMeta: metav1.ObjectMeta{UID: "test-uid", Labels: map[string]string{agentOwnerLabel: "test-owner"}}, Status: core.PodStatus{
			Phase: core.PodPending,
			ContainerStatuses: []core.ContainerStatus{{Name: nodeAgentContainer, State: core.ContainerState{Waiting: &core.ContainerStateWaiting{
				Reason: "ContainerCreating", Message: "waiting for volume mount",
			}}}},
		}})
	})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	err := waitForAgentPod(ctx, client, "test", "agent", agentPodIdentity{uid: "test-uid", owner: "test-owner"})
	if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "ContainerCreating") || !strings.Contains(err.Error(), "waiting for volume mount") {
		t.Fatalf("expected timeout with waiting detail, got %v", err)
	}
}

func TestWaitForAgentPodAPIFailure(t *testing.T) {
	client := agentTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(&metav1.Status{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Status"}, Status: "Failure", Reason: metav1.StatusReasonForbidden, Message: "pods forbidden", Code: 403})
	})
	err := waitForAgentPod(context.Background(), client, "test", "agent", agentPodIdentity{uid: "test-uid", owner: "test-owner"})
	if err == nil || !strings.Contains(err.Error(), "read agent pod") || !strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("expected original API error, got %v", err)
	}
}

func TestNodeAgentPodAndFailureLogs(t *testing.T) {
	t.Setenv("NAMESPACE", "node-test")
	t.Setenv("NODE_TERMINAL_IMAGE", "test/node:local")
	var created core.Pod
	removed := false
	var events []string
	client := agentTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/nodes/node-1":
			_ = json.NewEncoder(w).Encode(&core.Node{ObjectMeta: metav1.ObjectMeta{Name: "node-1"}})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/namespaces/node-test/pods":
			if err := json.NewDecoder(r.Body).Decode(&created); err != nil {
				t.Error(err)
			}
			created.UID = "node-pod-uid"
			_ = json.NewEncoder(w).Encode(&created)
		case strings.HasSuffix(r.URL.Path, "/log"):
			events = append(events, "logs")
			q := r.URL.Query()
			if q.Get("container") != nodeAgentContainer || q.Get("tailLines") != "100" || q.Get("limitBytes") != "4096" || q.Get("follow") == "true" {
				t.Errorf("unbounded or wrong log request: %s", r.URL)
			}
			_, _ = fmt.Fprint(w, "chroot: host shell could not start\n"+strings.Repeat("x", 8192)+"UNBOUNDED-END")
		case r.Method == http.MethodDelete:
			removed = true
			events = append(events, "delete")
			_ = json.NewEncoder(w).Encode(&metav1.Status{Status: "Success"})
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/pods/"):
			if removed {
				writeAgentAPIError(w, 404, metav1.StatusReasonNotFound)
				return
			}
			_ = json.NewEncoder(w).Encode(&core.Pod{ObjectMeta: created.ObjectMeta, Status: core.PodStatus{Phase: core.PodFailed, Reason: "OriginalFailure", Message: "original detail"}})
		default:
			t.Errorf("unexpected API request (must not read credentials): %s %s", r.Method, r.URL)
			http.NotFound(w, r)
		}
	})
	m := New()
	defer m.Close()
	_, err := m.nodeExec(context.Background(), client, "conn", []byte(`{"node":"node-1"}`))
	if err == nil || !strings.Contains(err.Error(), "OriginalFailure") || !strings.Contains(err.Error(), "original detail") || !strings.Contains(err.Error(), "chroot: host shell could not start") {
		t.Fatalf("missing original failure or startup logs: %v", err)
	}
	if strings.Contains(err.Error(), "UNBOUNDED-END") || len(err.Error()) > agentStartupLogLimit+300 {
		t.Fatalf("startup logs not bounded: %d bytes", len(err.Error()))
	}
	if !reflect.DeepEqual(events, []string{"logs", "delete"}) {
		t.Fatalf("logs must precede cleanup: %v", events)
	}
	if created.Namespace != "node-test" || !strings.HasPrefix(created.Name, "kite-node-terminal-node-1-") || created.Labels["kite.io/component"] != "node-terminal" || created.Labels["dbx.kubernetes/plugin"] != "true" || created.Labels["app"] != created.Name {
		t.Fatalf("node Pod identity changed: %+v", created.ObjectMeta)
	}
	spec := created.Spec
	if spec.TerminationGracePeriodSeconds == nil || *spec.TerminationGracePeriodSeconds != 0 {
		t.Fatal("node agent must use zero graceful shutdown budget")
	}
	if spec.NodeName != "node-1" || !spec.HostNetwork || !spec.HostPID || !spec.HostIPC || spec.RestartPolicy != core.RestartPolicyNever {
		t.Fatalf("node placement or host namespaces changed: %+v", spec)
	}
	if !reflect.DeepEqual(spec.Tolerations, []core.Toleration{{Operator: core.TolerationOpExists}}) || len(spec.Volumes) != 1 || spec.Volumes[0].Name != "host" || spec.Volumes[0].HostPath == nil || spec.Volumes[0].HostPath.Path != "/" {
		t.Fatalf("host volume or tolerations changed: %+v", spec)
	}
	if len(spec.Containers) != 1 {
		t.Fatalf("unexpected containers: %+v", spec.Containers)
	}
	container := spec.Containers[0]
	if container.Name != nodeAgentContainer || container.Image != "test/node:local" || container.ImagePullPolicy != core.PullIfNotPresent || !container.Stdin || !container.StdinOnce || !container.TTY || container.SecurityContext == nil || container.SecurityContext.Privileged == nil || !*container.SecurityContext.Privileged {
		t.Fatalf("node container configuration changed: %+v", container)
	}
	if !reflect.DeepEqual(container.Command, []string{"/bin/sh", "-c", nodeAgentCommand}) || !reflect.DeepEqual(container.VolumeMounts, []core.VolumeMount{{Name: "host", MountPath: "/host"}}) {
		t.Fatalf("unexpected command or host mount: %+v", container)
	}
}

func TestNodeAgentEntryUsesAttach(t *testing.T) {
	t.Setenv("NAMESPACE", "node-test")
	var podName string
	var created core.Pod
	removed := false
	deleted := make(chan string, 2)
	client := agentTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/nodes/"):
			_ = json.NewEncoder(w).Encode(&core.Node{})
		case r.Method == http.MethodPost:
			var pod core.Pod
			if err := json.NewDecoder(r.Body).Decode(&pod); err != nil {
				t.Error(err)
			}
			podName = pod.Name
			pod.UID = "attach-pod-uid"
			created = pod
			_ = json.NewEncoder(w).Encode(&pod)
		case r.Method == http.MethodDelete:
			removed = true
			deleted <- r.URL.Path
			_ = json.NewEncoder(w).Encode(&metav1.Status{Status: "Success"})
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/pods/") && !strings.HasSuffix(r.URL.Path, "/log"):
			if removed {
				writeAgentAPIError(w, 404, metav1.StatusReasonNotFound)
				return
			}
			_ = json.NewEncoder(w).Encode(&core.Pod{ObjectMeta: created.ObjectMeta, Status: readyAgentStatus()})
		default:
			t.Errorf("unexpected API request: %s %s", r.Method, r.URL)
			http.NotFound(w, r)
		}
	})
	called := false
	stubTerminalExecutor(t, func(_ *rest.Config, target *url.URL) (remotecommand.Executor, error) {
		called = true
		wantPath := "/api/v1/namespaces/node-test/pods/" + podName + "/attach"
		if target.Path != wantPath || target.Query().Get("container") != nodeAgentContainer || len(target.Query()["command"]) != 0 {
			t.Errorf("node entry must attach to existing host shell, got %s", target)
		}
		return terminalExecutorFunc(func(ctx context.Context, _ remotecommand.StreamOptions) error {
			<-ctx.Done()
			return ctx.Err()
		}), nil
	})
	m := New()
	defer m.Close()
	result, err := m.nodeExec(context.Background(), client, "conn", []byte(`{"node":"node-1"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("node entry never opened attach")
	}
	id := result.(map[string]string)["sessionId"]
	if err := m.remove("conn", id); err != nil {
		t.Fatal(err)
	}
	select {
	case path := <-deleted:
		if path != "/api/v1/namespaces/node-test/pods/"+podName {
			t.Fatalf("deleted wrong Pod: %s", path)
		}
	case <-time.After(time.Second):
		t.Fatal("closing attach session did not delete agent Pod")
	}
}

func TestNodeAgentStartupLogsBoundedContext(t *testing.T) {
	client := agentTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/log") {
			t.Errorf("unexpected request: %s", r.URL)
		}
		// Block after headers to exercise the body-read deadline, not just dialing.
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	started := time.Now()
	if logs := nodeAgentStartupLogs(client, "test", "agent"); logs != "" {
		t.Fatalf("unexpected logs: %q", logs)
	}
	if elapsed := time.Since(started); elapsed > agentStartupLogTimeout+time.Second {
		t.Fatalf("startup logs exceeded independent deadline: %v", elapsed)
	}
}

func TestNodeAgentLogFailurePreservesCancellation(t *testing.T) {
	t.Setenv("NAMESPACE", "node-test")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var events []string
	var created core.Pod
	removed := false
	client := agentTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/nodes/"):
			_ = json.NewEncoder(w).Encode(&core.Node{})
		case r.Method == http.MethodPost:
			if err := json.NewDecoder(r.Body).Decode(&created); err != nil {
				t.Error(err)
			}
			created.UID = "cancelled-pod-uid"
			_ = json.NewEncoder(w).Encode(&created)
		case strings.HasSuffix(r.URL.Path, "/log"):
			events = append(events, "logs")
			// This independent request must still arrive after the unary context died.
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(&metav1.Status{Reason: metav1.StatusReasonForbidden, Message: "logs unavailable", Code: 403})
		case r.Method == http.MethodDelete:
			removed = true
			events = append(events, "delete")
			_ = json.NewEncoder(w).Encode(&metav1.Status{Status: "Success"})
		default:
			if removed {
				writeAgentAPIError(w, 404, metav1.StatusReasonNotFound)
				return
			}
			cancel()
			_ = json.NewEncoder(w).Encode(&created)
		}
	})
	m := New()
	defer m.Close()
	_, err := m.nodeExec(ctx, client, "conn", []byte(`{"node":"node-1"}`))
	if !errors.Is(err, context.Canceled) || strings.Contains(err.Error(), "logs unavailable") {
		t.Fatalf("log failure replaced original cancellation: %v", err)
	}
	if !reflect.DeepEqual(events, []string{"logs", "delete"}) {
		t.Fatalf("cancelled request skipped diagnostics or cleanup: %v", events)
	}
}

func TestNodeAgentHostShell(t *testing.T) {
	for _, tc := range []struct {
		name        string
		shells      []string
		selected    string
		symlink     bool
		chrootFails bool
		exit        int
		wantExit    int
	}{
		{"prefer bin bash", []string{"/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"}, "/bin/bash", false, false, 0, 0},
		{"prefer usr bash over sh", []string{"/usr/bin/bash", "/bin/sh"}, "/usr/bin/bash", false, false, 0, 0},
		{"fallback bin sh", []string{"/bin/sh", "/usr/bin/sh"}, "/bin/sh", false, false, 0, 0},
		{"fallback usr sh", []string{"/usr/bin/sh"}, "/usr/bin/sh", false, false, 0, 0},
		{"absolute host symlink", []string{"/bin/bash", "/bin/sh"}, "/bin/bash", true, false, 0, 0},
		{"no host shell", nil, "", false, false, 0, 127},
		{"chroot failure", []string{"/bin/bash", "/bin/sh"}, "", false, true, 0, 127},
		{"clean exit no fallback", []string{"/bin/bash", "/bin/sh"}, "/bin/bash", false, false, 0, 0},
		{"nonzero exit no fallback", []string{"/bin/bash", "/bin/sh"}, "/bin/bash", false, false, 42, 42},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			root := filepath.Join(dir, "host")
			for _, shell := range tc.shells {
				path := filepath.Join(root, shell)
				if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte("stub host shell"), 0755); err != nil {
					t.Fatal(err)
				}
			}
			if tc.symlink {
				// This target deliberately does not exist in the container/test root.
				// Only resolving it relative to the fake host root can find bash.
				target := "/dbx-host-only-shell/bash"
				if err := os.MkdirAll(filepath.Join(root, filepath.Dir(target)), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(filepath.Join(root, "/bin/bash"), filepath.Join(root, target)); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, filepath.Join(root, "/bin/bash")); err != nil {
					t.Fatal(err)
				}
			}
			// PATH contains only this chroot replacement. No test invokes real chroot.
			stub := `#!/bin/sh
printf '%s\n' "$*" >> "$TRACE"
[ "$1" = /host ] || exit 90
if [ "$CHROOT_FAIL" = 1 ]; then
    printf '%s\n' 'chroot: operation not permitted' >&2
    exit 1
fi
file="$FAKE_HOST$2"
if [ -L "$file" ]; then
    target=$(/usr/bin/readlink "$file")
    file="$FAKE_HOST$target"
fi
if [ ! -x "$file" ]; then
    printf 'chroot: %s: not found\n' "$2" >&2
    exit 127
fi
if [ "$3" = -c ] && [ "$4" = 'exit 0' ]; then exit 0; fi
[ "$3" = -i ] && [ "$#" = 3 ] || exit 91
printf 'interactive:%s\n' "$2"
exit "$SHELL_EXIT"
`
			if err := os.WriteFile(filepath.Join(dir, "chroot"), []byte(stub), 0755); err != nil {
				t.Fatal(err)
			}
			trace := filepath.Join(dir, "trace")
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, "/bin/sh", "-c", nodeAgentCommand)
			cmd.Env = append(os.Environ(), "PATH="+dir, "FAKE_HOST="+root, "TRACE="+trace, fmt.Sprintf("SHELL_EXIT=%d", tc.exit), fmt.Sprintf("CHROOT_FAIL=%d", boolInt(tc.chrootFails)))
			output, err := cmd.CombinedOutput()
			exitCode := 0
			if err != nil {
				var exitErr *exec.ExitError
				if !errors.As(err, &exitErr) {
					t.Fatal(err)
				}
				exitCode = exitErr.ExitCode()
			}
			if exitCode != tc.wantExit {
				t.Fatalf("exit=%d want=%d output=%s", exitCode, tc.wantExit, output)
			}
			data, err := os.ReadFile(trace)
			if err != nil {
				t.Fatal(err)
			}
			var want []string
			for _, shell := range []string{"/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"} {
				want = append(want, "/host "+shell+" -c exit 0")
				if shell == tc.selected {
					want = append(want, "/host "+shell+" -i")
					break
				}
			}
			if got := strings.Split(strings.TrimSpace(string(data)), "\n"); !reflect.DeepEqual(got, want) {
				t.Fatalf("wrong shell probes/exec or shell restarted: got %q want %q", got, want)
			}
			if tc.selected == "" && !strings.Contains(string(output), "no usable host shell") {
				t.Fatalf("missing no-host-shell diagnostic: %s", output)
			}
			if tc.chrootFails && !strings.Contains(string(output), "operation not permitted") {
				t.Fatalf("chroot diagnostics discarded: %s", output)
			}
		})
	}
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func TestAgentEntryRejectsReplacementAndTerminating(t *testing.T) {
	for _, entry := range []string{"node", "kubectl"} {
		for _, stage := range []int{1, 2} {
			for _, change := range []string{"UID", "owner", "terminating"} {
				t.Run(fmt.Sprintf("%s/GET-%d/%s", entry, stage, change), func(t *testing.T) {
					t.Setenv("NAMESPACE", "ops")
					var pod core.Pod
					var serviceAccount core.ServiceAccount
					var binding rbac.ClusterRoleBinding
					podGets, podDeletes := 0, 0
					removed := map[string]bool{}
					client := agentTestClient(t, func(w http.ResponseWriter, req *http.Request) {
						path := req.URL.Path
						if strings.Contains(path, "/nodes/") {
							_ = json.NewEncoder(w).Encode(&core.Node{})
							return
						}
						kind := "pod"
						if strings.Contains(path, "serviceaccounts") {
							kind = "sa"
						}
						if strings.Contains(path, "clusterrolebindings") {
							kind = "crb"
						}
						if strings.HasSuffix(path, "/log") {
							writeAgentAPIError(w, 403, metav1.StatusReasonForbidden)
							return
						}
						switch req.Method {
						case http.MethodPost:
							switch kind {
							case "pod":
								_ = json.NewDecoder(req.Body).Decode(&pod)
								pod.UID = "created-uid"
								_ = json.NewEncoder(w).Encode(&pod)
							case "sa":
								_ = json.NewDecoder(req.Body).Decode(&serviceAccount)
								serviceAccount.UID = "sa-uid"
								_ = json.NewEncoder(w).Encode(&serviceAccount)
							case "crb":
								_ = json.NewDecoder(req.Body).Decode(&binding)
								binding.UID = "crb-uid"
								_ = json.NewEncoder(w).Encode(&binding)
							}
						case http.MethodGet:
							if removed[kind] {
								writeAgentAPIError(w, 404, metav1.StatusReasonNotFound)
								return
							}
							switch kind {
							case "pod":
								podGets++
								if podGets == stage {
									switch change {
									case "UID":
										pod.UID = "replacement-uid"
									case "owner":
										pod.Labels[agentOwnerLabel] = "foreign"
									case "terminating":
										now := metav1.Now()
										pod.DeletionTimestamp = &now
									}
								}
								pod.Status = readyAgentStatus()
								_ = json.NewEncoder(w).Encode(&pod)
							case "sa":
								_ = json.NewEncoder(w).Encode(&serviceAccount)
							case "crb":
								_ = json.NewEncoder(w).Encode(&binding)
							}
						case http.MethodDelete:
							if kind == "pod" {
								podDeletes++
							}
							removed[kind] = true
							_ = json.NewEncoder(w).Encode(&metav1.Status{Status: "Success"})
						}
					})
					stubTerminalExecutor(t, func(*rest.Config, *url.URL) (remotecommand.Executor, error) {
						t.Error("must not open a stream to replaced/terminating agent")
						return nil, errors.New("unexpected stream")
					})
					m := New()
					defer m.Close()
					var err error
					if entry == "node" {
						_, err = m.nodeExec(context.Background(), client, "conn", []byte(`{"node":"node-1"}`))
					} else {
						_, err = m.kubectlExec(context.Background(), client, "conn", []byte(`{}`))
					}
					want := "UID mismatch"
					if change == "owner" {
						want = "owner token mismatch"
					}
					if change == "terminating" {
						want = "terminating"
					}
					if err == nil || !strings.Contains(err.Error(), want) {
						t.Fatalf("invalid agent identity accepted: %v", err)
					}
					if change != "terminating" && podDeletes != 0 {
						t.Fatal("deleted replacement/foreign Pod")
					}
					if entry == "kubectl" && (!removed["sa"] || !removed["crb"]) {
						t.Fatal("identity rejection leaked kubectl RBAC")
					}
				})
			}
		}
	}
}
