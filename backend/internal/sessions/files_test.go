package sessions

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestFilesListRejectsUnsafePath(t *testing.T) {
	for _, path := range []string{"relative", "/tmp/$(id)", "/tmp;rm -rf /"} {
		_, err := filesList(context.Background(), nil, json.RawMessage(`{"namespace":"default","name":"pod","path":"`+path+`"}`))
		if err == nil {
			t.Fatalf("path %q was accepted", path)
		}
	}
}
func TestShellQuote(t *testing.T) {
	if got := shellQuote("/tmp/a'b"); got != "'/tmp/a'\\''b'" {
		t.Fatalf("got %q", got)
	}
}

func TestFileReadRejectsDirectoryAndUnsafePath(t *testing.T) {
	for _, path := range []string{"/", "/tmp/a;id", "relative"} {
		_, err := fileRead(context.Background(), nil, json.RawMessage(`{"namespace":"default","name":"pod","path":"`+path+`"}`))
		if err == nil {
			t.Fatalf("path %q was accepted", path)
		}
	}
}

func TestFileWriteRejectsUnsafePathAndOversizeBeforeStreaming(t *testing.T) {
	for _, tt := range []struct{ path, content, want string }{
		{"/", "x", "absolute file path"},
		{"/tmp/a;id", "x", "absolute file path"},
		{"/tmp/a", strings.Repeat("x", 262145), "file content exceeds 256 KiB"},
	} {
		body, err := json.Marshal(map[string]string{"namespace": "default", "name": "pod", "path": tt.path, "content": tt.content})
		if err != nil {
			t.Fatal(err)
		}
		_, err = fileWrite(context.Background(), nil, body)
		if err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Fatalf("got %v; want %s", err, tt.want)
		}
	}
}

func TestFileListPreservesWhitespaceAndNewlines(t *testing.T) {
	result := parseFileList("/tmp", "f\t12\t1700000000\t-rw-r--r--\t1000\t1000\t/tmp/a b\x00d\t4096\t1700000000\tdrwxr-xr-x\t0\t0\t/tmp/a\nb\x00")
	entries := result["items"].([]map[string]any)
	if len(entries) != 2 || entries[1]["path"] != "/tmp/a\nb" {
		t.Fatalf("bad entries: %#v", entries)
	}
}
func TestEmptyFileList(t *testing.T) {
	if len(parseFileList("/tmp", "")["items"].([]map[string]any)) != 0 {
		t.Fatal("empty directory produced entry")
	}
}

func TestFileOutputIsBounded(t *testing.T) {
	var output fileOutput
	if _, err := output.Write(make([]byte, 1024*1024)); err != nil {
		t.Fatal(err)
	}
	if _, err := output.Write([]byte("x")); err == nil {
		t.Fatal("unbounded file output")
	}
	if output.Len() != 1024*1024 {
		t.Fatal("buffer exceeded its limit")
	}
}

func TestFileWriteOverwriteCommands(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "existing")
	if err := os.WriteFile(file, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	run := func(target string, overwrite bool) error {
		cmd := exec.Command("sh", "-c", fileWriteCommand(target, overwrite))
		cmd.Stdin = strings.NewReader("replacement")
		return cmd.Run()
	}
	if err := run(file, false); err == nil {
		t.Fatal("default overwrote existing file")
	}
	if err := run(file, true); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(file)
	if string(data) != "replacement" {
		t.Fatalf("got %q", data)
	}
	if err := run(filepath.Join(dir, "absent"), true); err == nil {
		t.Fatal("overwrite created absent file")
	}
	if err := run(dir, true); err == nil {
		t.Fatal("overwrite allowed directory")
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(file, link); err != nil {
		t.Fatal(err)
	}
	if err := run(link, true); err == nil {
		t.Fatal("overwrite followed symlink")
	}
}
func TestFileListMetadata(t *testing.T) {
	items := parseFileList("/tmp", "f\t17\t1700000000\t-rw-r-----\t12\t34\t/tmp/config\x00")["items"].([]map[string]any)
	if len(items) != 1 || items[0]["size"] != "17" || items[0]["isDir"] != false || items[0]["uid"] != "12" || items[0]["modTime"] != "2023-11-14T22:13:20Z" {
		t.Fatalf("%#v", items)
	}
}
