package sessions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

type terminalExecutorFunc func(context.Context, remotecommand.StreamOptions) error

func (f terminalExecutorFunc) Stream(options remotecommand.StreamOptions) error {
	return f(context.Background(), options)
}

func (f terminalExecutorFunc) StreamWithContext(ctx context.Context, options remotecommand.StreamOptions) error {
	return f(ctx, options)
}

func stubTerminalExecutor(t *testing.T, factory func(*rest.Config, *url.URL) (remotecommand.Executor, error)) {
	t.Helper()
	original := newTerminalExecutor
	newTerminalExecutor = factory
	t.Cleanup(func() { newTerminalExecutor = original })
}

func terminalTestClient() *kube.Client {
	return &kube.Client{Config: &rest.Config{Host: "https://cluster.invalid", Timeout: time.Second}, Context: context.Background()}
}

func awaitTerminal(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("terminal operation did not complete")
		}
		time.Sleep(time.Millisecond)
	}
}

func terminalRPC(t *testing.T, m *Manager, id, method string, params map[string]any) any {
	t.Helper()
	params["sessionId"] = id
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result, err := m.Handle(ctx, nil, "conn", method, raw)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestNodeAttachRequestAndInteractiveStream(t *testing.T) {
	started := make(chan struct{})
	input := make(chan string, 1)
	sizes := make(chan remotecommand.TerminalSize, 1)
	var cleanup atomic.Int32
	stubTerminalExecutor(t, func(cfg *rest.Config, target *url.URL) (remotecommand.Executor, error) {
		if cfg.Timeout != 0 {
			t.Fatal("stream retained unary request timeout")
		}
		if target.Path != "/api/v1/namespaces/ops/pods/node-agent/attach" {
			t.Fatalf("unexpected attach path: %s", target)
		}
		query := target.Query()
		for key, want := range map[string]string{"container": nodeAgentContainer, "stdin": "true", "stdout": "true", "tty": "true"} {
			if query.Get(key) != want {
				t.Fatalf("%s = %q; want %q", key, query.Get(key), want)
			}
		}
		if query.Has("command") || query.Get("stderr") == "true" {
			t.Fatalf("attach must not create a command or separate TTY stderr: %s", target)
		}
		return terminalExecutorFunc(func(ctx context.Context, options remotecommand.StreamOptions) error {
			close(started)
			if !options.Tty || options.Stderr != nil || options.TerminalSizeQueue == nil {
				return errors.New("invalid attach stream options")
			}
			if _, err := io.WriteString(options.Stdout, "host bash ready\n"); err != nil {
				return err
			}
			data := make([]byte, 64)
			n, err := options.Stdin.Read(data)
			if err != nil {
				return err
			}
			input <- string(data[:n])
			size := options.TerminalSizeQueue.Next()
			if size == nil {
				return errors.New("size queue closed before resize")
			}
			sizes <- *size
			<-ctx.Done()
			return ctx.Err()
		}), nil
	})
	m := New()
	defer m.Close()
	openCtx, cancel := context.WithCancel(context.Background())
	opened, err := m.openAgentAttach(openCtx, terminalTestClient(), "conn", "ops", "node-agent", nodeAgentContainer, func() error { cleanup.Add(1); return nil })
	if err != nil {
		t.Fatal(err)
	}
	id := opened.(map[string]string)["sessionId"]
	s, err := m.get("conn", id)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("stream not started")
	}
	if s.ctx.Err() != nil {
		t.Fatal("stream inherited opening RPC cancellation")
	}
	result := terminalRPC(t, m, id, "terminal/exec-write", map[string]any{"data": "printf test\r"})
	if result.(map[string]int)["written"] != len("printf test\r") {
		t.Fatalf("unexpected write result: %v", result)
	}
	terminalRPC(t, m, id, "terminal/exec-resize", map[string]any{"cols": 120, "rows": 40})
	select {
	case got := <-input:
		if got != "printf test\r" {
			t.Fatalf("unexpected terminal input: %q", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("input not forwarded")
	}
	select {
	case got := <-sizes:
		if got.Width != 120 || got.Height != 40 {
			t.Fatalf("unexpected resize: %+v", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("resize not forwarded")
	}
	frame := terminalRPC(t, m, id, "session/read", map[string]any{}).(Result)
	if frame.Data != "host bash ready\n" {
		t.Fatalf("unexpected output: %+v", frame)
	}
	terminalRPC(t, m, id, "session/close", map[string]any{})
	awaitTerminal(t, func() bool { return cleanup.Load() == 1 })
	s.finish(nil)
	if cleanup.Load() != 1 {
		t.Fatal("cleanup executed more than once")
	}
}

func TestOtherTerminalsStillUseExec(t *testing.T) {
	for _, kind := range []string{"pod", "kubectl"} {
		t.Run(kind, func(t *testing.T) {
			stubTerminalExecutor(t, func(_ *rest.Config, target *url.URL) (remotecommand.Executor, error) {
				if !strings.HasSuffix(target.Path, "/exec") || strings.HasSuffix(target.Path, "/attach") {
					t.Fatalf("%s terminal changed to attach: %s", kind, target)
				}
				if got := strings.Join(target.Query()["command"], " "); got != "sh -c bash || sh" {
					t.Fatalf("exec command changed: %q", got)
				}
				return terminalExecutorFunc(func(ctx context.Context, _ remotecommand.StreamOptions) error {
					<-ctx.Done()
					return ctx.Err()
				}), nil
			})
			m := New()
			defer m.Close()
			var err error
			if kind == "kubectl" {
				_, err = m.openAgentExec(context.Background(), terminalTestClient(), "conn", "ops", "kubectl-agent", kubectlAgentContainer, func() error { return nil })
			} else {
				_, err = m.exec(context.Background(), terminalTestClient(), "conn", json.RawMessage(`{"namespace":"ops","name":"pod","container":"app","command":["sh","-c","bash || sh"],"tty":true}`))
			}
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestNodeAttachSessionsAreIndependent(t *testing.T) {
	stubTerminalExecutor(t, func(_ *rest.Config, _ *url.URL) (remotecommand.Executor, error) {
		return terminalExecutorFunc(func(ctx context.Context, _ remotecommand.StreamOptions) error {
			<-ctx.Done()
			return ctx.Err()
		}), nil
	})
	m := New()
	defer m.Close()
	var cleanup [2]atomic.Int32
	var sessions [2]*session
	for i := range sessions {
		opened, err := m.openAgentAttach(context.Background(), terminalTestClient(), "conn", "ops", fmt.Sprintf("agent-%d", i), nodeAgentContainer, func() error { cleanup[i].Add(1); return nil })
		if err != nil {
			t.Fatal(err)
		}
		sessions[i], err = m.get("conn", opened.(map[string]string)["sessionId"])
		if err != nil {
			t.Fatal(err)
		}
	}
	if sessions[0].id == sessions[1].id {
		t.Fatal("node terminal sessions share an ID")
	}
	terminalRPC(t, m, sessions[0].id, "session/close", map[string]any{})
	if cleanup[0].Load() != 1 || cleanup[1].Load() != 0 || sessions[1].ctx.Err() != nil {
		t.Fatal("closing one node terminal affected another")
	}
	m.CloseConnection("conn")
	if cleanup[1].Load() != 1 {
		t.Fatal("closing connection did not clean up remaining terminal")
	}
}

func TestAgentInitializationFailureCleansUp(t *testing.T) {
	for _, attach := range []bool{true, false} {
		for _, stage := range []string{"client", "executor", "session"} {
			t.Run(fmt.Sprintf("attach=%t/%s", attach, stage), func(t *testing.T) {
				stubTerminalExecutor(t, func(_ *rest.Config, _ *url.URL) (remotecommand.Executor, error) {
					if stage == "executor" {
						return nil, errors.New("executor unavailable")
					}
					return terminalExecutorFunc(func(context.Context, remotecommand.StreamOptions) error { return nil }), nil
				})
				client := terminalTestClient()
				m := New()
				defer m.Close()
				if stage == "client" {
					client.Config.Host = "://invalid"
				}
				if stage == "session" {
					m.Close()
				}
				var cleanup atomic.Int32
				open := m.openAgentExec
				if attach {
					open = m.openAgentAttach
				}
				_, err := open(context.Background(), client, "conn", "ops", "agent", "app", func() error { cleanup.Add(1); return nil })
				if err == nil || cleanup.Load() != 1 {
					t.Fatalf("error=%v cleanup=%d", err, cleanup.Load())
				}
			})
		}
	}
}

func TestAgentOpenPreservesInitializationAndCleanupErrors(t *testing.T) {
	factoryErr, cleanupErr := errors.New("executor unavailable"), errors.New("delete pod forbidden")
	stubTerminalExecutor(t, func(_ *rest.Config, _ *url.URL) (remotecommand.Executor, error) {
		return nil, factoryErr
	})
	m := New()
	defer m.Close()
	for _, open := range []func(context.Context, *kube.Client, string, string, string, string, func() error) (any, error){m.openAgentExec, m.openAgentAttach} {
		_, err := open(context.Background(), terminalTestClient(), "conn", "ops", "agent", "app", func() error { return cleanupErr })
		if !errors.Is(err, factoryErr) || !errors.Is(err, cleanupErr) {
			t.Fatalf("initialization or cleanup error lost: %v", err)
		}
	}
}

func TestNodeAttachInputCancellationCleansUp(t *testing.T) {
	var cleanup atomic.Int32
	stubTerminalExecutor(t, func(_ *rest.Config, _ *url.URL) (remotecommand.Executor, error) {
		return terminalExecutorFunc(func(ctx context.Context, _ remotecommand.StreamOptions) error {
			<-ctx.Done()
			return ctx.Err()
		}), nil
	})
	m := New()
	defer m.Close()
	opened, err := m.openAgentAttach(context.Background(), terminalTestClient(), "conn", "ops", "agent", nodeAgentContainer, func() error { cleanup.Add(1); return nil })
	if err != nil {
		t.Fatal(err)
	}
	id := opened.(map[string]string)["sessionId"]
	raw, err := json.Marshal(map[string]string{"sessionId": id, "data": "blocked input"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = m.Handle(ctx, nil, "conn", "terminal/exec-write", raw)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("input cancellation error: %v", err)
	}
	awaitTerminal(t, func() bool { return cleanup.Load() == 1 })
}

func TestNodeAttachTerminationAndCleanup(t *testing.T) {
	for _, cause := range []string{"exit", "forbidden", "disconnect", "manager-close"} {
		t.Run(cause, func(t *testing.T) {
			var cleanup atomic.Int32
			stubTerminalExecutor(t, func(_ *rest.Config, _ *url.URL) (remotecommand.Executor, error) {
				return terminalExecutorFunc(func(ctx context.Context, options remotecommand.StreamOptions) error {
					if cause == "forbidden" {
						return errors.New("pods/attach forbidden")
					}
					if cause == "exit" {
						_, err := io.WriteString(options.Stdout, "logout\n")
						return err
					}
					<-ctx.Done()
					return ctx.Err()
				}), nil
			})
			m := New()
			defer m.Close()
			client := terminalTestClient()
			connectionCtx, disconnect := context.WithCancel(context.Background())
			defer disconnect()
			client.Context = connectionCtx
			opened, err := m.openAgentAttach(context.Background(), client, "conn", "ops", "agent", nodeAgentContainer, func() error { cleanup.Add(1); return nil })
			if err != nil {
				t.Fatal(err)
			}
			id := opened.(map[string]string)["sessionId"]
			s, err := m.get("conn", id)
			if err != nil {
				t.Fatal(err)
			}
			if cause == "disconnect" {
				disconnect()
			} else if cause == "manager-close" {
				m.Close()
			}
			awaitTerminal(t, func() bool { return cleanup.Load() == 1 })
			frame := s.read()
			if !frame.Closed {
				t.Fatal("finished stream not marked closed")
			}
			if cause == "forbidden" && !strings.Contains(frame.Error, "pods/attach forbidden") {
				t.Fatalf("attach error lost: %+v", frame)
			}
			if cause == "exit" && (frame.Data != "logout\n" || frame.Error != "") {
				t.Fatalf("final output lost: %+v", frame)
			}
			s.finish(nil)
			if cleanup.Load() != 1 {
				t.Fatal("cleanup ran twice")
			}
		})
	}
}
