package connection

import (
	"context"
	"errors"
	"sync"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
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
