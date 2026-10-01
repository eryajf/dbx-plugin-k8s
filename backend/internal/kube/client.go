// Package kube owns Kubernetes clients and the lifetime shared by their streams.
package kube

import (
	"context"
	"net/http"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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
	discoveryErr        error
	discoveryFlight     *discoveryFlight
	discoveryGeneration uint64
	Discovery           discovery.DiscoveryInterface
	searchCacheMu       sync.Mutex
	searchCache         *searchSnapshotCache
}

// discoveryFlight contains the result owned by one in-flight discovery call.
// Keeping the result on the flight itself means waiters cannot accidentally
// observe a newer flight after an invalidation detaches the old one.
type discoveryFlight struct {
	done       chan struct{}
	lists      []*metav1.APIResourceList
	err        error
	generation uint64
}

const discoveryCacheTTL = 30 * time.Second

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

	lists, err = c.discoverResourceLists(ctx)
	c.discoveryMu.Lock()
	flight.lists, flight.err = lists, err
	if c.discoveryFlight == flight {
		// An invalidation increments the generation and detaches the old flight.
		// Such a result is still delivered to its original waiters, but must not
		// repopulate the cache used by later searches.
		if c.discoveryGeneration == flight.generation {
			c.discoveryLists = lists
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

func (c *Client) discoverResourceLists(ctx context.Context) ([]*metav1.APIResourceList, error) {
	if c.Discovery == nil {
		// Fake clients and older callers do not have a REST discovery client. Keep
		// this compatibility path; live clients are initialized with Discovery.
		// The legacy interface has no context parameter, so isolate it behind a
		// buffered result channel and still honor the caller's deadline.
		type result struct {
			lists []*metav1.APIResourceList
			err   error
		}
		results := make(chan result, 1)
		go func() {
			_, lists, err := c.Core.Discovery().ServerGroupsAndResources()
			results <- result{lists: lists, err: err}
		}()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case value := <-results:
			return value.lists, value.err
		}
	}
	legacy := c.Discovery.WithLegacy().RESTClient()
	var versions metav1.APIVersions
	if err := legacy.Get().AbsPath("/api").Do(ctx).Into(&versions); err != nil {
		return nil, err
	}
	lists := make([]*metav1.APIResourceList, 0, len(versions.Versions))
	for _, version := range versions.Versions {
		var list metav1.APIResourceList
		if err := legacy.Get().AbsPath("/api", version).Do(ctx).Into(&list); err != nil {
			return lists, err
		}
		lists = append(lists, &list)
	}
	var groups metav1.APIGroupList
	if err := legacy.Get().AbsPath("/apis").Do(ctx).Into(&groups); err != nil {
		return lists, err
	}
	for _, group := range groups.Groups {
		for _, version := range group.Versions {
			var list metav1.APIResourceList
			if err := legacy.Get().AbsPath("/apis", group.Name, version.Version).Do(ctx).Into(&list); err != nil {
				return lists, err
			}
			lists = append(lists, &list)
		}
	}
	return lists, nil
}

// New leaves HTTP request timeouts to callers so exec/log/watch streams aren't
// disconnected after the ordinary request timeout.
func New(config *rest.Config, namespace, contextName string) (*Client, error) {
	cfg := rest.CopyConfig(config)
	cfg.Timeout = 0
	cfg.UserAgent = "dbx-plugin-k8s/0.1.9"
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

func (c *Client) InvalidateDiscoveryCache() {
	c.discoveryMu.Lock()
	defer c.discoveryMu.Unlock()
	c.discoveryGeneration++
	c.discoveryAt = time.Time{}
	c.discoveryLists = nil
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
