package connection

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// Resolved is never serialized: it contains private keys and bearer tokens.
type Resolved struct {
	ID            string
	Config        *rest.Config
	ContextName   string
	Namespace     string
	Timeout       time.Duration
	PrometheusURL string
}

func object(v any) map[string]any { m, _ := v.(map[string]any); return m }
func text(v any) string           { s, _ := v.(string); return s }

func boolean(values ...any) bool {
	for _, value := range values {
		if b, ok := value.(bool); ok {
			return b
		}
		if text(value) == "true" {
			return true
		}
	}
	return false
}

func ID(values map[string]any) string {
	id := text(values["connectionId"])
	if id == "" {
		id = text(object(values["connection"])["id"])
	}
	return id
}

// Resolve follows DBX's hydrated external_config / connection_secrets payload,
// with flat field support for protocol tests and older development hosts.
func Resolve(values map[string]any) (*Resolved, error) {
	conn := object(values["connection"])
	external := object(conn["external_config"])
	if external == nil {
		external = object(conn["config"])
	}
	if external == nil {
		if encoded := text(conn["config_json"]); encoded != "" {
			if err := json.Unmarshal([]byte(encoded), &external); err != nil {
				return nil, errors.New("invalid connection config_json")
			}
		}
	}
	get := func(key string) string {
		for _, source := range []map[string]any{external, conn, values} {
			if s := text(source[key]); s != "" {
				return s
			}
		}
		return ""
	}
	secrets := object(conn["connection_secrets"])
	secret := func(key string) string {
		if s := text(secrets[key]); s != "" {
			return s
		}
		// Do not read credentials from external_config or config_json.
		for _, source := range []map[string]any{conn, values} {
			if s := text(source[key]); s != "" {
				return s
			}
		}
		return ""
	}
	mode := get("auth_mode")
	if mode == "" {
		if secret("kubeconfig") != "" || get("kubeconfig_path") != "" || get("kubeconfigPath") != "" {
			mode = "kubeconfig"
		} else if secret("client_cert") != "" || secret("client_key") != "" {
			mode = "client_cert"
		} else {
			mode = "token"
		}
	}
	if mode != "kubeconfig" && mode != "token" && mode != "client_cert" {
		return nil, errors.New("auth_mode must be kubeconfig, token, or client_cert")
	}
	promURL := get("prometheusURL")
	if promURL == "" {
		promURL = get("prometheus_url")
	}
	promURL = strings.TrimSpace(promURL)
	if promURL != "" {
		u, err := url.Parse(promURL)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
			return nil, errors.New("prometheusURL must be an http(s) URL without credentials")
		}
		// The Prometheus client appends /api/v1/query and /api/v1/query_range.
		// Accept the commonly copied web UI path, but store only the server URL.
		if u.Path == "/query" || u.Path == "/api/v1/query" || u.Path == "/" {
			u.Path, u.RawPath, u.RawQuery, u.Fragment = "", "", "", ""
			promURL = strings.TrimRight(u.String(), "/")
		} else if u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return nil, errors.New("prometheusURL must be the Prometheus server URL")
		}
	}
	resolved := &Resolved{ID: ID(values), Namespace: get("namespace"), ContextName: get("context"), Timeout: 30 * time.Second, PrometheusURL: promURL}
	if seconds := get("timeout_s"); seconds != "" {
		n, err := strconv.Atoi(seconds)
		if err != nil || n < 1 || n > 300 {
			return nil, errors.New("timeout_s must be between 1 and 300")
		}
		resolved.Timeout = time.Duration(n) * time.Second
	} else if n, ok := external["timeout_s"].(float64); ok {
		if n < 1 || n > 300 || n != float64(int(n)) {
			return nil, errors.New("timeout_s must be between 1 and 300")
		}
		resolved.Timeout = time.Duration(n) * time.Second
	}
	path := get("kubeconfig_path")
	if path == "" {
		path = get("kubeconfigPath")
	}
	configText := ""
	if mode == "kubeconfig" {
		// A picked file is authoritative. This avoids silently using stale secret
		// content when the user changes the file in the connection form.
		if path == "" {
			configText = secret("kubeconfig")
		}
	}
	if mode == "kubeconfig" && (configText != "" || path != "") {
		var loader clientcmd.ClientConfig
		overrides := &clientcmd.ConfigOverrides{CurrentContext: resolved.ContextName}
		if resolved.Namespace != "" {
			overrides.Context.Namespace = resolved.Namespace
		}
		if configText != "" {
			loaded, err := clientcmd.Load([]byte(configText))
			if err != nil {
				return nil, errors.New("invalid kubeconfig YAML")
			}
			if resolved.ContextName == "" {
				resolved.ContextName = loaded.CurrentContext
			}
			loader = clientcmd.NewNonInteractiveClientConfig(*loaded, resolved.ContextName, overrides, nil)
		} else {
			if strings.HasPrefix(path, "~/") {
				home, err := os.UserHomeDir()
				if err != nil {
					return nil, err
				}
				path = filepath.Join(home, path[2:])
			}
			rules := &clientcmd.ClientConfigLoadingRules{ExplicitPath: path}
			loader = clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, overrides)
			raw, err := loader.RawConfig()
			if err != nil {
				return nil, fmt.Errorf("cannot load kubeconfig file: %w", err)
			}
			if resolved.ContextName == "" {
				resolved.ContextName = raw.CurrentContext
			}
		}
		cfg, err := loader.ClientConfig()
		if err != nil {
			return nil, fmt.Errorf("cannot resolve kubeconfig context: %w", err)
		}
		resolved.Config = cfg
		ns, _, err := loader.Namespace()
		if err != nil {
			return nil, err
		}
		resolved.Namespace = ns
	} else {
		if mode == "kubeconfig" {
			return nil, errors.New("provide kubeconfig or kubeconfig path")
		}
		server := get("server")
		if server == "" {
			server = get("host")
		}
		u, err := url.Parse(server)
		if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil {
			return nil, errors.New("server must be an http(s) URL without credentials")
		}
		token, cert, key := secret("token"), secret("client_cert"), secret("client_key")
		if (cert == "") != (key == "") {
			return nil, errors.New("client certificate and key must be supplied together")
		}
		if token == "" && cert == "" {
			return nil, errors.New("provide kubeconfig, bearer token, or client certificate and key")
		}
		resolved.Config = &rest.Config{Host: server, BearerToken: token, TLSClientConfig: rest.TLSClientConfig{CAData: []byte(secret("ca_cert")), CertData: []byte(cert), KeyData: []byte(key)}}
	}
	if resolved.Namespace == "" {
		resolved.Namespace = "default"
	}
	// Executable credential plugins require a separate opt-in: importing an
	// untrusted kubeconfig must not run local commands merely to test a connection.
	if resolved.Config.ExecProvider != nil && !boolean(external["allow_exec"], conn["allow_exec"], values["allow_exec"]) {
		return nil, errors.New("kubeconfig uses an executable credential plugin; enable allow_exec only for a trusted kubeconfig")
	}
	insecure := get("insecure_skip_tls_verify") == "true"
	if b, ok := external["insecure_skip_tls_verify"].(bool); ok {
		insecure = b
	}
	if insecure {
		resolved.Config.Insecure = true
		resolved.Config.CAData = nil
		resolved.Config.CAFile = ""
	}
	resolved.Config.Timeout = resolved.Timeout
	return resolved, nil
}
