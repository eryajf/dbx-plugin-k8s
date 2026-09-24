package connection

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
	"k8s.io/client-go/transport/spdy"
)

func TestRuntimeProxyRoutesKubeconfigEndpointAndPreservesTLSName(t *testing.T) {
	sni := make(chan string, 1)
	requestHost := make(chan string, 1)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestHost <- r.Host
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
	}))
	server.TLS = &tls.Config{GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
		sni <- hello.ServerName
		return nil, nil
	}}
	server.StartTLS()
	defer server.Close()

	proxyHost, target, proxyErrors := startSocks5TestProxy(t, "", "", server.Listener.Addr().String())
	proxyName, proxyPortString, err := net.SplitHostPort(proxyHost)
	if err != nil {
		t.Fatal(err)
	}
	proxyPort, err := strconv.Atoi(proxyPortString)
	if err != nil {
		t.Fatal(err)
	}
	kubeconfig := strings.Replace(sampleConfig, "server: https://cluster.example", "server: https://api.cluster.example:6443\n    insecure-skip-tls-verify: true", 1)
	resolved, err := Resolve(map[string]any{
		"connection": map[string]any{
			"external_config":    map[string]any{"auth_mode": "kubeconfig"},
			"connection_secrets": map[string]any{"kubeconfig": kubeconfig},
			"transport_layers":   []any{map[string]any{"type": "ssh", "enabled": true}},
		},
		"runtime": map[string]any{"proxy": map[string]any{
			"type": "socks5", "host": proxyName, "port": proxyPort,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Config.Host != "https://api.cluster.example:6443" {
		t.Fatalf("API server host changed: %q", resolved.Config.Host)
	}
	client, err := rest.HTTPClientFor(resolved.Config)
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, resolved.Config.Host+"/version", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(req)
	if err != nil {
		select {
		case proxyErr := <-proxyErrors:
			t.Fatalf("SOCKS5 proxy failed: %v (request: %v)", proxyErr, err)
		default:
			t.Fatal(err)
		}
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || string(body) != "ok" {
		t.Fatalf("unexpected API response: status=%d body=%q", response.StatusCode, body)
	}
	if got := receiveTestValue(t, target); got != "api.cluster.example:6443" {
		t.Fatalf("SOCKS5 target changed: %q", got)
	}
	if got := receiveTestValue(t, sni); got != "api.cluster.example" {
		t.Fatalf("TLS SNI changed: %q", got)
	}
	if got := receiveTestValue(t, requestHost); got != "api.cluster.example:6443" {
		t.Fatalf("HTTP Host header changed: %q", got)
	}
}

func TestRuntimeProxySupportsCredentials(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "authenticated")
	}))
	defer server.Close()
	proxyHost, target, proxyErrors := startSocks5TestProxy(t, "proxy-user", "proxy-password", server.Listener.Addr().String())
	proxyName, proxyPortString, err := net.SplitHostPort(proxyHost)
	if err != nil {
		t.Fatal(err)
	}
	proxyPort, err := strconv.Atoi(proxyPortString)
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := Resolve(map[string]any{
		"connection": map[string]any{
			"external_config":    map[string]any{"auth_mode": "kubeconfig"},
			"connection_secrets": map[string]any{"kubeconfig": sampleConfig},
			"transport_layers":   []any{map[string]any{"type": "proxy", "enabled": true}},
		},
		"runtime": map[string]any{"proxy": map[string]any{
			"type": "socks5", "host": proxyName, "port": proxyPort,
			"username": "proxy-user", "password": "proxy-password",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	resolved.Config.Host = "http://api.cluster.example:6443"
	client, err := rest.HTTPClientFor(resolved.Config)
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()
	response, err := client.Get(resolved.Config.Host + "/version")
	if err != nil {
		select {
		case proxyErr := <-proxyErrors:
			t.Fatalf("SOCKS5 authentication failed: %v (request: %v)", proxyErr, err)
		default:
			t.Fatal(err)
		}
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "authenticated" {
		t.Fatalf("unexpected authenticated response: %q", body)
	}
	if got := receiveTestValue(t, target); got != "api.cluster.example:6443" {
		t.Fatalf("SOCKS5 target changed: %q", got)
	}
}

func TestRuntimeProxyRoutesSPDYStreams(t *testing.T) {
	requests := make(chan string, 2)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- r.Method + " " + r.URL.Path
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, "upgrade rejected")
	}))
	defer server.Close()
	for _, testCase := range []struct {
		name string
		path string
		run  func(*rest.Config, *url.URL) error
	}{
		{
			name: "exec",
			path: "/api/v1/namespaces/default/pods/test/exec",
			run: func(config *rest.Config, targetURL *url.URL) error {
				executor, err := remotecommand.NewSPDYExecutor(config, http.MethodPost, targetURL)
				if err != nil {
					return err
				}
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				return executor.StreamWithContext(ctx, remotecommand.StreamOptions{})
			},
		},
		{
			name: "port forward",
			path: "/api/v1/namespaces/default/pods/test/portforward",
			run: func(config *rest.Config, targetURL *url.URL) error {
				transport, upgrader, err := spdy.RoundTripperFor(config)
				if err != nil {
					return err
				}
				dialer := spdy.NewDialer(upgrader, &http.Client{Transport: transport, Timeout: 3 * time.Second}, http.MethodPost, targetURL)
				_, _, err = dialer.Dial("portforward.k8s.io")
				return err
			},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			proxyHost, target, proxyErrors := startSocks5TestProxy(t, "", "", server.Listener.Addr().String())
			proxyName, proxyPortString, err := net.SplitHostPort(proxyHost)
			if err != nil {
				t.Fatal(err)
			}
			proxyPort, err := strconv.Atoi(proxyPortString)
			if err != nil {
				t.Fatal(err)
			}
			kubeconfig := strings.Replace(sampleConfig, "server: https://cluster.example", "server: https://api.cluster.example:6443\n    insecure-skip-tls-verify: true", 1)
			resolved, err := Resolve(map[string]any{
				"connection": map[string]any{
					"external_config":    map[string]any{"auth_mode": "kubeconfig"},
					"connection_secrets": map[string]any{"kubeconfig": kubeconfig},
					"transport_layers":   []any{map[string]any{"type": "ssh", "enabled": true}},
				},
				"runtime": map[string]any{"proxy": map[string]any{
					"type": "socks5", "host": proxyName, "port": proxyPort,
				}},
			})
			if err != nil {
				t.Fatal(err)
			}
			streamURL, err := url.Parse(resolved.Config.Host + testCase.path)
			if err != nil {
				t.Fatal(err)
			}
			if err := testCase.run(resolved.Config, streamURL); err == nil || !strings.Contains(err.Error(), "upgrade rejected") {
				t.Fatalf("expected the test server to reject the SPDY upgrade, got %v", err)
			}
			if got := receiveTestValue(t, target); got != "api.cluster.example:6443" {
				t.Fatalf("SPDY target changed: %q", got)
			}
			if got := receiveTestValue(t, requests); got != http.MethodPost+" "+testCase.path {
				t.Fatalf("unexpected SPDY request: %q", got)
			}
			select {
			case proxyErr := <-proxyErrors:
				t.Fatalf("SOCKS5 proxy failed for SPDY stream: %v", proxyErr)
			default:
			}
		})
	}
}

