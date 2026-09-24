package connection

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"k8s.io/client-go/rest"
)

type runtimeProxyConfig struct {
	Type     string `json:"type"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

func applyRuntimeProxy(values map[string]any, config *rest.Config) error {
	connection := object(values["connection"])
	activeLayers, err := hasActiveTransportLayers(connection["transport_layers"])
	if err != nil {
		return err
	}

	runtime := object(values["runtime"])
	rawProxy, hasProxy := runtime["proxy"]
	if !hasProxy {
		if activeLayers {
			return errors.New("DBX transport layers require a runtime SOCKS5 proxy route; refusing a direct connection")
		}
		return nil
	}
	if rawProxy == nil {
		return errors.New("invalid DBX runtime SOCKS5 proxy route")
	}
	if _, ok := rawProxy.(map[string]any); !ok {
		return errors.New("invalid DBX runtime SOCKS5 proxy route")
	}
	payload, err := json.Marshal(rawProxy)
	if err != nil {
		return errors.New("invalid DBX runtime SOCKS5 proxy route")
	}
	var route runtimeProxyConfig
	if err := json.Unmarshal(payload, &route); err != nil {
		return errors.New("invalid DBX runtime SOCKS5 proxy route")
	}
	if route.Type != "socks5" {
		return errors.New("DBX runtime proxy route must use SOCKS5")
	}
	rawHost := strings.TrimSpace(route.Host)
	host := rawHost
	if strings.HasPrefix(host, "[") || strings.HasSuffix(host, "]") {
		if !strings.HasPrefix(host, "[") || !strings.HasSuffix(host, "]") {
			return errors.New("invalid DBX runtime SOCKS5 proxy host")
		}
		host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
		if net.ParseIP(host) == nil {
			return errors.New("invalid DBX runtime SOCKS5 proxy host")
		}
	}
	if host == "" || rawHost != route.Host || strings.ContainsAny(host, "/@?#\\ \t\r\n") || (strings.Contains(host, ":") && net.ParseIP(host) == nil) {
		return errors.New("invalid DBX runtime SOCKS5 proxy host")
	}
	if route.Port < 1 || route.Port > 65535 {
		return errors.New("invalid DBX runtime SOCKS5 proxy port")
	}
	if (route.Username == "") != (route.Password == "") || len(route.Username) > 255 || len(route.Password) > 255 {
		return errors.New("invalid DBX runtime SOCKS5 proxy credentials")
	}

	proxyURL := &url.URL{
		Scheme: "socks5",
		Host:   net.JoinHostPort(host, strconv.Itoa(route.Port)),
	}
	if route.Username != "" {
		proxyURL.User = url.UserPassword(route.Username, route.Password)
	}
	config.Proxy = http.ProxyURL(proxyURL)
	return nil
}

func hasActiveTransportLayers(value any) (bool, error) {
	if value == nil {
		return false, nil
	}
	layers, ok := value.([]any)
	if !ok {
		return false, errors.New("invalid DBX connection transport layers")
	}
	for _, value := range layers {
		layer, ok := value.(map[string]any)
		if !ok {
			return false, errors.New("invalid DBX connection transport layer")
		}
		if enabled, exists := layer["enabled"]; exists {
			isEnabled, ok := enabled.(bool)
			if !ok {
				return false, errors.New("invalid DBX connection transport layer")
			}
			if !isEnabled {
				continue
			}
		}
		return true, nil
	}
	return false, nil
}
