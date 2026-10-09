// Package kube owns Kubernetes clients and the lifetime shared by their streams.
package kube

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"

	"github.com/eryajf/dbx-plugin-k8s/internal/prometheus"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

type Client struct {
	Core                kubernetes.Interface
	Dynamic             dynamic.Interface
	Config              *rest.Config
	Context             context.Context
	Namespace           string
	ContextName         string
	KubeconfigPath      string
	cancel              context.CancelFunc
	once                sync.Once
	httpClient          *http.Client
	Prometheus          *prometheus.Client
	PrometheusURL       string
	PrometheusReachable bool
	discoveryMu         sync.Mutex
	discoveryAt         time.Time
	discoveryLists      []*metav1.APIResourceList
	discoveryPreferred  map[string]string
	discoveryErr        error
	discoveryFlight     *discoveryFlight
	discoveryGeneration uint64
	Discovery           discovery.DiscoveryInterface
	searchCacheMu       sync.Mutex
	searchCache         *searchSnapshotCache
	searchIndexMu       sync.Mutex
	searchIndex         *SearchIndex
	searchIndexKey      string
}

// discoveryFlight contains the result owned by one in-flight discovery call.
// Keeping the result on the flight itself means waiters cannot accidentally
// observe a newer flight after an invalidation detaches the old one.
type discoveryFlight struct {
	done       chan struct{}
	lists      []*metav1.APIResourceList
	preferred  map[string]string
	err        error
	generation uint64
}

const (
	discoveryCacheTTL       = 30 * time.Second
	discoveryRequestTimeout = 2 * time.Second
)

// CachedAPIResourceLists avoids repeating the expensive discovery handshake for
// every keystroke in global search. The cache is scoped to this client, so
// connections never share discovery data.
func (c *Client) CachedAPIResourceLists() (lists []*metav1.APIResourceList, err error, hit bool) {
	return c.CachedAPIResourceListsContext(context.Background())
}

// CachedAPIResourceListsContext is the bounded form used by interactive search.
// The client-go discovery interface predates context-aware discovery methods, so
// this method uses the REST client directly when a live Client was created. The
// context prevents a stalled API aggregation endpoint from holding Cmd+K open.
func (c *Client) CachedAPIResourceListsContext(ctx context.Context) (lists []*metav1.APIResourceList, err error, hit bool) {
	if err := ctx.Err(); err != nil {
		return nil, err, false
	}
	c.discoveryMu.Lock()
	if !c.discoveryAt.IsZero() && time.Since(c.discoveryAt) < discoveryCacheTTL {
		lists, err = c.discoveryLists, c.discoveryErr
		c.discoveryMu.Unlock()
		return lists, err, true
	}
	if flight := c.discoveryFlight; flight != nil {
		c.discoveryMu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err(), false
		case <-flight.done:
			c.discoveryMu.Lock()
			lists, err = flight.lists, flight.err
			c.discoveryMu.Unlock()
			return lists, err, true
		}
	}
	flight := &discoveryFlight{done: make(chan struct{}), generation: c.discoveryGeneration}
	c.discoveryFlight = flight
	c.discoveryMu.Unlock()

	var preferred map[string]string
	lists, preferred, err = c.discoverResourceLists(ctx)
	c.discoveryMu.Lock()
	flight.lists, flight.preferred, flight.err = lists, preferred, err
	if c.discoveryFlight == flight {
		// An invalidation increments the generation and detaches the old flight.
		// Such a result is still delivered to its original waiters, but must not
		// repopulate the cache used by later searches.
		if c.discoveryGeneration == flight.generation {
			c.discoveryLists = lists
			c.discoveryPreferred = preferred
			c.discoveryErr = err
			// Do not pin a transient discovery failure for the full success TTL. A
			// stalled or temporarily unavailable aggregated API should be retried by the
			// next search once the request-level timeout has elapsed.
			if err == nil {
				c.discoveryAt = time.Now()
			} else {
				c.discoveryAt = time.Time{}
			}
		}
		c.discoveryFlight = nil
	}
	close(flight.done)
	c.discoveryMu.Unlock()
	return lists, err, false
}

