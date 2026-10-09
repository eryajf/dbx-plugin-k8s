package kube

// This file contains the connection-scoped metadata index used by global
// resource search. The index deliberately stores Kubernetes metadata only;
// object data (including Secret data) is never retained here.

import (
	"container/heap"
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"
)

type SearchResource struct {
	Group      string
	Version    string
	Resource   string
	Kind       string
	Namespaced bool
	Verbs      metav1.Verbs
	Preferred  bool
}

type SearchEntry struct {
	ID         string            `json:"id"`
	UID        string            `json:"uid,omitempty"`
	Group      string            `json:"group"`
	Version    string            `json:"version"`
	Resource   string            `json:"resource"`
	Kind       string            `json:"kind"`
	Namespace  string            `json:"namespace,omitempty"`
	Name       string            `json:"name"`
	Labels     map[string]string `json:"labels,omitempty"`
	CreatedAt  string            `json:"createdAt,omitempty"`
	searchable []string
	preferred  bool
}

type SearchQuery struct {
	Query     string
	Namespace string
	Group     string
	Version   string
	Resource  string
	Limit     int
	Cursor    string
}

type SearchIndexStatus string

const (
	SearchIndexCold     SearchIndexStatus = "cold"
	SearchIndexSyncing  SearchIndexStatus = "syncing"
	SearchIndexReady    SearchIndexStatus = "ready"
	SearchIndexDegraded SearchIndexStatus = "degraded"
)

type SearchIndexResult struct {
	Items      []SearchEntry
	Total      int
	Truncated  bool
	Complete   bool
	Syncing    bool
	Status     SearchIndexStatus
	Generation uint64
	IndexAge   time.Duration
	Warnings   []string
	NextCursor string
	// Usable means a persisted snapshot can answer the query while the live
	// catalog is being validated. It is intentionally internal to the backend;
	// callers still receive Complete=false until validation finishes.
	Usable bool
}

const (
	// Every discovery/list request gets a finite budget. Kubernetes API
	// servers and aggregated APIs can otherwise leave a single shard blocked
	// forever and prevent the rest of the catalog from becoming searchable.
	searchIndexListTimeout    = 5 * time.Second
	searchIndexRebuildTimeout = 30 * time.Second
)

// SearchIndex is isolated per kube.Client. A failed shard does not discard the
// entries from successful shards; callers receive those entries with Complete
// false and a warning describing the failed resource type.
type SearchIndex struct {
	client            *Client
	mu                sync.RWMutex
	entries           []SearchEntry
	entryPositions    map[string]int
	catalog           map[schema.GroupVersionResource]SearchResource
	resourceVersions  map[searchShardKey]string
	entriesByIdentity map[string]map[string]SearchEntry
	entryByIdentity   map[string]SearchEntry
	inverted          map[string]map[string]struct{}
	status            SearchIndexStatus
	generation        uint64
	lastSync          time.Time
	warnings          []string
	started           bool
	cancel            context.CancelFunc
	watchCancel       context.CancelFunc
	store             *searchIndexStore
	stale             bool
	snapshotLoaded    bool
	rebuildMu         sync.Mutex
	writeMu           sync.RWMutex
	shardLocksMu      sync.Mutex
	shardLocks        map[schema.GroupVersionResource]*sync.Mutex
	runCtx            context.Context
	closed            bool
}

type searchShardKey struct {
	gvr       schema.GroupVersionResource
	namespace string
}

func newSearchIndex(c *Client) *SearchIndex {
	return &SearchIndex{client: c, status: SearchIndexCold, store: newSearchIndexStore(c.searchIndexPersistenceKey()), catalog: make(map[schema.GroupVersionResource]SearchResource), resourceVersions: make(map[searchShardKey]string), entryPositions: make(map[string]int), entriesByIdentity: make(map[string]map[string]SearchEntry), entryByIdentity: make(map[string]SearchEntry), inverted: make(map[string]map[string]struct{}), shardLocks: make(map[schema.GroupVersionResource]*sync.Mutex)}
}

func (s *SearchIndex) shardLock(gvr schema.GroupVersionResource) *sync.Mutex {
	s.shardLocksMu.Lock()
	defer s.shardLocksMu.Unlock()
	if lock := s.shardLocks[gvr]; lock != nil {
		return lock
	}
	lock := &sync.Mutex{}
	s.shardLocks[gvr] = lock
	return lock
}

// Start starts one asynchronous initial build (or persisted snapshot resume)
// and a periodic catalog/shard refresh. It is safe to call more than once and
// is intentionally non-blocking for connect.
func (s *SearchIndex) Start() {
	s.mu.Lock()
	if s.started || s.closed {
		s.mu.Unlock()
		return
	}
	base := s.client.Context
	if base == nil {
		base = context.Background()
	}
	ctx, cancel := context.WithCancel(base)
	s.cancel = cancel
	s.runCtx = ctx
	s.started = true
	s.mu.Unlock()
	go func() {
		restored, _ := s.restorePersistedSnapshot()
		if restored {
			needsRebuild, _ := s.resumePersistedSnapshot(ctx, true)
			if needsRebuild {
				_ = s.rebuild(ctx)
			}
		} else {
			_ = s.rebuild(ctx)
		}
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if s.hasUsableSnapshot() {
					needsRebuild, _ := s.resumePersistedSnapshot(ctx, false)
					if needsRebuild {
						_ = s.rebuild(ctx)
					}
				} else {
					_ = s.rebuild(ctx)
				}
			}
		}
	}()
}

