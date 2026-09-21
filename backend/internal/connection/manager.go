package connection

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/prometheus"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/rest"
)

type Manager struct {
	mu      sync.RWMutex
	clients map[string]*kube.Client
}

func New() *Manager { return &Manager{clients: make(map[string]*kube.Client)} }
func (m *Manager) Get(id string) (*kube.Client, error) {
	if id == "" {
		return nil, errors.New("missing connectionId")
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	c := m.clients[id]
	if c == nil {
		return nil, errors.New("connection is not connected")
	}
	return c, nil
}

type Info struct {
	Success      bool   `json:"success"`
	ConnectionID string `json:"connectionId,omitempty"`
	Version      string `json:"version"`
	Platform     string `json:"platform"`
	Context      string `json:"context"`
	Namespace    string `json:"namespace"`
	Message      string `json:"message"`
}

func Probe(ctx context.Context, c *kube.Client) (*Info, error) {
	v, err := c.Core.Discovery().ServerVersion()
	if err != nil {
		return nil, err
	}
	return &Info{Success: true, Version: v.GitVersion, Platform: v.Platform, Context: c.ContextName, Namespace: c.Namespace, Message: "Kubernetes API reachable"}, nil
}

// Prepare does not publish failed connections to the shared registry.
func Prepare(values map[string]any) (*kube.Client, *Info, error) {
	r, err := Resolve(values)
	if err != nil {
		return nil, nil, err
	}
	c, err := kube.New(r.Config, r.Namespace, r.ContextName)
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := c.RequestContext(r.Timeout)
	defer cancel()
	promURL := r.PrometheusURL
	if promURL == "" {
		promURL = discoverPrometheusURL(ctx, c)
	}
	if promURL != "" {
		c.PrometheusURL = promURL

		rt := http.DefaultTransport
		if strings.Contains(promURL, ".svc.cluster.local") || strings.Contains(promURL, ".svc:") {
			if parsed, e := url.Parse(promURL); e == nil {
				if tr, e2 := restTransport(r.Config, parsed); e2 == nil {
					rt = tr
				}
			}
		}
		if pc, e := prometheus.NewClientWithRoundTripper(promURL, rt); e == nil {
			c.Prometheus = pc
			checkCtx, checkCancel := context.WithTimeout(ctx, 5*time.Second)
			c.PrometheusReachable = pc.HealthCheck(checkCtx) == nil
			checkCancel()
		}
	}
	info, err := Probe(ctx, c)
	if err != nil {
		c.Close()
		return nil, nil, err
	}
	info.ConnectionID = r.ID
	return c, info, nil
}

func (m *Manager) Put(id string, c *kube.Client) {
	m.mu.Lock()
	old := m.clients[id]
	m.clients[id] = c
	m.mu.Unlock()
	if old != nil {
		old.Close()
	}
}
func (m *Manager) Remove(id string) {
	m.mu.Lock()
	c := m.clients[id]
	delete(m.clients, id)
	m.mu.Unlock()
	if c != nil {
		c.Close()
	}
}
func (m *Manager) Close() {
	m.mu.Lock()
	old := m.clients
	m.clients = make(map[string]*kube.Client)
	m.mu.Unlock()
	for _, c := range old {
		c.Close()
	}
}

// restTransport routes cluster-local Prometheus traffic through the Kubernetes API server.
type proxyTransport struct {
	transport                             http.RoundTripper
	api, namespace, service, scheme, port string
}

func (t *proxyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	u := *req.URL
	u.Scheme = t.scheme
	if u.Scheme == "" {
		u.Scheme = "https"
	}
	u.Host = t.api
	u.Path = "/api/v1/namespaces/" + t.namespace + "/services/" + t.service + ":" + t.port + "/proxy" + req.URL.Path
	if req.URL.RawQuery != "" {
		u.RawQuery = req.URL.RawQuery
	}
	r := req.Clone(req.Context())
	r.URL = &u
	return t.transport.RoundTrip(r)
}

func (t *proxyTransport) CloseIdleConnections() {
	if closer, ok := t.transport.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

func restTransport(cfg *rest.Config, parsed *url.URL) (http.RoundTripper, error) {
	tr, e := rest.TransportFor(cfg)
	if e != nil {
		return nil, e
	}
	host := strings.Split(parsed.Hostname(), ".")
	if len(host) < 2 {
		return nil, fmt.Errorf("invalid cluster local prometheus URL")
	}
	apiURL, e := url.Parse(cfg.Host)
	if e != nil || apiURL.Host == "" {
		return nil, fmt.Errorf("invalid Kubernetes API server URL")
	}
	port := parsed.Port()
	if port == "" {
		if parsed.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return &proxyTransport{transport: tr, api: apiURL.Host, namespace: host[1], service: host[0], scheme: apiURL.Scheme, port: port}, nil
}

func discoverPrometheusURL(ctx context.Context, c *kube.Client) string {
	labels := []map[string]string{{"app.kubernetes.io/instance": "prometheus"}, {"app.kubernetes.io/name": "prometheus"}, {"app.kubernetes.io/part-of": "kube-prometheus-stack"}, {"app.kubernetes.io/name": "vmsingle"}}
	for _, label := range labels {
		list, err := c.Core.CoreV1().Services("").List(ctx, metav1.ListOptions{LabelSelector: labelsToSelector(label)})
		if err != nil {
			continue
		}
		for _, svc := range list.Items {
			if svc.Spec.Type != corev1.ServiceTypeClusterIP && svc.Spec.Type != corev1.ServiceTypeLoadBalancer {
				continue
			}
			if len(svc.Spec.Ports) > 0 {
				return fmt.Sprintf("http://%s.%s.svc.cluster.local:%d", svc.Name, svc.Namespace, svc.Spec.Ports[0].Port)
			}
		}
	}
	return ""
}
func labelsToSelector(m map[string]string) string {
	for k, v := range m {
		return k + "=" + v
	}
	return ""
}