func TestRuntimeProxyRejectsMissingOrInvalidRoutes(t *testing.T) {
	activeLayer := []any{map[string]any{"type": "ssh", "enabled": true}}
	base := func(layers []any, route any) map[string]any {
		connection := map[string]any{
			"external_config":    map[string]any{"auth_mode": "kubeconfig"},
			"connection_secrets": map[string]any{"kubeconfig": sampleConfig},
		}
		if layers != nil {
			connection["transport_layers"] = layers
		}
		values := map[string]any{"connection": connection}
		if route != nil {
			values["runtime"] = map[string]any{"proxy": route}
		}
		return values
	}
	cases := []struct {
		name   string
		values map[string]any
	}{
		{name: "active layer without route", values: base(activeLayer, nil)},
		{name: "wrong route type", values: base(activeLayer, map[string]any{"type": "http", "host": "127.0.0.1", "port": 1080})},
		{name: "missing endpoint", values: base(activeLayer, map[string]any{"type": "socks5", "host": "", "port": 1080})},
		{name: "invalid port", values: base(activeLayer, map[string]any{"type": "socks5", "host": "127.0.0.1", "port": 65536})},
		{name: "partial credentials", values: base(activeLayer, map[string]any{"type": "socks5", "host": "127.0.0.1", "port": 1080, "username": "user"})},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := Resolve(testCase.values); err == nil {
				t.Fatal("expected route configuration to be rejected")
			}
		})
	}

	resolved, err := Resolve(base([]any{map[string]any{"type": "ssh", "enabled": false}}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Config.Dial != nil || resolved.Config.Proxy != nil {
		t.Fatal("disabled transport layer unexpectedly configured a proxy")
	}
	if _, err := Resolve(base(activeLayer, "invalid")); err == nil {
		t.Fatal("expected malformed runtime proxy to be rejected")
	}
}

func startSocks5TestProxy(t *testing.T, username, password, upstream string) (string, <-chan string, <-chan error) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	target := make(chan string, 1)
	proxyErrors := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			if !errors.Is(err, net.ErrClosed) {
				proxyErrors <- err
			}
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		reader := bufio.NewReader(conn)
		var greeting [2]byte
		if _, err := io.ReadFull(reader, greeting[:]); err != nil {
			proxyErrors <- err
			return
		}
		methods := make([]byte, int(greeting[1]))
		if _, err := io.ReadFull(reader, methods); err != nil {
			proxyErrors <- err
			return
		}
		method := byte(0)
		if username != "" {
			method = 2
		}
		found := false
		for _, offered := range methods {
			if offered == method {
				found = true
				break
			}
		}
		if !found {
			proxyErrors <- errors.New("expected SOCKS5 authentication method was not offered")
			return
		}
		if _, err := conn.Write([]byte{5, method}); err != nil {
			proxyErrors <- err
			return
		}
		if method == 2 {
			var authHeader [2]byte
			if _, err := io.ReadFull(reader, authHeader[:]); err != nil {
				proxyErrors <- err
				return
			}
			user := make([]byte, int(authHeader[1]))
			if _, err := io.ReadFull(reader, user); err != nil {
				proxyErrors <- err
				return
			}
			var passwordLength [1]byte
			if _, err := io.ReadFull(reader, passwordLength[:]); err != nil {
				proxyErrors <- err
				return
			}
			pass := make([]byte, int(passwordLength[0]))
			if _, err := io.ReadFull(reader, pass); err != nil {
				proxyErrors <- err
				return
			}
			if authHeader[0] != 1 || string(user) != username || string(pass) != password {
				proxyErrors <- errors.New("SOCKS5 credentials did not match")
				return
			}
			if _, err := conn.Write([]byte{1, 0}); err != nil {
				proxyErrors <- err
				return
			}
		}
		var request [4]byte
		if _, err := io.ReadFull(reader, request[:]); err != nil {
			proxyErrors <- err
			return
		}
		if request[0] != 5 || request[1] != 1 {
			proxyErrors <- errors.New("unexpected SOCKS5 request")
			return
		}
		var targetHost string
		switch request[3] {
		case 1:
			address := make([]byte, net.IPv4len)
			if _, err := io.ReadFull(reader, address); err != nil {
				proxyErrors <- err
				return
			}
			targetHost = net.IP(address).String()
		case 3:
			var length [1]byte
			if _, err := io.ReadFull(reader, length[:]); err != nil {
				proxyErrors <- err
				return
			}
			address := make([]byte, int(length[0]))
			if _, err := io.ReadFull(reader, address); err != nil {
				proxyErrors <- err
				return
			}
			targetHost = string(address)
		case 4:
			address := make([]byte, net.IPv6len)
			if _, err := io.ReadFull(reader, address); err != nil {
				proxyErrors <- err
				return
			}
			targetHost = net.IP(address).String()
		default:
			proxyErrors <- errors.New("unsupported SOCKS5 address type")
			return
		}
		var portBytes [2]byte
		if _, err := io.ReadFull(reader, portBytes[:]); err != nil {
			proxyErrors <- err
			return
		}
		target <- net.JoinHostPort(targetHost, strconv.Itoa(int(binary.BigEndian.Uint16(portBytes[:]))))

		var remote net.Conn
		if upstream != "" {
			remote, err = net.Dial("tcp", upstream)
			if err != nil {
				proxyErrors <- err
				return
			}
			defer remote.Close()
		}
		if _, err := conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}); err != nil {
			proxyErrors <- err
			return
		}
		_ = conn.SetDeadline(time.Time{})
		if remote != nil {
			go func() {
				_, _ = io.Copy(remote, conn)
				_ = remote.Close()
			}()
			_, _ = io.Copy(conn, remote)
		}
	}()
	return listener.Addr().String(), target, proxyErrors
}

func receiveTestValue[T any](t *testing.T, values <-chan T) T {
	t.Helper()
	select {
	case value := <-values:
		return value
	case <-time.After(3 * time.Second):
		var zero T
		t.Fatal("timed out waiting for proxy result")
		return zero
	}
}