func (s *SearchIndex) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	if s.watchCancel != nil {
		s.watchCancel()
		s.watchCancel = nil
	}
	s.runCtx = nil
	s.mu.Unlock()
	s.writeMu.Lock()
	_ = s.persistSnapshot()
	s.mu.Lock()
	s.closed = true
	s.entries = nil
	s.entryPositions = make(map[string]int)
	s.entriesByIdentity = make(map[string]map[string]SearchEntry)
	s.entryByIdentity = make(map[string]SearchEntry)
	s.inverted = make(map[string]map[string]struct{})
	s.resourceVersions = make(map[searchShardKey]string)
	s.status = SearchIndexCold
	s.stale = false
	s.snapshotLoaded = false
	s.warnings = nil
	s.lastSync = time.Time{}
	s.mu.Unlock()
	s.writeMu.Unlock()
}

func (s *SearchIndex) Snapshot() (status SearchIndexStatus, generation uint64, age time.Duration, warnings []string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	status, generation = s.status, s.generation
	if !s.lastSync.IsZero() {
		age = time.Since(s.lastSync)
	}
	warnings = append([]string(nil), s.warnings...)
	return
}

// Invalidate refreshes only the mutated GVR/namespace when the catalog already
// knows that shard. A full rebuild is reserved for discovery changes or an
// operation that cannot identify its resource type.
func (s *SearchIndex) Invalidate(gvr schema.GroupVersionResource, namespace string) {
	s.mu.RLock()
	if s.closed {
		s.mu.RUnlock()
		return
	}
	s.mu.RUnlock()
	s.Start()
	s.mu.RLock()
	ctx := s.runCtx
	if ctx == nil {
		ctx = s.client.Context
	}
	if ctx == nil {
		ctx = context.Background()
	}
	s.mu.RUnlock()
	if gvr.Resource == "" {
		go func() { _ = s.rebuild(ctx) }()
		return
	}
	s.mu.RLock()
	_, known := s.catalog[gvr]
	s.mu.RUnlock()
	if !known {
		go func() { _ = s.rebuild(ctx) }()
		return
	}
	go func() {
		_ = s.refreshShard(ctx, gvr, namespace)
	}()
}

func (s *SearchIndex) rebuild(ctx context.Context) error {
	s.rebuildMu.Lock()
	defer s.rebuildMu.Unlock()
	// A full snapshot replaces every shard at once. Serialize event application
	// with the snapshot so a watch event cannot be accepted and then overwritten
	// by the replacement below.
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.client == nil || s.client.Dynamic == nil {
		s.setFailure(fmt.Errorf("Kubernetes dynamic client is unavailable"))
		return fmt.Errorf("Kubernetes dynamic client is unavailable")
	}
	buildCtx, cancel := context.WithTimeout(ctx, searchIndexRebuildTimeout)
	defer cancel()
	s.mu.Lock()
	s.status = SearchIndexSyncing
	s.mu.Unlock()

	catalog, warnings, err := s.resourceCatalog(buildCtx)
	if err != nil && len(catalog) == 0 {
		s.setFailure(err)
		return err
	}
	entries := make([]SearchEntry, 0)
	resourceVersions := make(map[searchShardKey]string)
	var entriesMu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for gvr, resource := range catalog {
		if !hasVerb(resource.Verbs, "list") {
			continue
		}
		gvr, resource := gvr, resource
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-buildCtx.Done():
				return
			}
			defer func() { <-sem }()
			listCtx, listCancel := context.WithTimeout(buildCtx, searchIndexListTimeout)
			items, resourceVersion, listErr := s.listMetadata(listCtx, gvr, resource.Namespaced, resource.Kind, resource.Preferred, "")
			listCancel()
			if listErr != nil {
				entriesMu.Lock()
				// listMetadata returns entries collected before a later page
				// failed. Keep them so one slow page does not erase useful
				// metadata from the initial snapshot.
				entries = append(entries, items...)
				if resourceVersion != "" {
					resourceVersions[searchShardKey{gvr: gvr}] = resourceVersion
				}
				warnings = append(warnings, fmt.Sprintf("%s/%s/%s: %v", gvr.Group, gvr.Version, gvr.Resource, listErr))
				entriesMu.Unlock()
				return
			}
			entriesMu.Lock()
			entries = append(entries, items...)
			if resourceVersion != "" {
				resourceVersions[searchShardKey{gvr: gvr}] = resourceVersion
			}
			entriesMu.Unlock()
		}()
	}
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return err
	}
	if buildErr := buildCtx.Err(); buildErr != nil {
		warnings = append(warnings, fmt.Sprintf("search index rebuild deadline exceeded: %v", buildErr))
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Name != entries[j].Name {
			return entries[i].Name < entries[j].Name
		}
		if entries[i].Namespace != entries[j].Namespace {
			return entries[i].Namespace < entries[j].Namespace
		}
		return entries[i].ID < entries[j].ID
	})
	sort.Strings(warnings)
	s.mu.Lock()
	s.entries = entries
	s.catalog = catalog
	s.resourceVersions = resourceVersions
	s.rebuildLookupLocked()
	s.warnings = warnings
	s.generation++
	s.lastSync = time.Now()
	s.stale = false
	if len(warnings) > 0 || err != nil {
		s.status = SearchIndexDegraded
	} else {
		s.status = SearchIndexReady
	}
	s.mu.Unlock()
	_ = s.persistSnapshot()
	if ctx.Err() == nil {
		s.restartWatches(ctx)
	}
	return nil
}

func (s *SearchIndex) setFailure(err error) {
	s.mu.Lock()
	s.status = SearchIndexDegraded
	s.warnings = []string{err.Error()}
	s.generation++
	s.mu.Unlock()
}

func (s *SearchIndex) hasUsableSnapshot() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.snapshotLoaded && !s.closed
}

