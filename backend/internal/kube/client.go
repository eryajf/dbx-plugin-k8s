// Package kube owns Kubernetes clients and the lifetime shared by their streams.
package kube

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"time"

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
	BackgroundDynamic   dynamic.Interface
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
	discoveryEntries    map[string]discoveryEntry
	discoveryFlights    map[string]*discoveryFlight
	discoveryPreferred  map[string]string
	discoveryGeneration uint64
	discoveryClosed     bool
	Discovery           discovery.DiscoveryInterface
	searchCacheMu       sync.Mutex
	searchCache         *searchSnapshotCache
	searchIndexMu       sync.Mutex
	searchIndex         *SearchIndex
	searchIndexKey      string
}

// New leaves HTTP request timeouts to callers so exec/log/watch streams aren't
// disconnected after the ordinary request timeout.
func New(config *rest.Config, namespace, contextName string) (*Client, error) {
	cfg := rest.CopyConfig(config)
	cfg.Timeout = 0
	cfg.UserAgent = "dbx-plugin-k8s/0.1.35"
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
	discoveryHTTP := *transport
	discoveryHTTP.Transport = discoveryRetryTransport{base: transport.Transport}
	discoveryClient, err := discovery.NewDiscoveryClientForConfigAndClient(cfg, &discoveryHTTP)
	if err != nil {
		transport.CloseIdleConnections()
		return nil, err
	}
	backgroundConfig := rest.CopyConfig(cfg)
	backgroundConfig.QPS, backgroundConfig.Burst = rest.DefaultQPS, rest.DefaultBurst
	backgroundConfig.RateLimiter = nil
	background, err := dynamic.NewForConfigAndClient(backgroundConfig, transport)
	if err != nil {
		transport.CloseIdleConnections()
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{Core: core, Dynamic: dyn, BackgroundDynamic: background, Config: cfg, Context: ctx,
		Namespace: namespace, ContextName: contextName, cancel: cancel, httpClient: transport, Discovery: discoveryClient}, nil
}

func (c *Client) Close() {
	c.once.Do(func() {
		c.closeDiscoveryCache()
		c.ClearSearchResourceCache()
		c.SearchIndex().Close()
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

func (c *Client) RequestContext(timeout time.Duration) (context.Context, context.CancelFunc) {
	ctx := c.Context
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithTimeout(ctx, timeout)
}
