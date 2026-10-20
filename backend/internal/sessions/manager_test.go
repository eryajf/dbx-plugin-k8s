package sessions

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"unicode/utf8"
)

func TestSessionReadPreservesUTF8AcrossFrames(t *testing.T) {
	m := New()
	defer m.Close()
	s, err := m.open(context.Background(), "conn", "exec")
	if err != nil {
		t.Fatal(err)
	}
	want := "中文🙂\x1b[32m终端\x1b[0m\r\n"
	var got strings.Builder
	for _, b := range []byte(want) {
		if _, err := s.Write([]byte{b}); err != nil {
			t.Fatal(err)
		}
		frame := s.read()
		if !utf8.ValidString(frame.Data) {
			t.Fatalf("invalid UTF-8 frame: %q", frame.Data)
		}
		encoded, err := json.Marshal(frame)
		if err != nil {
			t.Fatal(err)
		}
		var decoded Result
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			t.Fatal(err)
		}
		got.WriteString(decoded.Data)
		if len(s.data) >= utf8.UTFMax {
			t.Fatal("retained more than one incomplete UTF-8 rune")
		}
	}
	if got.String() != want {
		t.Fatalf("output corrupted: got %q want %q", got.String(), want)
	}
}

func TestSessionFinalIncompleteUTF8IsFlushed(t *testing.T) {
	m := New()
	defer m.Close()
	s, err := m.open(context.Background(), "conn", "exec")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = s.Write([]byte{0xe4, 0xb8})
	if frame := s.read(); frame.Data != "" || frame.Closed {
		t.Fatalf("partial rune was sent early: %+v", frame)
	}
	s.finish(nil)
	frame, err := m.read("conn", s.id)
	if err != nil {
		t.Fatal(err)
	}
	if frame.Data != "\uFFFD" || !frame.Closed {
		t.Fatalf("invalid final fragment not flushed: %+v", frame)
	}
	if _, err := m.get("conn", s.id); err == nil {
		t.Fatal("session retained after final incomplete output")
	}
}

func TestSessionOutputTruncationPreservesRuneBoundary(t *testing.T) {
	for _, oversizedWrite := range []bool{false, true} {
		t.Run(map[bool]string{false: "buffered", true: "single large write"}[oversizedWrite], func(t *testing.T) {
			m := New()
			defer m.Close()
			s, err := m.open(context.Background(), "conn", "exec")
			if err != nil {
				t.Fatal(err)
			}
			payload := "中" + strings.Repeat("x", bufferLimit-2)
			if oversizedWrite {
				_, _ = s.Write([]byte(payload))
			} else {
				_, _ = s.Write([]byte("中"))
				_, _ = s.Write([]byte(payload[3:]))
			}
			if len(s.data) > bufferLimit {
				t.Fatal("buffer exceeded limit")
			}
			frame := s.read()
			if frame.Closed || frame.DroppedBytes != 3 || frame.Data != strings.Repeat("x", bufferLimit-2) {
				t.Fatalf("bad truncation: dropped=%d len=%d closed=%t", frame.DroppedBytes, len(frame.Data), frame.Closed)
			}
			_, _ = s.Write([]byte("下一帧🙂"))
			if frame := s.read(); frame.Data != "下一帧🙂" || frame.DroppedBytes != 0 {
				t.Fatalf("output did not recover after truncation: %+v", frame)
			}
		})
	}
}

func TestSessionCleanupWarningWaitsForCompletion(t *testing.T) {
	m := New()
	defer m.Close()
	started, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	s, err := m.openWithCleanup(context.Background(), "conn", "exec", func() error {
		calls.Add(1)
		close(started)
		<-release
		return errors.New("delete pod forbidden")
	})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = s.Write([]byte("logout\n"))
	go func() { s.finish(nil); close(done) }()
	<-started
	frame, err := m.read("conn", s.id)
	if err != nil || frame.Closed || frame.Data != "logout\n" {
		t.Fatalf("premature final frame: %+v err=%v", frame, err)
	}
	close(release)
	<-done
	frame, err = m.read("conn", s.id)
	if err != nil || !frame.Closed || !strings.Contains(frame.Warning, "delete pod forbidden") {
		t.Fatalf("cleanup failure not visible in final frame: %+v err=%v", frame, err)
	}
	s.finish(nil)
	if calls.Load() != 1 {
		t.Fatal("cleanup ran more than once")
	}
}

func TestSessionCloseReturnsCleanupFailure(t *testing.T) {
	m := New()
	defer m.Close()
	cleanupErr := errors.New("delete pod failed after retries")
	s, err := m.openWithCleanup(context.Background(), "conn", "exec", func() error { return cleanupErr })
	if err != nil {
		t.Fatal(err)
	}
	if err := m.remove("conn", s.id); !errors.Is(err, cleanupErr) {
		t.Fatalf("close swallowed cleanup error: %v", err)
	}
}

