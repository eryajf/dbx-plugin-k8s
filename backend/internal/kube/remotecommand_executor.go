package kube

import (
	"net/url"

	"k8s.io/apimachinery/pkg/util/httpstream"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

var (
	newSPDYExecutor      = remotecommand.NewSPDYExecutor
	newWebSocketExecutor = remotecommand.NewWebSocketExecutor
	newFallbackExecutor  = remotecommand.NewFallbackExecutor
)

// NewRemoteCommandExecutor prefers SPDY and falls back to the Kubernetes
// WebSocket stream when a proxy or API server rejects the SPDY upgrade.
func NewRemoteCommandExecutor(config *rest.Config, targetURL *url.URL) (remotecommand.Executor, error) {
	spdy, err := newSPDYExecutor(config, "POST", targetURL)
	if err != nil {
		return nil, err
	}
	websocket, err := newWebSocketExecutor(config, "GET", targetURL.String())
	if err != nil {
		return nil, err
	}
	return newFallbackExecutor(spdy, websocket, func(err error) bool {
		return httpstream.IsUpgradeFailure(err)
	})
}
