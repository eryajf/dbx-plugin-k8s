// Package kube owns Kubernetes clients and the lifetime shared by their streams.
package kube

import (
	"context"
	"net/http"
	"sync"
	"time"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

type Client struct {
	Core        kubernetes.Interface
	Dynamic     dynamic.Interface
	Config      *rest.Config
	Context     context.Context
	Namespace   string
	ContextName string
	cancel      context.CancelFunc
	once        sync.Once
	httpClient  *http.Client
}

// New leaves HTTP request timeouts to callers so exec/log/watch streams aren't
// disconnected after the ordinary request timeout.
func New(config *rest.Config, namespace, contextName string) (*Client, error) {
	cfg := rest.CopyConfig(config)
	cfg.Timeout = 0
	cfg.UserAgent = "dbx-plugin-k8s/0.1.0"
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
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{Core: core, Dynamic: dyn, Config: cfg, Context: ctx,
		Namespace: namespace, ContextName: contextName, cancel: cancel, httpClient: transport}, nil
}

func (c *Client) Close() {
	c.once.Do(func() {
		if c.cancel != nil {
			c.cancel()
		}
		if c.httpClient != nil {
			c.httpClient.CloseIdleConnections()
		}
	})
}

func (c *Client) RequestContext(timeout time.Duration) (context.Context, context.CancelFunc) {
	ctx := c.Context
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithTimeout(ctx, timeout)
}
