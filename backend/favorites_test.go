package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestFavoritePersistenceAndIsolation(t *testing.T) {
	p := testPlugin(t)
	item := `{"resource":{"group":"","version":"v1","resource":"secrets","kind":"Secret","namespaced":true,"verbs":["get","list"]},"object":{"kind":"Secret","metadata":{"name":"web","namespace":"default","annotations":{"token":"must-not-persist"}},"data":{"password":"must-not-persist"}}}`
	update := func(connection string, remove bool) {
		t.Helper()
		body := `{"connectionId":"` + connection + `","item":` + item + `,"remove":` + map[bool]string{true: "true", false: "false"}[remove] + `}`
		if _, err := call(p, "favorite/update", body); err != nil {
			t.Fatal(err)
		}
	}
	count := func(p *plugin, connection string) int {
		t.Helper()
		out, err := call(p, "favorite/list", `{"connectionId":"`+connection+`"}`)
		if err != nil {
			t.Fatal(err)
		}
		return len(out.(map[string]any)["items"].([]favorite))
	}
	update("a", false)
	update("a", false)
	if count(p, "a") != 1 || count(p, "b") != 0 {
		t.Fatal("deduplication or connection isolation failed")
	}
	update("b", false)
	update("a", true)
	if count(p, "a") != 0 || count(p, "b") != 1 {
		t.Fatal("deletion crossed connection boundary")
	}
	restarted := testPlugin(t)
	restarted.favorites.path = p.favorites.path
	if count(restarted, "b") != 1 {
		t.Fatal("favorite not restored after restart")
	}
	data, err := os.ReadFile(p.favorites.path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "must-not-persist") {
		t.Fatal("resource secret data persisted")
	}
	var parsed map[string]any
	if err = json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{`{}`, `{"connectionId":"a"}`, `{"connectionId":"a","item":{"resource":"pods"}}`} {
		if _, err := call(p, "favorite/update", body); err == nil || err.Code != -32602 {
			t.Fatalf("accepted invalid favorite %s: %v", body, err)
		}
	}
}
