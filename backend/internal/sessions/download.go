package sessions

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	core "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"
)

const downloadChunkSize = 64 * 1024

// The host's open request expires after 120 seconds. Keep a cancellation
// marker long enough for an already dispatched open to reach the sidecar.
const closedDownloadGrace = 5 * time.Minute

type downloadFrame struct {
	Data  string `json:"data,omitempty"`
	Done  bool   `json:"done"`
	Error string `json:"error,omitempty"`
}
type downloadStream struct {
	frames chan downloadFrame
	ctx    context.Context
}

type managedDownload struct {
	cancel    context.CancelFunc
	sessionID string
}

// Caller holds m.mu.
func (m *Manager) pruneClosedDownloads(now time.Time) {
	for key, expires := range m.closedDownloads {
		if !now.Before(expires) {
			delete(m.closedDownloads, key)
		}
	}
}

// DBX's download host supplies only downloadId and connectionId after open.
func (m *Manager) managedDownload(ctx context.Context, c *kube.Client, connection, method string, raw json.RawMessage) (any, error) {
	var p struct {
		DownloadID string `json:"downloadId"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if p.DownloadID == "" {
		return nil, fmt.Errorf("downloadId is required")
	}
	key := connection + "\x00" + p.DownloadID
	if method == "filesystem/download/open" {
		openCtx, cancel := context.WithCancel(ctx)
		state := &managedDownload{cancel: cancel}
		m.mu.Lock()
		m.pruneClosedDownloads(time.Now())
		if _, closed := m.closedDownloads[key]; closed {
			m.mu.Unlock()
			cancel()
			return nil, context.Canceled
		}
		if _, exists := m.downloads[key]; exists {
			m.mu.Unlock()
			cancel()
			return nil, fmt.Errorf("download already exists")
		}
		m.downloads[key] = state
		m.mu.Unlock()
		result, err := m.downloadOpen(openCtx, c, connection, raw)
		cancel()
		m.mu.Lock()
		active := m.downloads[key] == state
		if err != nil && active {
			delete(m.downloads, key)
		}
		if err == nil && active {
			state.sessionID = result.(map[string]any)["sessionId"].(string)
		}
		m.mu.Unlock()
		if err != nil {
			return nil, err
		}
		if !active {
			_ = m.remove(connection, result.(map[string]any)["sessionId"].(string))
			return nil, context.Canceled
		}
		return map[string]any{"size": result.(map[string]any)["size"]}, nil
	}
	m.mu.Lock()
	state := m.downloads[key]
	if method == "filesystem/download/close" {
		m.pruneClosedDownloads(time.Now())
		m.closedDownloads[key] = time.Now().Add(closedDownloadGrace)
		if state != nil {
			delete(m.downloads, key)
		}
	}
	var sessionID string
	if state != nil {
		sessionID = state.sessionID
	}
	m.mu.Unlock()
	if method == "filesystem/download/close" {
		if state != nil {
			state.cancel()
			if sessionID != "" {
				_ = m.remove(connection, sessionID)
			}
		}
		return map[string]any{}, nil
	}
	if sessionID == "" {
		return nil, fmt.Errorf("download session not found")
	}
	s, err := m.get(connection, sessionID)
	if err != nil {
		return nil, err
	}
	result, err := m.downloadRead(ctx, connection, s)
	if err != nil {
		return nil, err
	}
	frame := result.(downloadFrame)
	if frame.Error != "" {
		return nil, fmt.Errorf("%s", frame.Error)
	}
	return map[string]any{"dataBase64": frame.Data, "done": frame.Done}, nil
}

func (d *downloadStream) Write(p []byte) (int, error) {
	total := len(p)
	for len(p) > 0 {
		n := len(p)
		if n > downloadChunkSize {
			n = downloadChunkSize
		}
		frame := downloadFrame{Data: base64.StdEncoding.EncodeToString(p[:n])}
		select {
		case d.frames <- frame:
		case <-d.ctx.Done():
			return total - len(p), io.ErrClosedPipe
		}
		p = p[n:]
	}
	return total, nil
}
func downloadStatCommand(filename string) string {
	q := shellQuote(filename)
	return fmt.Sprintf("if [ ! -f %s ]; then echo 'file does not exist or is not a regular file' >&2; exit 1; fi; meta=$(stat -Lc '%%s:%%Y:%%Z:%%i' -- %s) || exit 1; digest=$(sha256sum < %s) || exit 1; printf '%%s:%%s\\n' \"$meta\" \"${digest%%%% *}\"", q, q, q)
}

func downloadReadCommand(filename, fingerprint string) string {
	q := shellQuote(filename)
	return fmt.Sprintf(`if [ ! -f %s ]; then echo 'file does not exist or is not a regular file' >&2; exit 1; fi
before=$(stat -Lc '%%s:%%Y:%%Z:%%i' -- %s) || exit 1
if [ "$before" != %s ]; then echo 'file changed before download' >&2; exit 1; fi
cat -- %s || exit 1
after=$(stat -Lc '%%s:%%Y:%%Z:%%i' -- %s) || exit 1
if [ "$before" != "$after" ]; then echo 'file changed during download' >&2; exit 1; fi`, q, q, shellQuote(fingerprint), q, q)
}

func verifyDownload(fingerprint, finalFingerprint string, streamedHash []byte) error {
	parts := strings.Split(fingerprint, ":")
	if len(parts) != 5 || len(parts[4]) != sha256.Size*2 {
		return fmt.Errorf("invalid file checksum metadata")
	}
	if strings.TrimSpace(finalFingerprint) != fingerprint || fmt.Sprintf("%x", streamedHash) != parts[4] {
		return fmt.Errorf("file changed during download")
	}
	return nil
}

func (m *Manager) downloadOpen(ctx context.Context, c *kube.Client, connection string, raw json.RawMessage) (any, error) {
	var p struct{ Namespace, Name, Container, Path string }
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if p.Namespace == "" || p.Name == "" || p.Path == "" {
		return nil, fmt.Errorf("namespace, name and path are required")
	}
	if err := validateFilePath(p.Path, false); err != nil {
		return nil, err
	}
	p.Path = path.Clean(p.Path)
	client, cfg, err := streamCore(c)
	if err != nil {
		return nil, err
	}
	statCmd := downloadStatCommand(p.Path)
	statURL := client.CoreV1().RESTClient().Post().Resource("pods").Namespace(p.Namespace).Name(p.Name).SubResource("exec").VersionedParams(&core.PodExecOptions{Container: p.Container, Command: []string{"sh", "-c", statCmd}, Stdout: true, Stderr: true}, scheme.ParameterCodec).URL()
	statExec, err := remotecommand.NewSPDYExecutor(cfg, "POST", statURL)
	if err != nil {
		return nil, err
	}
	var metadata, statError fileOutput
	if err = statExec.StreamWithContext(ctx, remotecommand.StreamOptions{Stdout: &metadata, Stderr: &statError}); err != nil {
		return nil, fmt.Errorf("container file operation: %w: %s", err, statError.String())
	}
	fingerprint := strings.TrimSpace(metadata.String())
	size, err := strconv.ParseInt(strings.SplitN(fingerprint, ":", 2)[0], 10, 64)
	if err != nil || size < 0 {
		return nil, fmt.Errorf("invalid file metadata")
	}
	parts := strings.Split(fingerprint, ":")
	if len(parts) != 5 || len(parts[4]) != sha256.Size*2 {
		return nil, fmt.Errorf("invalid file checksum metadata")
	}
	metadataFingerprint := strings.Join(parts[:4], ":")
	cmd := downloadReadCommand(p.Path, metadataFingerprint)
	u := client.CoreV1().RESTClient().Post().Resource("pods").Namespace(p.Namespace).Name(p.Name).SubResource("exec").VersionedParams(&core.PodExecOptions{Container: p.Container, Command: []string{"sh", "-c", cmd}, Stdout: true, Stderr: true}, scheme.ParameterCodec).URL()
	ex, err := remotecommand.NewSPDYExecutor(cfg, "POST", u)
	if err != nil {
		return nil, err
	}
	s, err := m.open(c.Context, connection, "download")
	if err != nil {
		return nil, err
	}
	d := &downloadStream{frames: make(chan downloadFrame, 1), ctx: s.ctx}
	s.download = d
	go func() {
		var stderr fileOutput
		hash := sha256.New()
		err := ex.StreamWithContext(s.ctx, remotecommand.StreamOptions{Stdout: io.MultiWriter(d, hash), Stderr: &stderr})
		if err == nil {
			var finalMetadata, finalError fileOutput
			finalExec, execErr := remotecommand.NewSPDYExecutor(cfg, "POST", statURL)
			if execErr == nil {
				execErr = finalExec.StreamWithContext(s.ctx, remotecommand.StreamOptions{Stdout: &finalMetadata, Stderr: &finalError})
			}
			if execErr != nil {
				err = fmt.Errorf("verify downloaded file: %w: %s", execErr, finalError.String())
			} else {
				err = verifyDownload(fingerprint, finalMetadata.String(), hash.Sum(nil))
			}
		}
		frame := downloadFrame{Done: true}
		if err != nil {
			frame.Error = fmt.Sprintf("container file operation: %v: %s", err, stderr.String())
		}
		select {
		case d.frames <- frame:
		case <-s.ctx.Done():
		}
	}()
	return map[string]any{"sessionId": s.id, "size": size}, nil
}
func (m *Manager) downloadRead(ctx context.Context, connection string, s *session) (any, error) {
	if s.kind != "download" || s.download == nil {
		return nil, fmt.Errorf("not a download session")
	}
	select {
	case frame := <-s.download.frames:
		s.mu.Lock()
		s.lastRead = time.Now()
		s.mu.Unlock()
		if frame.Done {
			_ = m.remove(connection, s.id)
		}
		return frame, nil
	case <-s.ctx.Done():
		return nil, fmt.Errorf("download session closed")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
