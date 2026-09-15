// Package sessions owns connection-scoped Kubernetes streams. Polling drains a
// bounded buffer; closing a connection cancels every stream it created.
package sessions

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	"k8s.io/client-go/tools/portforward"
	"k8s.io/client-go/tools/remotecommand"
)

const bufferLimit = 1024 * 1024
const sessionLimit = 64

type Result struct {
	SessionID    string                      `json:"sessionId"`
	Data         string                      `json:"data"`
	Closed       bool                        `json:"closed"`
	Error        string                      `json:"error,omitempty"`
	DroppedBytes int                         `json:"droppedBytes"`
	Ready        bool                        `json:"ready"`
	Ports        []portforward.ForwardedPort `json:"ports,omitempty"`
}
type session struct {
	mu                   sync.Mutex
	id, connection, kind string
	ctx                  context.Context
	cancel               context.CancelFunc
	data                 []byte
	dropped              int
	closed               bool
	err                  string
	input                *io.PipeWriter
	sizes                chan remotecommand.TerminalSize
	ready                bool
	ports                []portforward.ForwardedPort
	lastRead             time.Time
}

func (s *session) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(p)
	if len(s.data)+n > bufferLimit {
		excess := len(s.data) + n - bufferLimit
		s.dropped += excess
		if excess >= len(s.data) {
			p = p[excess-len(s.data):]
			s.data = nil
		} else {
			s.data = s.data[excess:]
		}
	}
	s.data = append(s.data, p...)
	return n, nil
}
func (s *session) finish(err error) {
	s.mu.Lock()
	s.closed = true
	if err != nil && s.ctx.Err() == nil {
		s.err = err.Error()
	}
	input := s.input
	s.mu.Unlock()
	s.cancel()
	if input != nil {
		input.Close()
	}
}
func (s *session) read() Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastRead = time.Now()
	r := Result{SessionID: s.id, Data: string(s.data), Closed: s.closed, Error: s.err, DroppedBytes: s.dropped, Ready: s.ready, Ports: s.ports}
	s.data = nil
	s.dropped = 0
	return r
}
func (s *session) Next() *remotecommand.TerminalSize {
	select {
	case size := <-s.sizes:
		return &size
	case <-s.ctx.Done():
		return nil
	}
}

type Manager struct {
	mu     sync.Mutex
	all    map[string]*session
	ctx    context.Context
	cancel context.CancelFunc
}

func New() *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{all: make(map[string]*session), ctx: ctx, cancel: cancel}
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				m.mu.Lock()
				for id, s := range m.all {
					s.mu.Lock()
					idle := time.Since(s.lastRead) > 30*time.Minute
					s.mu.Unlock()
					if idle {
						s.finish(nil)
						delete(m.all, id)
					}
				}
				m.mu.Unlock()
			}
		}
	}()
	return m
}
func (m *Manager) open(parent context.Context, connection, kind string) (*session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ctx.Err() != nil {
		return nil, fmt.Errorf("session manager closed")
	}
	if len(m.all) >= sessionLimit {
		return nil, fmt.Errorf("session limit reached; close unused sessions")
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	s := &session{id: hex.EncodeToString(b), connection: connection, kind: kind, ctx: ctx, cancel: cancel, sizes: make(chan remotecommand.TerminalSize, 1), lastRead: time.Now()}
	m.all[s.id] = s
	go func() { <-ctx.Done(); s.finish(nil) }()
	return s, nil
}
func (m *Manager) get(connection, id string) (*session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.all[id]
	if s == nil || s.connection != connection {
		return nil, fmt.Errorf("session not found")
	}
	return s, nil
}
func (m *Manager) remove(connection, id string) error {
	m.mu.Lock()
	s := m.all[id]
	if s == nil || s.connection != connection {
		m.mu.Unlock()
		return fmt.Errorf("session not found")
	}
	delete(m.all, id)
	m.mu.Unlock()
	s.finish(nil)
	return nil
}
func (m *Manager) CloseConnection(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, s := range m.all {
		if s.connection == id {
			s.finish(nil)
			delete(m.all, key)
		}
	}
}
func (m *Manager) Close() {
	m.cancel()
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, s := range m.all {
		s.finish(nil)
		delete(m.all, id)
	}
}

func (m *Manager) Handle(ctx context.Context, c *kube.Client, connection, method string, raw json.RawMessage) (any, error) {
	switch method {
	case "pod/file-write":
		return fileWrite(ctx, c, raw)
	case "pod/file-delete":
		return fileDelete(ctx, c, raw)
	case "pod/file-read":
		return fileRead(ctx, c, raw)
	case "pod/files-list":
		return filesList(ctx, c, raw)
	case "pod/logs-open":
		return m.logs(ctx, c, connection, raw)
	case "pod/exec-open":
		return m.exec(c, connection, raw)
	case "resource/watch":
		return m.watch(c, connection, raw)
	case "port-forward/open":
		return m.forward(ctx, c, connection, raw)
	case "port-forward/list":
		m.mu.Lock()
		defer m.mu.Unlock()
		out := []Result{}
		for _, s := range m.all {
			if s.connection == connection && s.kind == "port-forward" {
				s.mu.Lock()
				out = append(out, Result{SessionID: s.id, Closed: s.closed, Error: s.err, Ready: s.ready, Ports: s.ports})
				s.mu.Unlock()
			}
		}
		return out, nil
	}
	var p struct {
		SessionID string `json:"sessionId"`
		Data      string `json:"data"`
		Cols      uint16 `json:"cols"`
		Rows      uint16 `json:"rows"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	s, err := m.get(connection, p.SessionID)
	if err != nil {
		return nil, err
	}
	switch method {
	case "pod/logs-read", "pod/exec-read", "resource/watch-read", "session/read":
		return s.read(), nil
	case "pod/logs-close", "pod/exec-close", "resource/watch-close", "port-forward/close", "session/close":
		return map[string]bool{"closed": true}, m.remove(connection, p.SessionID)
	case "pod/exec-write":
		if s.kind != "exec" {
			return nil, fmt.Errorf("not an exec session")
		}
		if len(p.Data) > 64*1024 {
			return nil, fmt.Errorf("input exceeds 64 KiB")
		}
		s.mu.Lock()
		input := s.input
		closed := s.closed
		s.mu.Unlock()
		if closed || input == nil {
			return nil, fmt.Errorf("exec session closed")
		}
		type written struct {
			n   int
			err error
		}
		done := make(chan written, 1)
		go func() { n, e := io.WriteString(input, p.Data); done <- written{n, e} }()
		select {
		case r := <-done:
			return map[string]int{"written": r.n}, r.err
		case <-ctx.Done():
			s.finish(nil)
			return nil, ctx.Err()
		case <-time.After(5 * time.Second):
			s.finish(nil)
			return nil, fmt.Errorf("terminal input timed out")
		}
	case "pod/exec-resize":
		if s.kind != "exec" || p.Cols == 0 || p.Rows == 0 {
			return nil, fmt.Errorf("invalid terminal size or session")
		}
		select {
		case <-s.sizes:
		default:
		}
		select {
		case s.sizes <- remotecommand.TerminalSize{Width: p.Cols, Height: p.Rows}:
		default:
		}
		return map[string]bool{"ok": true}, nil
	default:
		return nil, fmt.Errorf("unsupported session method %s", strings.TrimSpace(method))
	}
}
