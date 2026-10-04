package kube

// The search index is an in-memory acceleration structure. This file stores a
// bounded, metadata-only snapshot so reconnecting a large cluster can serve
// useful search results immediately while Kubernetes validates the snapshot.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

const (
	searchIndexSnapshotVersion = 1
	searchIndexSnapshotMaxAge  = 24 * time.Hour
	searchIndexSnapshotMaxSize = 256 << 20
)

type searchIndexStore struct {
	path string
	key  string
}

type persistedSearchIndex struct {
	Version          int                              `json:"version"`
	Key              string                           `json:"key"`
	SavedAt          time.Time                        `json:"savedAt"`
	Generation       uint64                           `json:"generation"`
	Catalog          []persistedSearchResource        `json:"catalog"`
	Entries          []persistedSearchEntry           `json:"entries"`
	ResourceVersions []persistedSearchResourceVersion `json:"resourceVersions,omitempty"`
}

type persistedSearchResource struct {
	Group      string   `json:"group"`
	Version    string   `json:"version"`
	Resource   string   `json:"resource"`
	Kind       string   `json:"kind"`
	Namespaced bool     `json:"namespaced"`
	Verbs      []string `json:"verbs"`
	Preferred  bool     `json:"preferred"`
}

type persistedSearchEntry struct {
	ID        string            `json:"id"`
	UID       string            `json:"uid,omitempty"`
	Group     string            `json:"group"`
	Version   string            `json:"version"`
	Resource  string            `json:"resource"`
	Kind      string            `json:"kind"`
	Namespace string            `json:"namespace,omitempty"`
	Name      string            `json:"name"`
	Labels    map[string]string `json:"labels,omitempty"`
	CreatedAt string            `json:"createdAt,omitempty"`
	Preferred bool              `json:"preferred"`
}

type persistedSearchResourceVersion struct {
	Group           string `json:"group"`
	Version         string `json:"version"`
	Resource        string `json:"resource"`
	Namespace       string `json:"namespace,omitempty"`
	ResourceVersion string `json:"resourceVersion"`
}

func newSearchIndexStore(key string) *searchIndexStore {
	if key == "" {
		return nil
	}
	directory, err := os.UserCacheDir()
	if err != nil || directory == "" {
		return nil
	}
	digest := sha256.Sum256([]byte("dbx-plugin-k8s/search-index/v1\x00" + key))
	name := hex.EncodeToString(digest[:])
	return &searchIndexStore{
		path: filepath.Join(directory, "dbx-plugin-k8s", "search-index", name+".json"),
		key:  name,
	}
}

func (s *SearchIndex) setPersistenceStore(store *searchIndexStore) {
	s.mu.Lock()
	s.store = store
	s.mu.Unlock()
}

func (s *SearchIndex) restorePersistedSnapshot() (bool, error) {
	s.mu.RLock()
	store := s.store
	closed := s.closed
	s.mu.RUnlock()
	if store == nil || closed {
		return false, nil
	}
	stat, err := os.Stat(store.path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	if stat.Size() <= 0 || stat.Size() > searchIndexSnapshotMaxSize {
		return false, fmt.Errorf("search index snapshot size is invalid: %d", stat.Size())
	}
	data, err := os.ReadFile(store.path)
	if err != nil {
		return false, err
	}
	var snapshot persistedSearchIndex
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return false, err
	}
	if snapshot.Version != searchIndexSnapshotVersion || snapshot.Key != store.key {
		return false, nil
	}
	if snapshot.SavedAt.IsZero() || time.Since(snapshot.SavedAt) < 0 || time.Since(snapshot.SavedAt) > searchIndexSnapshotMaxAge {
		return false, nil
	}

	catalog := make(map[schema.GroupVersionResource]SearchResource, len(snapshot.Catalog))
	for _, resource := range snapshot.Catalog {
		if resource.Version == "" || resource.Resource == "" {
			continue
		}
		gvr := schema.GroupVersionResource{Group: resource.Group, Version: resource.Version, Resource: resource.Resource}
		catalog[gvr] = SearchResource{
			Group: resource.Group, Version: resource.Version, Resource: resource.Resource,
			Kind: resource.Kind, Namespaced: resource.Namespaced,
			Verbs: append(metav1.Verbs(nil), resource.Verbs...), Preferred: resource.Preferred,
		}
	}
	if len(catalog) == 0 {
		return false, nil
	}
	entries := make([]SearchEntry, 0, len(snapshot.Entries))
	for _, persisted := range snapshot.Entries {
		if persisted.ID == "" || persisted.Name == "" || persisted.Version == "" || persisted.Resource == "" {
			continue
		}
		entry := SearchEntry{
			ID: persisted.ID, UID: persisted.UID, Group: persisted.Group, Version: persisted.Version,
			Resource: persisted.Resource, Kind: persisted.Kind, Namespace: persisted.Namespace,
			Name: persisted.Name, Labels: copySearchLabels(persisted.Labels), CreatedAt: persisted.CreatedAt,
			preferred: persisted.Preferred,
		}
		entry.searchable = searchFields(entry)
		entries = append(entries, entry)
	}
	resourceVersions := make(map[searchShardKey]string, len(snapshot.ResourceVersions))
	for _, persisted := range snapshot.ResourceVersions {
		if persisted.Version == "" || persisted.Resource == "" || persisted.ResourceVersion == "" {
			continue
		}
		resourceVersions[searchShardKey{
			gvr:       schema.GroupVersionResource{Group: persisted.Group, Version: persisted.Version, Resource: persisted.Resource},
			namespace: persisted.Namespace,
		}] = persisted.ResourceVersion
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false, fmt.Errorf("search index is closed")
	}
	s.entries = entries
	s.catalog = catalog
	s.resourceVersions = resourceVersions
	s.rebuildLookupLocked()
	s.generation = snapshot.Generation
	s.lastSync = snapshot.SavedAt
	s.status = SearchIndexReady
	s.stale = true
	s.snapshotLoaded = true
	s.warnings = []string{"persisted search index restored; validating cluster state"}
	return true, nil
}

