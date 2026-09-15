package sessions

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	core "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Bound output independently of container tools and filenames.
type fileOutput struct{ bytes.Buffer }

func (b *fileOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 1024*1024 {
		return 0, fmt.Errorf("file output exceeds 1 MiB; choose a narrower directory")
	}
	return b.Buffer.Write(p)
}

var safePath = regexp.MustCompile(`^/[A-Za-z0-9._/-]*$`)

// filesList is deliberately read-only and does not expose arbitrary commands.
func filesList(ctx context.Context, c *kube.Client, raw json.RawMessage) (any, error) {
	var p struct {
		Namespace, Name, Container, Path string
		Depth                            int `json:"depth"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if p.Namespace == "" || p.Name == "" {
		return nil, fmt.Errorf("namespace and name are required")
	}
	if p.Path == "" {
		p.Path = "/"
	}
	if !safePath.MatchString(p.Path) {
		return nil, fmt.Errorf("path must be absolute and contain only safe characters")
	}
	p.Path = path.Clean(p.Path)
	if p.Depth < 1 || p.Depth > 5 {
		p.Depth = 2
	}
	client, cfg, err := streamCore(c)
	if err != nil {
		return nil, err
	}
	u := client.CoreV1().RESTClient().Post().Resource("pods").Namespace(p.Namespace).Name(p.Name).SubResource("exec").VersionedParams(&core.PodExecOptions{Container: p.Container, Command: []string{"sh", "-c", fileListCommand(p.Path, p.Depth)}, Stdout: true, Stderr: true}, scheme.ParameterCodec).URL()
	ex, err := remotecommand.NewSPDYExecutor(cfg, "POST", u)
	if err != nil {
		return nil, err
	}
	var out, stderr fileOutput
	if err = ex.StreamWithContext(ctx, remotecommand.StreamOptions{Stdout: &out, Stderr: &stderr}); err != nil {
		return nil, fmt.Errorf("container file operation: %w: %s", err, stderr.String())
	}
	return parseFileList(p.Path, out.String()), nil
}
func fileListCommand(directory string, depth int) string {
	return fmt.Sprintf(`find %s -maxdepth %d -mindepth 1 -exec sh -c 'for p do
 meta=$(stat -c "%%s	%%Y	%%A	%%u	%%g" -- "$p") || exit 1
 if [ -d "$p" ]; then kind=d; else kind=f; fi
 printf "%%s\t%%s\t%%s\0" "$kind" "$meta" "$p"
 done' sh {} +`, shellQuote(directory), depth)
}
func parseFileList(directory, output string) map[string]any {
	items := make([]map[string]any, 0)
	entries := strings.Split(strings.TrimSuffix(output, "\x00"), "\x00")
	truncated := len(entries) > 500
	for _, entry := range entries {
		if entry == "" || len(items) >= 500 {
			continue
		}
		parts := strings.SplitN(entry, "\t", 7)
		if len(parts) != 7 {
			continue
		}
		epoch, err := strconv.ParseInt(parts[2], 10, 64)
		if err != nil {
			continue
		}
		items = append(items, map[string]any{"type": map[string]string{"d": "directory", "f": "file"}[parts[0]], "path": parts[6], "name": path.Base(parts[6]), "isDir": parts[0] == "d", "size": parts[1], "modTime": time.Unix(epoch, 0).UTC().Format(time.RFC3339), "mode": parts[3], "uid": parts[4], "gid": parts[5]})
	}
	return map[string]any{"path": directory, "items": items, "truncated": truncated}
}
func fileWriteCommand(filename string, overwrite bool) string {
	quoted := shellQuote(filename)
	if overwrite {
		return fmt.Sprintf("if [ -f %s ] && [ ! -L %s ]; then cat > %s; else exit 2; fi", quoted, quoted, quoted)
	}
	return fmt.Sprintf("set -C; cat > %s", quoted)
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'" }

func fileRead(ctx context.Context, c *kube.Client, raw json.RawMessage) (any, error) {
	var p struct{ Namespace, Name, Container, Path string }
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if p.Namespace == "" || p.Name == "" || p.Path == "" {
		return nil, fmt.Errorf("namespace, name and path are required")
	}
	if !safePath.MatchString(p.Path) || path.Clean(p.Path) == "/" {
		return nil, fmt.Errorf("path must be an absolute file path")
	}
	p.Path = path.Clean(p.Path)
	client, cfg, err := streamCore(c)
	if err != nil {
		return nil, err
	}
	u := client.CoreV1().RESTClient().Post().Resource("pods").Namespace(p.Namespace).Name(p.Name).SubResource("exec").VersionedParams(&core.PodExecOptions{Container: p.Container, Command: []string{"sh", "-c", fmt.Sprintf("if [ -f %s ]; then head -c 262145 -- %s; else exit 2; fi", shellQuote(p.Path), shellQuote(p.Path))}, Stdout: true, Stderr: true}, scheme.ParameterCodec).URL()
	ex, err := remotecommand.NewSPDYExecutor(cfg, "POST", u)
	if err != nil {
		return nil, err
	}
	var out, stderr fileOutput
	if err = ex.StreamWithContext(ctx, remotecommand.StreamOptions{Stdout: &out, Stderr: &stderr}); err != nil {
		return nil, fmt.Errorf("container file operation: %w: %s", err, stderr.String())
	}
	content := out.String()
	truncated := len(content) > 262144
	if truncated {
		content = content[:262144]
	}
	return map[string]any{"path": p.Path, "content": content, "truncated": truncated, "editable": !truncated}, nil
}

// fileDelete removes one regular file inside a pod. Directories and root are
// rejected; deletion is permanent and requires explicit confirmation in the UI.
func fileDelete(ctx context.Context, c *kube.Client, raw json.RawMessage) (any, error) {
	var p struct{ Namespace, Name, Container, Path string }
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if p.Namespace == "" || p.Name == "" || p.Path == "" {
		return nil, fmt.Errorf("namespace, name and path are required")
	}
	if !safePath.MatchString(p.Path) || path.Clean(p.Path) == "/" {
		return nil, fmt.Errorf("path must be an absolute file path")
	}
	p.Path = path.Clean(p.Path)
	client, cfg, err := streamCore(c)
	if err != nil {
		return nil, err
	}
	cmd := fmt.Sprintf("if [ -f %s ]; then rm -- %s; else exit 2; fi", shellQuote(p.Path), shellQuote(p.Path))
	u := client.CoreV1().RESTClient().Post().Resource("pods").Namespace(p.Namespace).Name(p.Name).SubResource("exec").VersionedParams(&core.PodExecOptions{Container: p.Container, Command: []string{"sh", "-c", cmd}, Stdout: true, Stderr: true}, scheme.ParameterCodec).URL()
	ex, err := remotecommand.NewSPDYExecutor(cfg, "POST", u)
	if err != nil {
		return nil, err
	}
	var out, stderr fileOutput
	if err = ex.StreamWithContext(ctx, remotecommand.StreamOptions{Stdout: &out, Stderr: &stderr}); err != nil {
		return nil, fmt.Errorf("container file operation: %w: %s", err, stderr.String())
	}
	return map[string]any{"path": p.Path, "deleted": true}, nil
}

func fileWrite(ctx context.Context, c *kube.Client, raw json.RawMessage) (any, error) {
	var p struct {
		Namespace, Name, Container, Path, Content string
		Overwrite                                 bool `json:"overwrite"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if p.Namespace == "" || p.Name == "" || p.Path == "" {
		return nil, fmt.Errorf("namespace, name and path are required")
	}
	if !safePath.MatchString(p.Path) || path.Clean(p.Path) == "/" {
		return nil, fmt.Errorf("path must be an absolute file path")
	}
	if len(p.Content) > 262144 {
		return nil, fmt.Errorf("file content exceeds 256 KiB")
	}
	p.Path = path.Clean(p.Path)
	client, cfg, err := streamCore(c)
	if err != nil {
		return nil, err
	}
	cmd := fileWriteCommand(p.Path, p.Overwrite)
	u := client.CoreV1().RESTClient().Post().Resource("pods").Namespace(p.Namespace).Name(p.Name).SubResource("exec").VersionedParams(&core.PodExecOptions{Container: p.Container, Command: []string{"sh", "-c", cmd}, Stdin: true, Stdout: true, Stderr: true}, scheme.ParameterCodec).URL()
	ex, err := remotecommand.NewSPDYExecutor(cfg, "POST", u)
	if err != nil {
		return nil, err
	}
	var out, stderr fileOutput
	if err = ex.StreamWithContext(ctx, remotecommand.StreamOptions{Stdin: strings.NewReader(p.Content), Stdout: &out, Stderr: &stderr}); err != nil {
		return nil, fmt.Errorf("container file operation: %w: %s", err, stderr.String())
	}
	return map[string]any{"path": p.Path, "written": true, "bytes": len([]byte(p.Content))}, nil
}
