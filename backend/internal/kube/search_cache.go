package kube

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

const (
	searchSnapshotTTL        = 5 * time.Second
	searchSnapshotMaxKeys    = 64
	searchSnapshotMaxObjects = 20000
)

type searchSnapshotKey struct {
	gvr       schema.GroupVersionResource
	namespace string
	options   string
}

type searchSnapshot struct {
	list    *unstructured.UnstructuredList
	err     error
	expires time.Time
	used    uint64
}

type searchSnapshotFlight struct {
	done     chan struct{}
	cancel   context.CancelFunc
	waiters  int
	finished bool
	list     *unstructured.UnstructuredList
	err      error
}

// A search snapshot is immutable after publication. Every caller receives its
// own copy so the search matcher cannot change a later query's results.
type searchSnapshotCache struct {
	mu         sync.Mutex
	entries    map[searchSnapshotKey]searchSnapshot
	flights    map[searchSnapshotKey]*searchSnapshotFlight
	objects    int
	access     uint64
	closed     bool
	closedCh   chan struct{}
	ttl        time.Duration
	maxKeys    int
	maxObjects int
	now        func() time.Time
}

func newSearchSnapshotCache() *searchSnapshotCache {
	return &searchSnapshotCache{
		entries: make(map[searchSnapshotKey]searchSnapshot), flights: make(map[searchSnapshotKey]*searchSnapshotFlight),
		closedCh: make(chan struct{}), ttl: searchSnapshotTTL, maxKeys: searchSnapshotMaxKeys,
		maxObjects: searchSnapshotMaxObjects, now: time.Now,
	}
}

func (c *Client) searchResourceCache() *searchSnapshotCache {
	c.searchCacheMu.Lock()
	defer c.searchCacheMu.Unlock()
	if c.searchCache == nil {
		c.searchCache = newSearchSnapshotCache()
	}
	return c.searchCache
}

// SearchResourceList reuses a short-lived object snapshot for a resource,
// namespace and list options. Concurrent queries share one List request, while
// each caller can cancel independently. Secrets always bypass the cache.
func (c *Client) SearchResourceList(ctx context.Context, gvr schema.GroupVersionResource, namespace string, options metav1.ListOptions) (*unstructured.UnstructuredList, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	if c.Context != nil && c.Context.Err() != nil {
		return nil, false, c.Context.Err()
	}
	if c.Dynamic == nil {
		return nil, false, fmt.Errorf("Kubernetes dynamic client is unavailable")
	}
	// Snapshot identity includes pagination and resource-version options as well
	// as selectors; a limited response must not satisfy a different List request.
	options = *options.DeepCopy()
	if gvr.Resource == "secrets" {
		list, err := c.Dynamic.Resource(gvr).Namespace(namespace).List(ctx, options)
		return list, false, err
	}
	encodedOptions, err := json.Marshal(options)
	if err != nil {
		return nil, false, fmt.Errorf("invalid search list options: %w", err)
	}
	key := searchSnapshotKey{gvr: gvr, namespace: namespace, options: string(encodedOptions)}
	cache := c.searchResourceCache()
	cache.mu.Lock()
	if cache.closed {
		cache.mu.Unlock()
		return nil, false, context.Canceled
	}
	if entry, found := cache.entries[key]; found {
		if cache.now().Before(entry.expires) {
			cache.access++
			entry.used = cache.access
			cache.entries[key] = entry
			cache.mu.Unlock()
			if entry.list == nil {
				return nil, true, entry.err
			}
			return entry.list.DeepCopy(), true, entry.err
		}
		cache.remove(key)
	}
	flight, hit := cache.flights[key]
	if hit {
		flight.waiters++
	} else {
		// Pending keys are bounded too. Requests outside this working set run
		// directly and cannot create an unbounded cache bookkeeping map.
		if len(cache.flights) >= cache.maxKeys {
			cache.mu.Unlock()
			list, err := c.Dynamic.Resource(gvr).Namespace(namespace).List(ctx, options)
			return list, false, err
		}
		connectionCtx := c.Context
		if connectionCtx == nil {
			connectionCtx = context.Background()
		}
		listCtx, cancel := context.WithCancel(connectionCtx)
		flight = &searchSnapshotFlight{done: make(chan struct{}), cancel: cancel, waiters: 1}
		cache.flights[key] = flight
		go cache.fetch(c, key, flight, listCtx, options)
	}
	cache.mu.Unlock()
	defer cache.release(key, flight)
	select {
	case <-ctx.Done():
		return nil, hit, ctx.Err()
	case <-cache.closedCh:
		return nil, hit, context.Canceled
	case <-flight.done:
		if err := ctx.Err(); err != nil {
			return nil, hit, err
		}
		if flight.err != nil {
			return nil, hit, flight.err
		}
		return flight.list.DeepCopy(), hit, nil
	}
}

