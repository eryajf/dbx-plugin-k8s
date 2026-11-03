package sessions

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
)

func TestDownloadCommandsFollowSymlinkTarget(t *testing.T) {
	stat, err := exec.LookPath("gstat")
	if err != nil {
		stat, err = exec.LookPath("stat")
		if err != nil {
			t.Skip("GNU-compatible stat unavailable")
		}
		if err := exec.Command(stat, "--version").Run(); err != nil {
			t.Skip("GNU-compatible stat unavailable")
		}
	}
	dir := t.TempDir()
	if err := os.Symlink(stat, filepath.Join(dir, "stat")); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "target")
	link := filepath.Join(dir, "link")
	if err := os.WriteFile(target, []byte("target contents"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	run := func(command string) ([]byte, error) {
		cmd := exec.Command("sh", "-c", command)
		cmd.Env = append(os.Environ(), "PATH="+dir+string(os.PathListSeparator)+os.Getenv("PATH"))
		return cmd.CombinedOutput()
	}
	for _, filename := range []string{target, link} {
		metadata, err := run(downloadStatCommand(filename))
		if err != nil || !strings.HasPrefix(string(metadata), "15:") {
			t.Fatalf("stat %s: %s, %v", filename, metadata, err)
		}
		fingerprint := strings.Join(strings.Split(strings.TrimSpace(string(metadata)), ":")[:4], ":")
		result, err := run(downloadReadCommand(filename, fingerprint))
		if err != nil || string(result) != "target contents" {
			t.Fatalf("read %s: %s, %v", filename, result, err)
		}
	}
	metadata, err := run(downloadStatCommand(link))
	if err != nil {
		t.Fatal(err)
	}
	initial := strings.TrimSpace(string(metadata))
	if err := os.WriteFile(target, []byte("changed content"), 0600); err != nil {
		t.Fatal(err)
	}
	final, err := run(downloadStatCommand(link))
	if err != nil {
		t.Fatal(err)
	}
	originalHash := sha256.Sum256([]byte("target contents"))
	if err := verifyDownload(initial, string(final), originalHash[:]); err == nil {
		t.Fatal("same-size rewritten target was accepted")
	}
	if err := os.WriteFile(target, []byte("changed contents with different size"), 0600); err != nil {
		t.Fatal(err)
	}
	fingerprint := strings.Join(strings.Split(strings.TrimSpace(string(metadata)), ":")[:4], ":")
	if _, err := run(downloadReadCommand(link, fingerprint)); err == nil {
		t.Fatal("changed target was accepted")
	}
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	if _, err := run(downloadStatCommand(link)); err == nil {
		t.Fatal("dangling symlink was accepted")
	}
}

func TestDownloadVerificationDetectsSameSizeRewrite(t *testing.T) {
	original := sha256.Sum256([]byte("original"))
	rewritten := sha256.Sum256([]byte("changed!"))
	initial := fmt.Sprintf("8:100:100:7:%x", original)
	changed := fmt.Sprintf("8:100:100:7:%x", rewritten)
	if err := verifyDownload(initial, initial, original[:]); err != nil {
		t.Fatal(err)
	}
	if err := verifyDownload(initial, changed, original[:]); err == nil {
		t.Fatal("changed final content was accepted")
	}
	if err := verifyDownload(initial, initial, rewritten[:]); err == nil {
		t.Fatal("changed streamed content was accepted")
	}
}

func TestManagedDownloadReadAndClose(t *testing.T) {
	m := New()
	defer m.Close()
	s, err := m.open(context.Background(), "connection-a", "download")
	if err != nil {
		t.Fatal(err)
	}
	s.download = &downloadStream{frames: make(chan downloadFrame, 2), ctx: s.ctx}
	s.download.frames <- downloadFrame{Data: "YWJj"}
	s.download.frames <- downloadFrame{Done: true}
	_, cancel := context.WithCancel(context.Background())
	m.downloads["connection-a\x00id"] = &managedDownload{cancel: cancel, sessionID: s.id}
	raw := json.RawMessage(`{"downloadId":"id"}`)
	c := &kube.Client{}
	result, err := m.managedDownload(context.Background(), c, "connection-b", "filesystem/download/read", raw)
	if err == nil {
		t.Fatalf("other connection read returned %v", result)
	}
	result, err = m.managedDownload(context.Background(), c, "connection-a", "filesystem/download/read", raw)
	if err != nil || result.(map[string]any)["dataBase64"] != "YWJj" {
		t.Fatalf("read = %v, %v", result, err)
	}
	result, err = m.managedDownload(context.Background(), c, "connection-a", "filesystem/download/read", raw)
	if err != nil || result.(map[string]any)["done"] != true {
		t.Fatalf("final read = %v, %v", result, err)
	}
	for i := 0; i < 2; i++ {
		if _, err := m.managedDownload(context.Background(), c, "connection-a", "filesystem/download/close", raw); err != nil {
			t.Fatal(err)
		}
	}
}

func TestManagedDownloadCloseCancelsPendingOpen(t *testing.T) {
	m := New()
	defer m.Close()
	ctx, cancel := context.WithCancel(context.Background())
	m.downloads["c\x00id"] = &managedDownload{cancel: cancel}
	_, err := m.managedDownload(context.Background(), &kube.Client{}, "c", "filesystem/download/close", json.RawMessage(`{"downloadId":"id"}`))
	if err != nil || ctx.Err() != context.Canceled {
		t.Fatalf("close: %v; context: %v", err, ctx.Err())
	}
}

func TestManagedDownloadCloseBeforeOpen(t *testing.T) {
	m := New()
	defer m.Close()
	raw := json.RawMessage(`{"downloadId":"id"}`)
	if _, err := m.managedDownload(context.Background(), nil, "c", "filesystem/download/close", raw); err != nil {
		t.Fatal(err)
	}
	if _, err := m.managedDownload(context.Background(), nil, "c", "filesystem/download/open", raw); !errors.Is(err, context.Canceled) {
		t.Fatalf("late open: %v", err)
	}
	if _, err := m.managedDownload(context.Background(), nil, "other", "filesystem/download/open", raw); err == nil || errors.Is(err, context.Canceled) {
		t.Fatalf("different connection was blocked: %v", err)
	}
	if len(m.downloads) != 0 || len(m.all) != 0 {
		t.Fatal("late open created a download session")
	}
	if _, err := m.managedDownload(context.Background(), nil, "c", "filesystem/download/close", raw); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	m.closedDownloads["c\x00id"] = time.Now().Add(-time.Second)
	m.pruneClosedDownloads(time.Now())
	remaining := len(m.closedDownloads)
	m.mu.Unlock()
	if remaining != 0 {
		t.Fatal("expired cancellation marker was not removed")
	}
}