// resumePersistedSnapshot validates the resource catalog and refreshes only
// resources that cannot be watched. Watch-capable resources continue from the
// persisted resourceVersion, so reconnecting does not list every object again.
// The boolean return asks the caller to perform a full rebuild when discovery
// proves that the resource catalog changed.
func (s *SearchIndex) resumePersistedSnapshot(ctx context.Context, restartWatches bool) (bool, error) {
	s.rebuildMu.Lock()
	defer s.rebuildMu.Unlock()
	resumeCtx, cancel := context.WithTimeout(ctx, searchIndexRebuildTimeout)
	defer cancel()
	catalog, warnings, err := s.resourceCatalog(resumeCtx)
	if err != nil || len(catalog) == 0 {
		if err != nil {
			s.recordPersistenceWarning(fmt.Errorf("persisted search index validation failed: %w", err))
		}
		return false, err
	}
	s.mu.RLock()
	previousCatalog := make(map[schema.GroupVersionResource]SearchResource, len(s.catalog))
	for gvr, resource := range s.catalog {
		previousCatalog[gvr] = resource
	}
	s.mu.RUnlock()
	if !searchCatalogEqual(previousCatalog, catalog) {
		return true, nil
	}
	for gvr, resource := range catalog {
		if hasVerb(resource.Verbs, "watch") && s.resourceVersion(gvr, "") == "" {
			// Without a resourceVersion a resumed watch cannot replay changes
			// that happened while the connection was closed.
			return true, nil
		}
	}

	s.mu.Lock()
	s.catalog = catalog
	s.status = SearchIndexSyncing
	s.stale = true
	s.warnings = append([]string(nil), warnings...)
	s.mu.Unlock()
	for gvr, resource := range catalog {
		if hasVerb(resource.Verbs, "watch") {
			continue
		}
		if resumeCtx.Err() != nil {
			return false, resumeCtx.Err()
		}
		_ = s.refreshShardLocked(resumeCtx, gvr, "")
	}
	if resumeCtx.Err() != nil {
		return false, resumeCtx.Err()
	}
	if restartWatches {
		s.restartWatches(ctx)
	}
	s.mu.Lock()
	s.lastSync = time.Now()
	s.stale = false
	if len(s.warnings) > 0 {
		s.status = SearchIndexDegraded
	} else {
		s.status = SearchIndexReady
	}
	s.mu.Unlock()
	_ = s.persistSnapshot()
	return false, nil
}

func (s *SearchIndex) recordPersistenceWarning(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.warnings = uniqueStrings(append(s.warnings, err.Error()))
	// The snapshot is still usable, but validation failed. Keep the periodic
	// retry enabled while reporting a degraded index rather than claiming that
	// an active synchronization is still in progress forever.
	s.stale = false
	s.status = SearchIndexDegraded
}

func searchCatalogEqual(left, right map[schema.GroupVersionResource]SearchResource) bool {
	if len(left) != len(right) {
		return false
	}
	for gvr, leftResource := range left {
		rightResource, ok := right[gvr]
		if !ok || leftResource.Group != rightResource.Group || leftResource.Version != rightResource.Version || leftResource.Resource != rightResource.Resource || leftResource.Kind != rightResource.Kind || leftResource.Namespaced != rightResource.Namespaced || leftResource.Preferred != rightResource.Preferred || len(leftResource.Verbs) != len(rightResource.Verbs) {
			return false
		}
		leftVerbs := append([]string(nil), leftResource.Verbs...)
		rightVerbs := append([]string(nil), rightResource.Verbs...)
		sort.Strings(leftVerbs)
		sort.Strings(rightVerbs)
		for i := range leftVerbs {
			if leftVerbs[i] != rightVerbs[i] {
				return false
			}
		}
	}
	return true
}

func hasVerb(verbs metav1.Verbs, want string) bool {
	for _, verb := range verbs {
		if verb == want {
			return true
		}
	}
	return false
}

func (s *SearchIndex) resourceCatalog(ctx context.Context) (map[schema.GroupVersionResource]SearchResource, []string, error) {
	catalog := make(map[schema.GroupVersionResource]SearchResource)
	if s.client.Core == nil && s.client.Discovery == nil {
		return catalog, nil, fmt.Errorf("Kubernetes discovery client is unavailable")
	}
	lists, err, _ := s.client.CachedAPIResourceListsContext(ctx)
	warnings := []string{}
	preferredVersions := s.client.PreferredVersions()
	if err != nil {
		warnings = append(warnings, err.Error())
	}
	for _, list := range lists {
		gv, parseErr := schema.ParseGroupVersion(list.GroupVersion)
		if parseErr != nil {
			warnings = append(warnings, parseErr.Error())
			continue
		}
		for _, item := range list.APIResources {
			if strings.Contains(item.Name, "/") {
				continue
			}
			gvr := gv.WithResource(item.Name)
			catalog[gvr] = SearchResource{Group: gv.Group, Version: gv.Version, Resource: item.Name, Kind: item.Kind, Namespaced: item.Namespaced, Verbs: append(metav1.Verbs(nil), item.Verbs...), Preferred: preferredVersions[gv.Group] == gv.Version || (gv.Group == "" && gv.Version == "v1")}
		}
	}
	// Keep the built-in catalog only as a cold-start fallback when discovery
	// produced no usable resource list at all. Once discovery returns any list,
	// its catalog is authoritative so an unavailable optional resource does not
	// turn a healthy index into a misleading global partial result.
	if len(catalog) == 0 && len(lists) == 0 {
		for _, resource := range stableSearchResources {
			gvr := schema.GroupVersionResource{Group: resource.Group, Version: resource.Version, Resource: resource.Resource}
			catalog[gvr] = resource
		}
	}
	if len(catalog) == 0 && err != nil {
		return catalog, warnings, err
	}
	return catalog, warnings, err
}