func (s *SearchIndex) persistSnapshot() error {
	s.mu.RLock()
	store := s.store
	if store == nil || len(s.catalog) == 0 || s.closed {
		s.mu.RUnlock()
		return nil
	}
	snapshot := s.snapshotLocked(store.key)
	s.mu.RUnlock()
	if err := writeSearchIndexSnapshot(store.path, snapshot); err != nil {
		return err
	}
	s.mu.Lock()
	if !s.closed && s.store == store {
		s.snapshotLoaded = true
	}
	s.mu.Unlock()
	return nil
}

func (s *SearchIndex) snapshotLocked(key string) persistedSearchIndex {
	catalog := make([]persistedSearchResource, 0, len(s.catalog))
	for _, resource := range s.catalog {
		catalog = append(catalog, persistedSearchResource{
			Group: resource.Group, Version: resource.Version, Resource: resource.Resource,
			Kind: resource.Kind, Namespaced: resource.Namespaced,
			Verbs: append([]string(nil), resource.Verbs...), Preferred: resource.Preferred,
		})
	}
	sort.Slice(catalog, func(i, j int) bool {
		return catalog[i].Group+"/"+catalog[i].Version+"/"+catalog[i].Resource < catalog[j].Group+"/"+catalog[j].Version+"/"+catalog[j].Resource
	})
	entries := make([]persistedSearchEntry, 0, len(s.entries))
	for _, entry := range s.entries {
		entries = append(entries, persistedSearchEntry{
			ID: entry.ID, UID: entry.UID, Group: entry.Group, Version: entry.Version,
			Resource: entry.Resource, Kind: entry.Kind, Namespace: entry.Namespace,
			Name: entry.Name, Labels: copySearchLabels(entry.Labels), CreatedAt: entry.CreatedAt,
			Preferred: entry.preferred,
		})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].ID < entries[j].ID })
	resourceVersions := make([]persistedSearchResourceVersion, 0, len(s.resourceVersions))
	for shard, version := range s.resourceVersions {
		resourceVersions = append(resourceVersions, persistedSearchResourceVersion{
			Group: shard.gvr.Group, Version: shard.gvr.Version, Resource: shard.gvr.Resource,
			Namespace: shard.namespace, ResourceVersion: version,
		})
	}
	sort.Slice(resourceVersions, func(i, j int) bool {
		left := resourceVersions[i]
		right := resourceVersions[j]
		return left.Group+"/"+left.Version+"/"+left.Resource+"/"+left.Namespace < right.Group+"/"+right.Version+"/"+right.Resource+"/"+right.Namespace
	})
	return persistedSearchIndex{
		Version: searchIndexSnapshotVersion, Key: key, SavedAt: time.Now().UTC(),
		Generation: s.generation, Catalog: catalog, Entries: entries, ResourceVersions: resourceVersions,
	}
}

func writeSearchIndexSnapshot(path string, snapshot persistedSearchIndex) error {
	data, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	if len(data) > searchIndexSnapshotMaxSize {
		return fmt.Errorf("search index snapshot exceeds %d bytes", searchIndexSnapshotMaxSize)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), "search-index-*.tmp")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryName, path)
}

func copySearchLabels(labels map[string]string) map[string]string {
	if len(labels) == 0 {
		return nil
	}
	copyOfLabels := make(map[string]string, len(labels))
	for key, value := range labels {
		copyOfLabels[key] = value
	}
	return copyOfLabels
}