func TestSessionCloseIsIdempotentAndConnectionScoped(t *testing.T) {
	for _, method := range []string{"session/close", "pod/logs-close", "pod/exec-close", "resource/watch-close", "port-forward/close"} {
		t.Run(method, func(t *testing.T) {
			m := New()
			defer m.Close()
			var calls atomic.Int32
			s, err := m.openWithCleanup(context.Background(), "owner", "exec", func() error { calls.Add(1); return nil })
			if err != nil {
				t.Fatal(err)
			}
			params, _ := json.Marshal(map[string]string{"sessionId": s.id})
			closeAs := func(connection string) {
				t.Helper()
				result, err := m.Handle(context.Background(), nil, connection, method, params)
				if err != nil || result.(map[string]bool)["closed"] != true {
					t.Fatalf("close failed: result=%v err=%v", result, err)
				}
			}
			closeAs("other")
			if calls.Load() != 0 {
				t.Fatal("cross-connection close touched the session")
			}
			if _, err := m.get("owner", s.id); err != nil {
				t.Fatal("cross-connection close removed the session")
			}
			closeAs("owner")
			closeAs("owner")
			if calls.Load() != 1 {
				t.Fatalf("cleanup calls=%d", calls.Load())
			}
			if _, err := m.Handle(context.Background(), nil, "owner", method, json.RawMessage(`{}`)); err == nil {
				t.Fatal("empty sessionId accepted")
			}
		})
	}
}

func TestSessionCloseAndReadUseSameCleanupWarning(t *testing.T) {
	m := New()
	defer m.Close()
	cleanupErr := errors.New("delete pod forbidden")
	s, err := m.openWithCleanup(context.Background(), "conn", "exec", func() error { return cleanupErr })
	if err != nil {
		t.Fatal(err)
	}
	params, _ := json.Marshal(map[string]string{"sessionId": s.id})
	_, closeErr := m.Handle(context.Background(), nil, "conn", "session/close", params)
	if !errors.Is(closeErr, cleanupErr) {
		t.Fatalf("close lost original cleanup cause: %v", closeErr)
	}
	frame := s.read()
	if !frame.Closed || frame.Warning != closeErr.Error() {
		t.Fatalf("inconsistent cleanup messages: close=%v frame=%+v", closeErr, frame)
	}
}

func TestSessionCloseAfterFinalRead(t *testing.T) {
	m := New()
	defer m.Close()
	s, err := m.openWithCleanup(context.Background(), "conn", "exec", func() error { return errors.New("cleanup failed") })
	if err != nil {
		t.Fatal(err)
	}
	s.finish(nil)
	frame, err := m.read("conn", s.id)
	if err != nil || !frame.Closed || frame.Warning == "" {
		t.Fatalf("final frame lost cleanup result: %+v err=%v", frame, err)
	}
	params, _ := json.Marshal(map[string]string{"sessionId": s.id})
	if _, err := m.Handle(context.Background(), nil, "conn", "session/close", params); err != nil {
		t.Fatalf("close after final read produced false failure: %v", err)
	}
}

func TestConcurrentSessionClosePreservesCleanupFailure(t *testing.T) {
	m := New()
	defer m.Close()
	started, release := make(chan struct{}), make(chan struct{})
	cleanupErr := errors.New("cleanup failed")
	var calls atomic.Int32
	s, err := m.openWithCleanup(context.Background(), "conn", "exec", func() error {
		calls.Add(1)
		close(started)
		<-release
		return cleanupErr
	})
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	go func() { results <- m.remove("conn", s.id) }()
	<-started
	m.mu.Lock()
	registered := m.all[s.id] == s
	m.mu.Unlock()
	if !registered {
		close(release)
		t.Fatal("session removed before cleanup completed")
	}
	go func() { results <- m.remove("conn", s.id) }()
	close(release)
	first, second := <-results, <-results
	if !errors.Is(first, cleanupErr) && !errors.Is(second, cleanupErr) {
		t.Fatalf("both closes swallowed cleanup error: %v, %v", first, second)
	}
	for _, err := range []error{first, second} {
		if err != nil && !errors.Is(err, cleanupErr) {
			t.Fatalf("unexpected close error: %v", err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("cleanup calls=%d", calls.Load())
	}
}

func TestReadReleasesNaturallyClosedSession(t *testing.T) {
	m := New()
	defer m.Close()

	s, err := m.open(context.Background(), "conn", "watch")
	if err != nil {
		t.Fatal(err)
	}
	s.Write([]byte("final"))
	s.finish(nil)

	result, err := m.read("conn", s.id)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Closed || result.Data != "final" {
		t.Fatalf("unexpected final frame: %+v", result)
	}
	if _, err := m.get("conn", s.id); err == nil {
		t.Fatal("closed session remained registered after final frame was read")
	}
}
