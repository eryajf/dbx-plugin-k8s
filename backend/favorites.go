package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/eryajf/dbx-plugin-k8s/internal/connection"
	dbx "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
)

// Save resource identity only. Never persist resource data, labels or annotations.
type favorite struct {
	Resource struct {
		Group      string   `json:"group"`
		Version    string   `json:"version"`
		Resource   string   `json:"resource"`
		Kind       string   `json:"kind"`
		Namespaced bool     `json:"namespaced"`
		Verbs      []string `json:"verbs"`
	} `json:"resource"`
	Object struct {
		APIVersion string `json:"apiVersion"`
		Kind       string `json:"kind"`
		Metadata   struct {
			Name      string `json:"name"`
			Namespace string `json:"namespace,omitempty"`
		} `json:"metadata"`
	} `json:"object"`
}

func (f favorite) key() string {
	return strings.Join([]string{f.Resource.Group, f.Resource.Version, f.Resource.Resource, f.Object.Metadata.Namespace, f.Object.Metadata.Name}, "/")
}

type favoriteStore struct {
	mu    sync.Mutex
	path  string
	items map[string]map[string]favorite
}

func (p *plugin) handleFavorites(method string, v map[string]any, raw json.RawMessage) (any, *dbx.PluginError) {
	id := connection.ID(v)
	if strings.TrimSpace(id) == "" {
		return nil, dbx.NewError(-32602, "connectionId is required")
	}
	s := &p.favorites
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.items == nil {
		if s.path == "" {
			dir, err := os.UserConfigDir()
			if err != nil {
				return nil, classify(err)
			}
			s.path = filepath.Join(dir, "dbx-plugin-k8s", "favorites.json")
		}
		items := map[string]map[string]favorite{}
		data, err := os.ReadFile(s.path)
		if err == nil {
			if err = json.Unmarshal(data, &items); err != nil {
				return nil, classify(err)
			}
		} else if !os.IsNotExist(err) {
			return nil, classify(err)
		}
		if items == nil {
			items = map[string]map[string]favorite{}
		}
		s.items = items
	}
	if method == "favorite/update" {
		var req struct {
			Item   favorite `json:"item"`
			Remove bool     `json:"remove"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, dbx.NewError(-32602, "invalid favorite parameters")
		}
		f := req.Item
		if f.Resource.Resource == "" || f.Resource.Version == "" || f.Resource.Kind == "" || f.Object.Metadata.Name == "" {
			return nil, dbx.NewError(-32602, "resource version, kind, resource and name are required")
		}
		if f.Resource.Namespaced != (f.Object.Metadata.Namespace != "") {
			return nil, dbx.NewError(-32602, "favorite namespace does not match resource scope")
		}
		// Commit memory only after the atomic disk write succeeds.
		next := make(map[string]map[string]favorite, len(s.items))
		for k, entries := range s.items {
			next[k] = entries
		}
		entries := map[string]favorite{}
		for k, entry := range s.items[id] {
			entries[k] = entry
		}
		if req.Remove {
			delete(entries, f.key())
		} else {
			entries[f.key()] = f
		}
		next[id] = entries
		data, err := json.Marshal(next)
		if err != nil {
			return nil, classify(err)
		}
		if err = os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
			return nil, classify(err)
		}
		file, err := os.CreateTemp(filepath.Dir(s.path), "favorites-*.tmp")
		if err != nil {
			return nil, classify(err)
		}
		defer os.Remove(file.Name())
		_, err = file.Write(data)
		if err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err == nil {
			err = closeErr
		}
		if err == nil {
			err = os.Rename(file.Name(), s.path)
		}
		if err != nil {
			return nil, classify(err)
		}
		s.items = next
	}
	out := make([]favorite, 0, len(s.items[id]))
	for _, f := range s.items[id] {
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].key() < out[j].key() })
	return map[string]any{"items": out}, nil
}
