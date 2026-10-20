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
	"log"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	"k8s.io/client-go/tools/portforward"
	"k8s.io/client-go/tools/remotecommand"
)

const bufferLimit = 1024 * 1024
const sessionLimit = 64
const closedSessionGrace = time.Minute

type Result struct {
	SessionID    string                      `json:"sessionId"`
	Data         string                      `json:"data"`
	Closed       bool                        `json:"closed"`
	Error        string                      `json:"error,omitempty"`
	Warning      string                      `json:"warning,omitempty"`
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
	cleanup              func() error
	cleanupOnce          sync.Once
	cleanupPending       bool
	cleanupErr           error
	warning              string
	outputTruncated      bool
}

func (s *session) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(p)
	if s.closed {
		return 0, io.ErrClosedPipe
	}
	if len(s.data)+n > bufferLimit {
		excess := len(s.data) + n - bufferLimit
		s.dropped += excess
		s.outputTruncated = true
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
	s.runCleanup()
}

func (s *session) runCleanup() {
	s.mu.Lock()
	cleanup := s.cleanup
	s.mu.Unlock()
	if cleanup == nil {
		return
	}
	s.cleanupOnce.Do(func() {
		err := cleanup()
		s.mu.Lock()
		s.cleanupErr = err
		if err != nil {
			s.warning = fmt.Sprintf("Temporary terminal resources could not be cleaned up: %v", err)
		}
		s.cleanupPending = false
		s.mu.Unlock()
		if err != nil {
			log.Printf("terminal session %s cleanup failed: %v", s.id, err)
		}
	})
}

func (s *session) read() Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastRead = time.Now()
	if s.outputTruncated {
		// A bounded buffer may start in the middle of a UTF-8 rune. Discard
		// continuation bytes until the next rune boundary, even across reads.
		for len(s.data) > 0 && !utf8.RuneStart(s.data[0]) {
			s.data = s.data[1:]
			s.dropped++
		}
		if len(s.data) > 0 {
			s.outputTruncated = false
		}
	}
	end := 0
	for end < len(s.data) {
		if !utf8.FullRune(s.data[end:]) && !s.closed {
			break
		}
		_, size := utf8.DecodeRune(s.data[end:])
		end += size
	}
	data := strings.ToValidUTF8(string(s.data[:end]), "\uFFFD")
	r := Result{SessionID: s.id, Data: data, Closed: s.closed && !s.cleanupPending, Warning: s.warning, DroppedBytes: s.dropped, Ready: s.ready, Ports: s.ports}
	if !s.cleanupPending {
		r.Error = s.err
	}
	if end == len(s.data) {
		s.data = nil
	} else {
		s.data = append([]byte(nil), s.data[end:]...)
	}
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
				var expired []*session
				m.mu.Lock()
				for id, s := range m.all {
					s.mu.Lock()
					// A naturally completed stream is still retained briefly so the
					// client can read its final frame, but must not keep its buffer
					// (up to bufferLimit) for the full idle-session lifetime.
					idleLimit := 30 * time.Minute
					if s.closed {
						idleLimit = closedSessionGrace
					}
					idle := time.Since(s.lastRead) > idleLimit
					s.mu.Unlock()
					if idle {
						expired = append(expired, s)
						delete(m.all, id)
					}
				}
				m.mu.Unlock()
				for _, s := range expired {
					s.finish(nil)
				}
			}
		}
	}()
	return m
}
func (m *Manager) open(parent context.Context, connection, kind string) (*session, error) {
	return m.openWithCleanup(parent, connection, kind, nil)
}

func (m *Manager) openWithCleanup(parent context.Context, connection, kind string, cleanup func() error) (*session, error) {
	if err := parent.Err(); err != nil {
		return nil, err
	}
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
	s := &session{id: hex.EncodeToString(b), connection: connection, kind: kind, ctx: ctx, cancel: cancel, sizes: make(chan remotecommand.TerminalSize, 1), lastRead: time.Now(), cleanup: cleanup, cleanupPending: cleanup != nil}
	m.all[s.id] = s
	go func() { <-ctx.Done(); s.finish(nil) }()
	return s, nil
}

func (s *session) setCleanup(cleanup func() error) {
	s.mu.Lock()
	closed := s.closed
	s.cleanup = cleanup
	s.cleanupPending = cleanup != nil
	s.mu.Unlock()
	if closed {
		s.runCleanup()
	}
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
		return nil
	}
	m.mu.Unlock()
	s.finish(nil)
	m.mu.Lock()
	if current := m.all[id]; current == s {
		delete(m.all, id)
	}
	m.mu.Unlock()
	s.mu.Lock()
	err := s.cleanupErr
	s.mu.Unlock()
	return err
}

// read drains one frame and releases naturally completed sessions immediately.
// The final frame remains available to the caller, while sessions whose clients
// stop polling are bounded by the janitor's closedSessionGrace timeout.
func (m *Manager) read(connection, id string) (Result, error) {
	s, err := m.get(connection, id)
	if err != nil {
		return Result{}, err
	}
	result := s.read()
	if result.Closed {
		m.mu.Lock()
		if current := m.all[id]; current == s {
			delete(m.all, id)
		}
		m.mu.Unlock()
	}
	return result, nil
}
func (m *Manager) CloseConnection(id string) {
	m.mu.Lock()
	var sessions []*session
	for key, s := range m.all {
		if s.connection == id {
			sessions = append(sessions, s)
			delete(m.all, key)
		}
	}
	m.mu.Unlock()
	for _, s := range sessions {
		s.finish(nil)
	}
}
func (m *Manager) Close() {
	m.cancel()
	m.mu.Lock()
	sessions := make([]*session, 0, len(m.all))
	for id, s := range m.all {
		sessions = append(sessions, s)
		delete(m.all, id)
	}
	m.mu.Unlock()
	for _, s := range sessions {
		s.finish(nil)
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
		return m.exec(ctx, c, connection, raw)
	case "node/exec-open":
		return m.nodeExec(ctx, c, connection, raw)
	case "kubectl/exec-open":
		return m.kubectlExec(ctx, c, connection, raw)
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
	switch method {
	case "pod/logs-close", "pod/exec-close", "resource/watch-close", "port-forward/close", "session/close":
		if p.SessionID == "" {
			return nil, fmt.Errorf("sessionId is required")
		}
		if err := m.remove(connection, p.SessionID); err != nil {
			return nil, fmt.Errorf("Temporary terminal resources could not be cleaned up: %w", err)
		}
		return map[string]bool{"closed": true}, nil
	}
	s, err := m.get(connection, p.SessionID)
	if err != nil {
		return nil, err
	}
	switch method {
	case "pod/logs-read", "pod/exec-read", "resource/watch-read", "session/read":
		return m.read(connection, p.SessionID)
	case "pod/exec-write", "terminal/exec-write":
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
	case "pod/exec-resize", "terminal/exec-resize":
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
