package sessions

import (
	"context"
	"testing"
)

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
