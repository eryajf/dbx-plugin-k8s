package sessions

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	core "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	kwatch "k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

// Streams must not inherit the unary HTTP timeout used by normal resource calls.
func streamCore(c *kube.Client) (*kubernetes.Clientset, *rest.Config, error) {
	cfg := rest.CopyConfig(c.Config)
	cfg.Timeout = 0
	client, err := kubernetes.NewForConfig(cfg)
	return client, cfg, err
}
func (m *Manager) logs(ctx context.Context, c *kube.Client, connection string, raw json.RawMessage) (any, error) {
	var p struct {
		Namespace    string     `json:"namespace"`
		Name         string     `json:"name"`
		Container    string     `json:"container"`
		Containers   []string   `json:"containers"`
		Follow       bool       `json:"follow"`
		Previous     bool       `json:"previous"`
		TailLines    *int64     `json:"tailLines"`
		SinceSeconds *int64     `json:"sinceSeconds"`
		SinceTime    *meta.Time `json:"sinceTime"`
		Timestamps   bool       `json:"timestamps"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if p.Namespace == "" || p.Name == "" {
		return nil, fmt.Errorf("namespace and name required")
	}
	if p.SinceSeconds != nil && p.SinceTime != nil {
		return nil, fmt.Errorf("sinceSeconds and sinceTime are mutually exclusive")
	}
	if p.TailLines != nil && *p.TailLines < 0 || p.SinceSeconds != nil && *p.SinceSeconds < 0 {
		return nil, fmt.Errorf("negative log limit")
	}
	if p.Container != "" {
		p.Containers = []string{p.Container}
	}
	if len(p.Containers) == 0 {
		pod, err := c.Core.CoreV1().Pods(p.Namespace).Get(ctx, p.Name, meta.GetOptions{})
		if err != nil {
			return nil, err
		}
		for _, container := range pod.Spec.Containers {
			p.Containers = append(p.Containers, container.Name)
		}
	}
	if len(p.Containers) == 0 || len(p.Containers) > 64 {
		return nil, fmt.Errorf("invalid container count")
	}
	client, _, err := streamCore(c)
	if err != nil {
		return nil, err
	}
	s, err := m.open(c.Context, connection, "logs")
	if err != nil {
		return nil, err
	}
	go func() {
		var wg sync.WaitGroup
		var errMu sync.Mutex
		var firstErr error
		for _, container := range p.Containers {
			wg.Add(1)
			go func(container string) {
				defer wg.Done()
				reader, e := client.CoreV1().Pods(p.Namespace).GetLogs(p.Name, &core.PodLogOptions{Container: container, Follow: p.Follow, Previous: p.Previous, TailLines: p.TailLines, SinceSeconds: p.SinceSeconds, SinceTime: p.SinceTime, Timestamps: p.Timestamps}).Stream(s.ctx)
				if e == nil {
					defer reader.Close()
					r := bufio.NewReaderSize(reader, 32*1024)
					for {
						line, readErr := r.ReadSlice('\n')
						if len(line) > 0 {
							_, _ = s.Write(append([]byte("["+container+"] "), line...))
						}
						if readErr == bufio.ErrBufferFull {
							continue
						}
						if readErr != nil {
							if readErr != io.EOF {
								e = readErr
							}
							break
						}
					}
				}
				if e != nil {
					errMu.Lock()
					if firstErr == nil {
						firstErr = fmt.Errorf("container %s: %w", container, e)
					}
					errMu.Unlock()
				}
			}(container)
		}
		wg.Wait()
		s.finish(firstErr)
	}()
	return map[string]string{"sessionId": s.id}, nil
}
func (m *Manager) exec(ctx context.Context, c *kube.Client, connection string, raw json.RawMessage) (any, error) {
	var p struct {
		Namespace string   `json:"namespace"`
		Name      string   `json:"name"`
		Container string   `json:"container"`
		Command   []string `json:"command"`
		TTY       bool     `json:"tty"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if p.Namespace == "" || p.Name == "" || len(p.Command) == 0 {
		return nil, fmt.Errorf("namespace, name and command array required")
	}
	client, cfg, err := streamCore(c)
	if err != nil {
		return nil, err
	}
	u := client.CoreV1().RESTClient().Post().Resource("pods").Namespace(p.Namespace).Name(p.Name).SubResource("exec").VersionedParams(&core.PodExecOptions{Container: p.Container, Command: p.Command, Stdin: true, Stdout: true, Stderr: !p.TTY, TTY: p.TTY}, scheme.ParameterCodec).URL()
	executor, err := kube.NewRemoteCommandExecutor(cfg, u)
	if err != nil {
		return nil, err
	}
	s, err := m.open(c.Context, connection, "exec")
	if err != nil {
		return nil, err
	}
	input, writer := io.Pipe()
	s.mu.Lock()
	s.input = writer
	s.mu.Unlock()
	go func() {
		defer input.Close()
		options := remotecommand.StreamOptions{Stdin: input, Stdout: s, Tty: p.TTY, TerminalSizeQueue: s}
		if !p.TTY {
			options.Stderr = s
		}
		s.finish(executor.StreamWithContext(s.ctx, options))
	}()
	return map[string]string{"sessionId": s.id}, nil
}

// openAgentExec starts an interactive shell in an already-created agent Pod.
// Agent lifecycle is owned by the session so closing the terminal also removes
// the temporary Pod.
func (m *Manager) openAgentExec(ctx context.Context, c *kube.Client, connection, namespace, pod, container string, cleanup func()) (any, error) {
	client, cfg, err := streamCore(c)
	if err != nil {
		return nil, err
	}
	u := client.CoreV1().RESTClient().Post().Resource("pods").Namespace(namespace).Name(pod).SubResource("exec").VersionedParams(&core.PodExecOptions{
		Container: container,
		Command:   []string{"sh", "-c", "bash || sh"},
		Stdin:     true,
		Stdout:    true,
		Stderr:    true,
		TTY:       true,
	}, scheme.ParameterCodec).URL()
	executor, err := kube.NewRemoteCommandExecutor(cfg, u)
	if err != nil {
		cleanup()
		return nil, err
	}
	s, err := m.open(c.Context, connection, "exec")
	if err != nil {
		cleanup()
		return nil, err
	}
	s.setCleanup(cleanup)
	input, writer := io.Pipe()
	s.mu.Lock()
	s.input = writer
	s.mu.Unlock()
	go func() {
		defer input.Close()
		err := executor.StreamWithContext(s.ctx, remotecommand.StreamOptions{
			Stdin: input, Stdout: s, Stderr: s, Tty: true, TerminalSizeQueue: s,
		})
		s.finish(err)
	}()
	return map[string]string{"sessionId": s.id}, nil
}
func (m *Manager) watch(c *kube.Client, connection string, raw json.RawMessage) (any, error) {
	var p struct {
		Group           string `json:"group"`
		Version         string `json:"version"`
		Resource        string `json:"resource"`
		Namespace       string `json:"namespace"`
		Selector        string `json:"selector"`
		FieldSelector   string `json:"fieldSelector"`
		ResourceVersion string `json:"resourceVersion"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if p.Version == "" || p.Resource == "" {
		return nil, fmt.Errorf("version and resource required")
	}
	cfg := rest.CopyConfig(c.Config)
	cfg.Timeout = 0
	client, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	resource := client.Resource(schema.GroupVersionResource{Group: p.Group, Version: p.Version, Resource: p.Resource})
	var api dynamic.ResourceInterface = resource
	if p.Namespace != "" {
		api = resource.Namespace(p.Namespace)
	}
	s, err := m.open(c.Context, connection, "watch")
	if err != nil {
		return nil, err
	}
	go func() {
		var terminalErr error
		defer func() { s.finish(terminalErr) }()
		rv := p.ResourceVersion
		emit := func(t string, object any) {
			b, e := json.Marshal(map[string]any{"type": t, "object": object})
			if e == nil {
				s.Write(append(b, '\n'))
			}
		}
		for s.ctx.Err() == nil {
			if rv == "" {
				list, e := api.List(s.ctx, meta.ListOptions{LabelSelector: p.Selector, FieldSelector: p.FieldSelector})
				if e != nil {
					terminalErr = e
					return
				}
				rv = list.GetResourceVersion()
				emit("RESET", map[string]any{"resourceVersion": rv})
				for i := range list.Items {
					emit("ADDED", &list.Items[i])
				}
			}
			seconds := int64(240)
			w, e := api.Watch(s.ctx, meta.ListOptions{LabelSelector: p.Selector, FieldSelector: p.FieldSelector, ResourceVersion: rv, AllowWatchBookmarks: true, TimeoutSeconds: &seconds})
			if e != nil {
				if apierrors.IsResourceExpired(e) || apierrors.IsGone(e) {
					rv = ""
					continue
				}
				if apierrors.IsForbidden(e) || apierrors.IsUnauthorized(e) {
					terminalErr = e
					return
				}
				select {
				case <-s.ctx.Done():
					return
				case <-time.After(time.Second):
					continue
				}
			}
			running := true
			for running {
				select {
				case <-s.ctx.Done():
					w.Stop()
					return
				case event, ok := <-w.ResultChan():
					if !ok {
						running = false
						break
					}
					if event.Type == kwatch.Error {
						e := apierrors.FromObject(event.Object)
						if apierrors.IsResourceExpired(e) || apierrors.IsGone(e) {
							rv = ""
						} else if apierrors.IsForbidden(e) || apierrors.IsUnauthorized(e) {
							w.Stop()
							terminalErr = e
							return
						}
						running = false
						break
					}
					if obj, e := apimeta.Accessor(event.Object); e == nil {
						rv = obj.GetResourceVersion()
					}
					if event.Type != kwatch.Bookmark {
						emit(string(event.Type), event.Object)
					}
				}
			}
			w.Stop()
			select {
			case <-s.ctx.Done():
				return
			case <-time.After(500 * time.Millisecond):
			}
		}
	}()
	return map[string]string{"sessionId": s.id}, nil
}