// PreferredVersions returns the preferred served version for each API group
// from the most recent discovery response. The map is copied so callers can
// retain it while discovery is invalidated or refreshed.
func (c *Client) PreferredVersions() map[string]string {
	c.discoveryMu.Lock()
	defer c.discoveryMu.Unlock()
	result := make(map[string]string, len(c.discoveryPreferred))
	for group, version := range c.discoveryPreferred {
		result[group] = version
	}
	return result
}

func (c *Client) discoverResourceLists(ctx context.Context) ([]*metav1.APIResourceList, map[string]string, error) {
	preferred := make(map[string]string)
	if err := ctx.Err(); err != nil {
		return nil, preferred, err
	}
	if c.Discovery == nil {
		// Fake clients and older callers do not have a REST discovery client. Keep
		// this compatibility path; live clients are initialized with Discovery.
		// The legacy interface has no context parameter, so isolate it behind a
		// buffered result channel and still honor the caller's deadline.
		type result struct {
			groups []*metav1.APIGroup
			lists  []*metav1.APIResourceList
			err    error
		}
		if c.Core == nil {
			return nil, preferred, fmt.Errorf("Kubernetes discovery client is unavailable")
		}
		results := make(chan result, 1)
		go func() {
			groups, lists, err := c.Core.Discovery().ServerGroupsAndResources()
			results <- result{groups: groups, lists: lists, err: err}
		}()
		select {
		case <-ctx.Done():
			return nil, preferred, ctx.Err()
		case value := <-results:
			for _, group := range value.groups {
				if group != nil && group.PreferredVersion.Version != "" {
					preferred[group.Name] = group.PreferredVersion.Version
				}
			}
			return value.lists, preferred, value.err
		}
	}
	legacy := c.Discovery.WithLegacy().RESTClient()
	// Every endpoint gets its own deadline. A failed aggregated API must not
	// consume an unbounded connection context or hide later healthy API groups.
	fetch := func(path string, into runtime.Object) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		requestCtx, cancel := context.WithTimeout(ctx, discoveryRequestTimeout)
		defer cancel()
		if err := legacy.Get().AbsPath(path).Do(requestCtx).Into(into); err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		return nil
	}
	var discoveryErrors []error
	var paths []string
	var versions metav1.APIVersions
	if err := fetch("/api", &versions); err != nil {
		discoveryErrors = append(discoveryErrors, err)
	} else {
		for _, version := range versions.Versions {
			paths = append(paths, "/api/"+version)
		}
		if len(versions.Versions) > 0 {
			preferred[""] = versions.Versions[0]
		}
	}
	var groups metav1.APIGroupList
	if err := fetch("/apis", &groups); err != nil {
		discoveryErrors = append(discoveryErrors, err)
	}
	for _, group := range groups.Groups {
		if group.PreferredVersion.Version != "" {
			preferred[group.Name] = group.PreferredVersion.Version
		}
		for _, version := range group.Versions {
			paths = append(paths, "/apis/"+group.Name+"/"+version.Version)
		}
	}
	// Bounded workers avoid serial aggregation timeouts on clusters with many
	// CRDs, while result slots retain stable server discovery order.
	listsByPath := make([]*metav1.APIResourceList, len(paths))
	errorsByPath := make([]error, len(paths))
	jobs := make(chan int)
	var workers sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range jobs {
				var list metav1.APIResourceList
				if err := fetch(paths[index], &list); err != nil {
					errorsByPath[index] = err
				} else {
					listsByPath[index] = &list
				}
			}
		}()
	}
	for index := range paths {
		jobs <- index
	}
	close(jobs)
	workers.Wait()
	lists := make([]*metav1.APIResourceList, 0, len(paths))
	for index, list := range listsByPath {
		if list != nil {
			lists = append(lists, list)
		}
		if errorsByPath[index] != nil {
			discoveryErrors = append(discoveryErrors, errorsByPath[index])
		}
	}
	return lists, preferred, errors.Join(discoveryErrors...)
}