func (cache *searchSnapshotCache) fetch(c *Client, key searchSnapshotKey, flight *searchSnapshotFlight, ctx context.Context, options metav1.ListOptions) {
	var list *unstructured.UnstructuredList
	var err error
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				err = fmt.Errorf("list failed: %v", recovered)
			}
		}()
		list, err = c.Dynamic.Resource(key.gvr).Namespace(key.namespace).List(ctx, options)
	}()
	if err == nil && list == nil {
		err = fmt.Errorf("Kubernetes List returned no response")
	}
	if list != nil {
		list = list.DeepCopy()
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	flight.finished = true
	flight.list, flight.err = list, err
	if cache.flights[key] == flight {
		delete(cache.flights, key)
		if !cache.closed && flight.waiters > 0 && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			cache.store(key, list, err)
		}
	}
	if cache.closed && flight.err == nil {
		flight.err = context.Canceled
	}
	close(flight.done)
	flight.cancel()
}

func (cache *searchSnapshotCache) release(key searchSnapshotKey, flight *searchSnapshotFlight) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	flight.waiters--
	if flight.waiters == 0 && !flight.finished {
		if cache.flights[key] == flight {
			delete(cache.flights, key)
		}
		flight.cancel()
	}
}

func (cache *searchSnapshotCache) remove(key searchSnapshotKey) {
	if entry, found := cache.entries[key]; found {
		if entry.list != nil {
			cache.objects -= len(entry.list.Items)
		}
		delete(cache.entries, key)
	}
}

func (cache *searchSnapshotCache) store(key searchSnapshotKey, list *unstructured.UnstructuredList, err error) {
	if cache.maxKeys <= 0 || (list != nil && len(list.Items) > cache.maxObjects) {
		return
	}
	now := cache.now()
	for oldKey, entry := range cache.entries {
		if !now.Before(entry.expires) {
			cache.remove(oldKey)
		}
	}
	cache.remove(key)
	listObjects := 0
	if list != nil {
		listObjects = len(list.Items)
	}
	for len(cache.entries) >= cache.maxKeys || cache.objects+listObjects > cache.maxObjects {
		var oldestKey searchSnapshotKey
		oldest := ^uint64(0)
		for candidate, entry := range cache.entries {
			if entry.used < oldest {
				oldestKey, oldest = candidate, entry.used
			}
		}
		cache.remove(oldestKey)
	}
	cache.access++
	cache.entries[key] = searchSnapshot{list: list, err: err, expires: now.Add(cache.ttl), used: cache.access}
	if list != nil {
		cache.objects += len(list.Items)
	}
}

// ClearSearchResourceCache releases snapshots and cancels shared List requests
// when their owning connection closes. A closed cache cannot be reused.
func (c *Client) ClearSearchResourceCache() {
	cache := c.searchResourceCache()
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.closed {
		return
	}
	cache.closed = true
	close(cache.closedCh)
	for _, flight := range cache.flights {
		flight.cancel()
	}
	cache.entries = make(map[searchSnapshotKey]searchSnapshot)
	cache.flights = make(map[searchSnapshotKey]*searchSnapshotFlight)
	cache.objects = 0
}

// InvalidateSearchResourceCache drops snapshots after a successful resource
// mutation while keeping the cache available for subsequent searches.
func (c *Client) InvalidateSearchResourceCache() {
	cache := c.searchResourceCache()
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.closed {
		return
	}
	for _, flight := range cache.flights {
		flight.cancel()
	}
	cache.entries = make(map[searchSnapshotKey]searchSnapshot)
	cache.flights = make(map[searchSnapshotKey]*searchSnapshotFlight)
	cache.objects = 0
}