func (s *SearchIndex) listMetadata(ctx context.Context, gvr schema.GroupVersionResource, namespaced bool, kind string, preferred bool, namespace string) (entries []SearchEntry, resourceVersion string, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("list failed: %v", recovered)
		}
	}()
	resource := s.client.SearchDynamic().Resource(gvr)
	var listResource dynamic.ResourceInterface = resource
	if namespaced {
		listResource = resource.Namespace(namespace)
	}
	options := metav1.ListOptions{Limit: 500}
	entries = []SearchEntry{}
	for {
		list, err := listResource.List(ctx, options)
		if err != nil {
			return entries, resourceVersion, err
		}
		if list == nil {
			return entries, resourceVersion, fmt.Errorf("Kubernetes List returned no response")
		}
		for i := range list.Items {
			object := &list.Items[i]
			entries = append(entries, makeSearchEntry(gvr, kind, preferred, object))
		}
		if list.GetResourceVersion() != "" {
			resourceVersion = list.GetResourceVersion()
		}
		next := list.GetContinue()
		if next == "" {
			return entries, resourceVersion, nil
		}
		if next == options.Continue {
			return entries, resourceVersion, fmt.Errorf("Kubernetes List returned an unchanged continue token")
		}
		options.Continue = next
	}
}

func (s *SearchIndex) refreshShard(ctx context.Context, gvr schema.GroupVersionResource, namespace string) error {
	s.rebuildMu.Lock()
	defer s.rebuildMu.Unlock()
	return s.refreshShardLocked(ctx, gvr, namespace)
}

func (s *SearchIndex) refreshShardLocked(ctx context.Context, gvr schema.GroupVersionResource, namespace string) error {
	s.writeMu.RLock()
	defer s.writeMu.RUnlock()
	shardLock := s.shardLock(gvr)
	shardLock.Lock()
	defer shardLock.Unlock()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	s.mu.RLock()
	resource, ok := s.catalog[gvr]
	s.mu.RUnlock()
	if !ok || !hasVerb(resource.Verbs, "list") {
		return fmt.Errorf("resource %s/%s/%s is not in the search catalog", gvr.Group, gvr.Version, gvr.Resource)
	}
	listCtx, cancel := context.WithTimeout(ctx, searchIndexListTimeout)
	items, resourceVersion, err := s.listMetadata(listCtx, gvr, resource.Namespaced, resource.Kind, resource.Preferred, namespace)
	cancel()
	if err != nil {
		s.recordShardWarning(gvr, namespace, err)
		return err
	}
	shard := searchShardKey{gvr: gvr, namespace: namespace}
	s.mu.Lock()
	filtered := s.entries[:0]
	for _, entry := range s.entries {
		if entry.Group == gvr.Group && entry.Version == gvr.Version && entry.Resource == gvr.Resource && (namespace == "" || entry.Namespace == namespace) {
			continue
		}
		filtered = append(filtered, entry)
	}
	s.entries = append(filtered, items...)
	s.rebuildLookupLocked()
	if resourceVersion != "" {
		s.resourceVersions[shard] = resourceVersion
	}
	s.generation++
	s.lastSync = time.Now()
	// A successful shard refresh clears only warnings for this shard. Other
	// degraded shards remain visible to callers.
	prefix := fmt.Sprintf("%s/%s/%s", gvr.Group, gvr.Version, gvr.Resource)
	kept := s.warnings[:0]
	for _, warning := range s.warnings {
		if !strings.Contains(warning, prefix) || strings.HasPrefix(warning, "watch ") {
			kept = append(kept, warning)
		}
	}
	s.warnings = kept
	if len(s.warnings) == 0 && s.status == SearchIndexDegraded {
		s.status = SearchIndexReady
	}
	s.mu.Unlock()
	return nil
}

func makeSearchEntry(gvr schema.GroupVersionResource, kind string, preferred bool, object *unstructured.Unstructured) SearchEntry {
	labels := object.GetLabels()
	copyLabels := make(map[string]string, len(labels))
	for key, value := range labels {
		copyLabels[key] = value
	}
	created := ""
	if timestamp := object.GetCreationTimestamp(); !timestamp.IsZero() {
		created = timestamp.UTC().Format(time.RFC3339)
	}
	entryKind := object.GetKind()
	if entryKind == "" {
		entryKind = kind
	}
	entry := SearchEntry{
		ID:  strings.Join([]string{gvr.Group, gvr.Version, gvr.Resource, object.GetNamespace(), object.GetName()}, "/"),
		UID: string(object.GetUID()), Group: gvr.Group, Version: gvr.Version, Resource: gvr.Resource,
		Kind: entryKind, Namespace: object.GetNamespace(), Name: object.GetName(), Labels: copyLabels, CreatedAt: created,
		preferred: preferred,
	}
	entry.searchable = searchFields(entry)
	return entry
}

// restartWatches replaces the supervisors after discovery or a full refresh.
// Each supervisor reconnects with bounded backoff and updates only metadata.
func (s *SearchIndex) restartWatches(base context.Context) {
	s.mu.Lock()
	if s.watchCancel != nil {
		s.watchCancel()
	}
	watchCtx, cancel := context.WithCancel(base)
	s.watchCancel = cancel
	catalog := make(map[schema.GroupVersionResource]SearchResource, len(s.catalog))
	for gvr, resource := range s.catalog {
		catalog[gvr] = resource
	}
	s.mu.Unlock()

	for gvr, resource := range catalog {
		if !hasVerb(resource.Verbs, "watch") {
			continue
		}
		gvr, resource := gvr, resource
		go func() {
			s.watchResource(watchCtx, gvr, resource)
		}()
	}
}