// New leaves HTTP request timeouts to callers so exec/log/watch streams aren't
// disconnected after the ordinary request timeout.
func New(config *rest.Config, namespace, contextName string) (*Client, error) {
	cfg := rest.CopyConfig(config)
	cfg.Timeout = 0
	cfg.UserAgent = "dbx-plugin-k8s/0.1.10"
	transport, err := rest.HTTPClientFor(cfg)
	if err != nil {
		return nil, err
	}
	core, err := kubernetes.NewForConfigAndClient(cfg, transport)
	if err != nil {
		transport.CloseIdleConnections()
		return nil, err
	}
	dyn, err := dynamic.NewForConfigAndClient(cfg, transport)
	if err != nil {
		transport.CloseIdleConnections()
		return nil, err
	}
	discoveryClient, err := discovery.NewDiscoveryClientForConfigAndClient(cfg, transport)
	if err != nil {
		transport.CloseIdleConnections()
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{Core: core, Dynamic: dyn, Config: cfg, Context: ctx,
		Namespace: namespace, ContextName: contextName, cancel: cancel, httpClient: transport, Discovery: discoveryClient}, nil
}

func (c *Client) Close() {
	c.once.Do(func() {
		c.ClearSearchResourceCache()
		c.SearchIndex().Close()
		c.InvalidateDiscoveryCache()
		if c.cancel != nil {
			c.cancel()
		}
		if c.httpClient != nil {
			c.httpClient.CloseIdleConnections()
		}
		if c.Prometheus != nil {
			c.Prometheus.Close()
		}
	})
}

// SearchIndex returns the metadata index owned by this connection. It is
// lazily allocated so tests and callers that construct Client literals retain
// the same behaviour as clients returned by New.
func (c *Client) SearchIndex() *SearchIndex {
	c.searchIndexMu.Lock()
	defer c.searchIndexMu.Unlock()
	if c.searchIndex == nil {
		c.searchIndex = newSearchIndex(c)
	}
	return c.searchIndex
}

// SetSearchIndexPersistenceKey scopes the on-disk metadata snapshot to the
// DBX connection and the Kubernetes endpoint. It must be set before the
// connection is published so the asynchronous index startup can restore it.
func (c *Client) SetSearchIndexPersistenceKey(connectionID string) {
	c.searchIndexMu.Lock()
	c.searchIndexKey = connectionID
	if c.searchIndex != nil {
		c.searchIndex.setPersistenceStore(newSearchIndexStore(c.searchIndexPersistenceKey()))
	}
	c.searchIndexMu.Unlock()
}

func (c *Client) searchIndexPersistenceKey() string {
	// Persistence is opt-in through the connection manager. Anonymous clients
	// (including test fakes) must not share a snapshot under an all-empty key.
	if c.searchIndexKey == "" {
		return ""
	}
	host := ""
	credentialFingerprint := ""
	if c.Config != nil {
		host = c.Config.Host
		hash := sha256.New()
		_, _ = hash.Write([]byte(c.Config.BearerToken))
		_, _ = hash.Write(c.Config.TLSClientConfig.CertData)
		_, _ = hash.Write(c.Config.TLSClientConfig.KeyData)
		credentialFingerprint = hex.EncodeToString(hash.Sum(nil))
	}
	return strings.Join([]string{c.searchIndexKey, host, c.ContextName, c.Namespace, credentialFingerprint}, "\x00")
}

// StartSearchIndex begins asynchronous discovery/listing after a connection
// is published. Tests and compatibility callers that construct a Client
// literal can continue using the real-time fallback without starting it.
func (c *Client) StartSearchIndex() { c.SearchIndex().Start() }

// InvalidateSearchIndex refreshes the indexed resource metadata after a
// mutation. The optional GVR and namespace allow future shard-level refreshes.
func (c *Client) InvalidateSearchIndex(gvr schema.GroupVersionResource, namespace string) {
	c.SearchIndex().Invalidate(gvr, namespace)
}

func (c *Client) InvalidateDiscoveryCache() {
	c.discoveryMu.Lock()
	defer c.discoveryMu.Unlock()
	c.discoveryGeneration++
	c.discoveryAt = time.Time{}
	c.discoveryLists = nil
	c.discoveryPreferred = nil
	c.discoveryErr = nil
	// Detach an in-flight lookup so a new caller can start fresh immediately.
	// The old owner will still close its flight channel when it completes.
	c.discoveryFlight = nil
}

func (c *Client) RequestContext(timeout time.Duration) (context.Context, context.CancelFunc) {
	ctx := c.Context
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithTimeout(ctx, timeout)
}