type watchOutcome uint8

const (
	watchReconnect watchOutcome = iota
	watchRelist
)

func (s *SearchIndex) resourceVersion(gvr schema.GroupVersionResource, namespace string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.resourceVersions[searchShardKey{gvr: gvr, namespace: namespace}]
}

func (s *SearchIndex) setResourceVersion(gvr schema.GroupVersionResource, namespace, resourceVersion string) {
	if resourceVersion == "" {
		return
	}
	s.mu.Lock()
	if s.resourceVersions == nil {
		s.resourceVersions = make(map[searchShardKey]string)
	}
	s.resourceVersions[searchShardKey{gvr: gvr, namespace: namespace}] = resourceVersion
	s.mu.Unlock()
}

func (s *SearchIndex) preferredFor(gvr schema.GroupVersionResource) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.catalog[gvr].Preferred
}

func (s *SearchIndex) watchResource(ctx context.Context, gvr schema.GroupVersionResource, resource SearchResource) {
	backoff := time.Second
	resourceVersion := s.resourceVersion(gvr, "")
	for {
		if ctx.Err() != nil {
			return
		}
		var api dynamic.ResourceInterface = s.client.SearchDynamic().Resource(gvr)
		if resource.Namespaced {
			api = s.client.SearchDynamic().Resource(gvr).Namespace("")
		}
		stream, err := api.Watch(ctx, metav1.ListOptions{ResourceVersion: resourceVersion, AllowWatchBookmarks: true})
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if apierrors.IsResourceExpired(err) {
				if s.refreshShard(ctx, gvr, "") == nil {
					resourceVersion = s.resourceVersion(gvr, "")
					backoff = time.Second
					continue
				}
			}
			s.recordWatchWarning(gvr, err)
			if !sleepContext(ctx, backoff) {
				return
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second
		outcome, latestResourceVersion := s.consumeWatch(ctx, gvr, resource.Kind, stream)
		if latestResourceVersion != "" && ctx.Err() == nil {
			resourceVersion = latestResourceVersion
			s.setResourceVersion(gvr, "", latestResourceVersion)
		}
		if ctx.Err() != nil {
			return
		}
		if outcome == watchRelist {
			if s.refreshShard(ctx, gvr, "") == nil {
				resourceVersion = s.resourceVersion(gvr, "")
				continue
			}
		}
		if ctx.Err() != nil {
			return
		}
		if !sleepContext(ctx, backoff) {
			return
		}
	}
}

func (s *SearchIndex) consumeWatch(ctx context.Context, gvr schema.GroupVersionResource, kind string, stream watch.Interface) (watchOutcome, string) {
	defer stream.Stop()
	latestResourceVersion := ""
	for {
		select {
		case <-ctx.Done():
			return watchReconnect, latestResourceVersion
		case event, ok := <-stream.ResultChan():
			if !ok {
				return watchReconnect, latestResourceVersion
			}
			if object, ok := event.Object.(*unstructured.Unstructured); ok && object.GetResourceVersion() != "" {
				latestResourceVersion = object.GetResourceVersion()
			}
			switch event.Type {
			case watch.Added, watch.Modified:
				if object, ok := event.Object.(*unstructured.Unstructured); ok {
					s.upsertWatchEntry(ctx, makeSearchEntry(gvr, kind, s.preferredFor(gvr), object))
				}
			case watch.Deleted:
				if object, ok := event.Object.(*unstructured.Unstructured); ok {
					s.deleteWatchEntry(ctx, gvr, object)
				}
			case watch.Error:
				err := apierrors.FromObject(event.Object)
				if apierrors.IsResourceExpired(err) {
					return watchRelist, latestResourceVersion
				}
				if err != nil {
					s.recordWatchWarning(gvr, err)
				}
				return watchReconnect, latestResourceVersion
			}
		}
	}
}

func (s *SearchIndex) upsertWatchEntry(ctx context.Context, entry SearchEntry) {
	s.writeMu.RLock()
	defer s.writeMu.RUnlock()
	shardLock := s.shardLock(schema.GroupVersionResource{Group: entry.Group, Version: entry.Version, Resource: entry.Resource})
	shardLock.Lock()
	defer shardLock.Unlock()
	if ctx.Err() != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(entry.searchable) == 0 {
		entry.searchable = searchFields(entry)
	}
	if s.entryPositions == nil {
		s.rebuildLookupLocked()
	}
	// Update the dense snapshot and only this UID's preferred-version postings.
	position, ok := s.entryPositions[entry.ID]
	if !ok && entry.UID != "" {
		// Names are immutable in Kubernetes, but a few aggregated APIs have
		// emitted incomplete metadata during a replace. Fall back to the UID
		// within this GVR without making the normal event path scan the index.
		for i, existing := range s.entries {
			if existing.Group == entry.Group && existing.Version == entry.Version && existing.Resource == entry.Resource && existing.UID == entry.UID {
				position, ok = i, true
				break
			}
		}
	}
	if ok {
		old := s.entries[position]
		oldIdentity := searchIdentity(old)
		delete(s.entriesByIdentity[oldIdentity], old.ID)
		delete(s.entryPositions, old.ID)
		s.entries[position] = entry
		s.entryPositions[entry.ID] = position
		if oldIdentity != searchIdentity(entry) {
			s.reindexIdentityLocked(oldIdentity)
		}
	} else {
		s.entryPositions[entry.ID] = len(s.entries)
		s.entries = append(s.entries, entry)
	}
	identity := searchIdentity(entry)
	if s.entriesByIdentity[identity] == nil {
		s.entriesByIdentity[identity] = make(map[string]SearchEntry)
	}
	s.entriesByIdentity[identity][entry.ID] = entry
	s.reindexIdentityLocked(identity)
	s.generation++
	s.lastSync = time.Now()
}

func (s *SearchIndex) deleteWatchEntry(ctx context.Context, gvr schema.GroupVersionResource, object *unstructured.Unstructured) {
	uid := string(object.GetUID())
	id := strings.Join([]string{gvr.Group, gvr.Version, gvr.Resource, object.GetNamespace(), object.GetName()}, "/")
	s.writeMu.RLock()
	defer s.writeMu.RUnlock()
	shardLock := s.shardLock(gvr)
	shardLock.Lock()
	defer shardLock.Unlock()
	if ctx.Err() != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.entryPositions == nil {
		s.rebuildLookupLocked()
	}
	position, ok := s.entryPositions[id]
	if !ok && uid != "" {
		for i, existing := range s.entries {
			if existing.Group == gvr.Group && existing.Version == gvr.Version && existing.Resource == gvr.Resource && existing.UID == uid {
				position, ok = i, true
				break
			}
		}
	}
	if !ok {
		return
	}
	entry := s.entries[position]
	// A delayed deletion of a recreated name must not remove its new UID.
	if uid != "" && entry.UID != uid {
		return
	}
	last := len(s.entries) - 1
	s.entries[position] = s.entries[last]
	s.entryPositions[s.entries[position].ID] = position
	s.entries[last] = SearchEntry{}
	s.entries = s.entries[:last]
	delete(s.entryPositions, entry.ID)
	identity := searchIdentity(entry)
	delete(s.entriesByIdentity[identity], entry.ID)
	s.reindexIdentityLocked(identity)
	s.generation++
	s.lastSync = time.Now()
}

func (s *SearchIndex) recordWatchWarning(gvr schema.GroupVersionResource, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.warnings = append(s.warnings, fmt.Sprintf("watch %s/%s/%s: %v", gvr.Group, gvr.Version, gvr.Resource, err))
	s.warnings = uniqueStrings(s.warnings)
}

func (s *SearchIndex) recordShardWarning(gvr schema.GroupVersionResource, namespace string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	scope := ""
	if namespace != "" {
		scope = " namespace=" + namespace
	}
	s.warnings = append(s.warnings, fmt.Sprintf("list %s/%s/%s%s: %v", gvr.Group, gvr.Version, gvr.Resource, scope, err))
	s.warnings = uniqueStrings(s.warnings)
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := values[:0]
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func sleepContext(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func searchIdentity(entry SearchEntry) string {
	if entry.UID != "" {
		return entry.UID
	}
	return "id:" + entry.ID
}

func searchGram(value string) string {
	runes := []rune(value)
	if len(runes) > 3 {
		runes = runes[:3]
	}
	return string(runes)
}

func betterSearchEntry(candidate, current SearchEntry) bool {
	return candidate.preferred && !current.preferred ||
		candidate.preferred == current.preferred && candidate.ID < current.ID
}

func searchPostingKeys(entry SearchEntry) map[string]struct{} {
	keys := make(map[string]struct{})
	for _, field := range entry.searchable {
		runes := []rune(field)
		for length := 1; length <= 3 && length <= len(runes); length++ {
			for start := 0; start+length <= len(runes); start++ {
				keys[string(runes[start:start+length])] = struct{}{}
			}
		}
	}
	return keys
}

func (s *SearchIndex) addSearchPostingsLocked(identity string, entry SearchEntry) {
	for key := range searchPostingKeys(entry) {
		if s.inverted[key] == nil {
			s.inverted[key] = make(map[string]struct{})
		}
		s.inverted[key][identity] = struct{}{}
	}
}

func (s *SearchIndex) removeSearchPostingsLocked(identity string, entry SearchEntry) {
	for key := range searchPostingKeys(entry) {
		posting := s.inverted[key]
		delete(posting, identity)
		if len(posting) == 0 {
			delete(s.inverted, key)
		}
	}
}

func (s *SearchIndex) reindexIdentityLocked(identity string) {
	if previous, ok := s.entryByIdentity[identity]; ok {
		s.removeSearchPostingsLocked(identity, previous)
		delete(s.entryByIdentity, identity)
	}
	candidates := s.entriesByIdentity[identity]
	var best SearchEntry
	haveBest := false
	for _, entry := range candidates {
		if !haveBest || betterSearchEntry(entry, best) {
			best = entry
			haveBest = true
		}
	}
	if !haveBest {
		delete(s.entriesByIdentity, identity)
		return
	}
	s.entryByIdentity[identity] = best
	s.addSearchPostingsLocked(identity, best)
}

// rebuildLookupLocked is used for full snapshots and shard refreshes. Watch
// events use the incremental helpers below so a single Pod update does not
// rebuild postings for every object in the connection.
func (s *SearchIndex) rebuildLookupLocked() {
	entriesByIdentity := make(map[string]map[string]SearchEntry, len(s.entries))
	s.entryPositions = make(map[string]int, len(s.entries))
	for i := range s.entries {
		entry := s.entries[i]
		s.entryPositions[entry.ID] = i
		if len(entry.searchable) == 0 {
			entry.searchable = searchFields(entry)
			s.entries[i] = entry
		}
		identity := searchIdentity(entry)
		if entriesByIdentity[identity] == nil {
			entriesByIdentity[identity] = make(map[string]SearchEntry)
		}
		entriesByIdentity[identity][entry.ID] = entry
	}
	s.entriesByIdentity = entriesByIdentity
	s.entryByIdentity = make(map[string]SearchEntry, len(entriesByIdentity))
	s.inverted = make(map[string]map[string]struct{})
	for identity, candidates := range entriesByIdentity {
		var best SearchEntry
		haveBest := false
		for _, entry := range candidates {
			if !haveBest || betterSearchEntry(entry, best) {
				best = entry
				haveBest = true
			}
		}
		if haveBest {
			s.entryByIdentity[identity] = best
			s.addSearchPostingsLocked(identity, best)
		}
	}
}

// Query is an in-memory search over metadata snapshots. Connections start the
// index when published; callers can use Complete/Syncing/Usable to distinguish
// a complete live index from a useful persisted snapshot being refreshed.
func (s *SearchIndex) Query(query SearchQuery) SearchIndexResult {
	status, generation, age, warnings := s.Snapshot()
	s.mu.RLock()
	stale := s.stale
	snapshotLoaded := s.snapshotLoaded
	entries := make([]SearchEntry, 0)
	if len(s.entryByIdentity) == 0 && len(s.entries) > 0 {
		entries = append(entries, s.entries...)
	} else if len(searchTokens(query.Query)) == 0 {
		for _, entry := range s.entryByIdentity {
			entries = append(entries, entry)
		}
	} else {
		var candidateIDs map[string]struct{}
		for _, token := range searchTokens(query.Query) {
			ids := s.inverted[searchGram(token)]
			if candidateIDs == nil {
				candidateIDs = make(map[string]struct{}, len(ids))
				for identity := range ids {
					candidateIDs[identity] = struct{}{}
				}
				continue
			}
			for identity := range candidateIDs {
				if _, ok := ids[identity]; !ok {
					delete(candidateIDs, identity)
				}
			}
		}
		for identity := range candidateIDs {
			if entry, ok := s.entryByIdentity[identity]; ok {
				entries = append(entries, entry)
			}
		}
	}
	s.mu.RUnlock()
	tokens := searchTokens(query.Query)
	limit := query.Limit
	if limit <= 0 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	// Apply scope filters after the inverted candidate lookup. Prefer the
	// discovery preferred version, then keep the deterministic first entry.
	byIdentity := make(map[string]SearchEntry, len(entries))
	for _, entry := range entries {
		if query.Namespace != "" && entry.Namespace != query.Namespace {
			continue
		}
		if query.Group != "" && entry.Group != query.Group {
			continue
		}
		if query.Version != "" && entry.Version != query.Version {
			continue
		}
		if query.Resource != "" && entry.Resource != query.Resource {
			continue
		}
		identity := entry.UID
		if identity == "" {
			identity = "id:" + entry.ID
		}
		previous, exists := byIdentity[identity]
		if !exists || (entry.preferred && !previous.preferred) || (entry.preferred == previous.preferred && entry.ID < previous.ID) {
			byIdentity[identity] = entry
		}
	}
	allMatches := make([]searchCandidate, 0, len(byIdentity))
	for _, entry := range byIdentity {
		score, ok := entryMatch(entry, tokens)
		if ok {
			allMatches = append(allMatches, searchCandidate{entry: entry, score: score})
		}
	}
	result := SearchIndexResult{Status: status, Generation: generation, IndexAge: age, Complete: status == SearchIndexReady && !stale && len(warnings) == 0, Syncing: stale || status == SearchIndexCold || status == SearchIndexSyncing, Usable: snapshotLoaded, Warnings: append([]string{}, warnings...), Total: len(allMatches)}
	offset := 0
	if query.Cursor != "" {
		if parsed, err := strconv.Atoi(query.Cursor); err == nil && parsed >= 0 {
			offset = parsed
		} else {
			result.Complete = false
			result.Status = SearchIndexDegraded
			result.Warnings = append(result.Warnings, "invalid search cursor")
		}
	}
	if offset > len(allMatches) {
		offset = len(allMatches)
	}
	var matches []searchCandidate
	if query.Cursor == "" {
		if len(allMatches) > limit {
			result.Truncated = true
			result.NextCursor = strconv.Itoa(limit)
		}
		matches = topSearchCandidates(allMatches, limit)
	} else {
		sort.SliceStable(allMatches, func(i, j int) bool { return searchCandidateBetter(allMatches[i], allMatches[j]) })
		matches = allMatches[offset:]
	}
	if len(matches) > limit {
		result.Truncated = true
		matches = matches[:limit]
		result.NextCursor = strconv.Itoa(offset + limit)
	}
	result.Items = make([]SearchEntry, 0, len(matches))
	for _, item := range matches {
		result.Items = append(result.Items, item.entry)
	}
	return result
}

func searchTokens(value string) []string {
	value = norm.NFKC.String(strings.ToLower(strings.TrimSpace(value)))
	parts := strings.FieldsFunc(value, func(r rune) bool { return unicode.IsSpace(r) })
	return parts
}

func entryMatch(entry SearchEntry, tokens []string) (int, bool) {
	if len(tokens) == 0 {
		return 100, true
	}
	fields := entry.searchable
	if len(fields) == 0 {
		fields = searchFields(entry)
	}
	score := 0
	for _, token := range tokens {
		best, matched := 1000, false
		for index, field := range fields {
			if field == "" {
				continue
			}
			rank := 7
			switch index {
			case 0:
				if field == token {
					rank = 0
				} else if strings.HasPrefix(field, token) {
					rank = 1
				} else if strings.Contains(field, token) {
					rank = 2
				} else {
					continue
				}
			case 1:
				if field == token {
					rank = 3
				} else if strings.HasPrefix(field, token) {
					rank = 4
				} else if strings.Contains(field, token) {
					rank = 5
				} else {
					continue
				}
			case 2, 3, 4, 5, 6:
				if strings.Contains(field, token) {
					rank = 6
				} else {
					continue
				}
			default:
				if strings.Contains(field, token) {
					rank = 7
				} else {
					continue
				}
			}
			if rank < best {
				best, matched = rank, true
			}
		}
		if !matched {
			return 0, false
		}
		score += best
	}
	return score, true
}

func searchFields(entry SearchEntry) []string {
	keys := make([]string, 0, len(entry.Labels))
	for key := range entry.Labels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	fields := []string{normalize(entry.Name), normalize(entry.Namespace), normalize(entry.Resource), normalize(entry.Kind), normalize(entry.Group)}
	if entry.Group != "" {
		fields = append(fields, normalize(entry.Resource+"."+entry.Group), normalize(entry.Group+"/"+entry.Resource))
	}
	for _, key := range keys {
		fields = append(fields, normalize(key), normalize(entry.Labels[key]))
	}
	return fields
}

type searchCandidate struct {
	entry SearchEntry
	score int
}

func searchCandidateBetter(left, right searchCandidate) bool {
	if left.score != right.score {
		return left.score < right.score
	}
	if leftPriority, rightPriority := searchResourcePriority(left.entry.Resource), searchResourcePriority(right.entry.Resource); leftPriority != rightPriority {
		return leftPriority < rightPriority
	}
	if left.entry.Name != right.entry.Name {
		return left.entry.Name < right.entry.Name
	}
	if left.entry.Namespace != right.entry.Namespace {
		return left.entry.Namespace < right.entry.Namespace
	}
	return left.entry.ID < right.entry.ID
}

// searchResourcePriority keeps indexed results in the same order as the
// realtime search fallback. Lower values are presented first when matches have
// the same textual score.
func searchResourcePriority(resource string) int {
	switch resource {
	case "deployments":
		return 1
	case "pods":
		return 2
	case "services":
		return 3
	case "endpointslices":
		return 4
	case "endpoints":
		return 5
	case "statefulsets":
		return 6
	case "daemonsets":
		return 7
	case "configmaps":
		return 8
	case "secrets":
		return 9
	case "jobs":
		return 10
	case "ingresses":
		return 11
	case "persistentvolumeclaims":
		return 12
	case "persistentvolumes":
		return 13
	case "horizontalpodautoscalers":
		return 14
	case "namespaces":
		return 15
	case "nodes":
		return 16
	default:
		return 17
	}
}

type searchCandidateHeap []searchCandidate

func (h searchCandidateHeap) Len() int { return len(h) }
func (h searchCandidateHeap) Less(i, j int) bool {
	// Reverse the normal ordering so the worst retained result stays at root.
	return searchCandidateBetter(h[j], h[i])
}
func (h searchCandidateHeap) Swap(i, j int)   { h[i], h[j] = h[j], h[i] }
func (h *searchCandidateHeap) Push(value any) { *h = append(*h, value.(searchCandidate)) }
func (h *searchCandidateHeap) Pop() any {
	old := *h
	n := len(old)
	value := old[n-1]
	*h = old[:n-1]
	return value
}

func topSearchCandidates(all []searchCandidate, limit int) []searchCandidate {
	if len(all) <= limit {
		sort.SliceStable(all, func(i, j int) bool { return searchCandidateBetter(all[i], all[j]) })
		return all
	}
	h := &searchCandidateHeap{}
	heap.Init(h)
	for _, candidate := range all {
		if h.Len() < limit {
			heap.Push(h, candidate)
			continue
		}
		if searchCandidateBetter(candidate, (*h)[0]) {
			(*h)[0] = candidate
			heap.Fix(h, 0)
		}
	}
	result := append([]searchCandidate(nil), (*h)...)
	sort.SliceStable(result, func(i, j int) bool { return searchCandidateBetter(result[i], result[j]) })
	return result
}

func normalize(value string) string { return norm.NFKC.String(strings.ToLower(value)) }

// Kept here to avoid a package cycle with resources. Discovery entries always
// replace these values when the API server supplies a served GVR.
var stableSearchResources = []SearchResource{
	{Version: "v1", Resource: "pods", Kind: "Pod", Namespaced: true, Verbs: metav1.Verbs{"list"}, Preferred: true},
	{Group: "apps", Version: "v1", Resource: "deployments", Kind: "Deployment", Namespaced: true, Verbs: metav1.Verbs{"list"}, Preferred: true},
	{Group: "apps", Version: "v1", Resource: "statefulsets", Kind: "StatefulSet", Namespaced: true, Verbs: metav1.Verbs{"list"}, Preferred: true},
	{Group: "apps", Version: "v1", Resource: "daemonsets", Kind: "DaemonSet", Namespaced: true, Verbs: metav1.Verbs{"list"}, Preferred: true},
	{Group: "batch", Version: "v1", Resource: "jobs", Kind: "Job", Namespaced: true, Verbs: metav1.Verbs{"list"}, Preferred: true},
	{Group: "batch", Version: "v1", Resource: "cronjobs", Kind: "CronJob", Namespaced: true, Verbs: metav1.Verbs{"list"}, Preferred: true},
	{Version: "v1", Resource: "services", Kind: "Service", Namespaced: true, Verbs: metav1.Verbs{"list"}, Preferred: true},
	{Version: "v1", Resource: "configmaps", Kind: "ConfigMap", Namespaced: true, Verbs: metav1.Verbs{"list"}, Preferred: true},
	{Version: "v1", Resource: "secrets", Kind: "Secret", Namespaced: true, Verbs: metav1.Verbs{"list"}, Preferred: true},
	{Version: "v1", Resource: "namespaces", Kind: "Namespace", Namespaced: false, Verbs: metav1.Verbs{"list"}, Preferred: true},
	{Version: "v1", Resource: "nodes", Kind: "Node", Namespaced: false, Verbs: metav1.Verbs{"list"}, Preferred: true},
}
