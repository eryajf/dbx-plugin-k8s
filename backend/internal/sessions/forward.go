package sessions

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	core "k8s.io/api/core/v1"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/tools/portforward"
	"k8s.io/client-go/transport/spdy"
)

// Ports use kubectl's local:remote notation. Local zero requests a free port;
// remote ports on Services are translated to their selected Pod target ports.
func (m *Manager) forward(ctx context.Context, c *kube.Client, connection string, raw json.RawMessage) (any, error) {
	var p struct {
		Namespace string   `json:"namespace"`
		Name      string   `json:"name"`
		Resource  string   `json:"resource"`
		Ports     []string `json:"ports"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if p.Namespace == "" || p.Name == "" || len(p.Ports) == 0 || len(p.Ports) > 16 {
		return nil, fmt.Errorf("namespace, name and 1–16 ports required")
	}
	if p.Resource == "" {
		p.Resource = "pods"
	}
	var pod *core.Pod
	var service *core.Service
	switch p.Resource {
	case "pods", "pod":
		v, e := c.Core.CoreV1().Pods(p.Namespace).Get(ctx, p.Name, meta.GetOptions{})
		if e != nil {
			return nil, e
		}
		pod = v
	case "services", "service", "deployments", "deployment":
		var selector string
		if p.Resource == "services" || p.Resource == "service" {
			v, e := c.Core.CoreV1().Services(p.Namespace).Get(ctx, p.Name, meta.GetOptions{})
			if e != nil {
				return nil, e
			}
			service = v
			if len(v.Spec.Selector) == 0 {
				return nil, fmt.Errorf("service has no Pod selector")
			}
			selector = labels.SelectorFromSet(v.Spec.Selector).String()
		} else {
			v, e := c.Core.AppsV1().Deployments(p.Namespace).Get(ctx, p.Name, meta.GetOptions{})
			if e != nil {
				return nil, e
			}
			sel, e := meta.LabelSelectorAsSelector(v.Spec.Selector)
			if e != nil {
				return nil, e
			}
			selector = sel.String()
			if selector == "" {
				return nil, fmt.Errorf("deployment has no Pod selector")
			}
		}
		list, e := c.Core.CoreV1().Pods(p.Namespace).List(ctx, meta.ListOptions{LabelSelector: selector})
		if e != nil {
			return nil, e
		}
		for i := range list.Items {
			candidate := &list.Items[i]
			if candidate.Status.Phase == core.PodRunning && candidate.DeletionTimestamp == nil {
				pod = candidate
				break
			}
		}
		if pod == nil {
			return nil, fmt.Errorf("no running Pod matches resource")
		}
	default:
		return nil, fmt.Errorf("port forwarding supports pods, services and deployments")
	}
	if pod.Status.Phase != core.PodRunning {
		return nil, fmt.Errorf("Pod is not running")
	}
	ports := make([]string, 0, len(p.Ports))
	for _, spec := range p.Ports {
		parts := strings.Split(spec, ":")
		if len(parts) > 2 {
			return nil, fmt.Errorf("invalid port %q", spec)
		}
		local := 0
		remoteText := parts[0]
		if len(parts) == 2 {
			n, e := strconv.Atoi(parts[0])
			if e != nil || n < 0 || n > 65535 {
				return nil, fmt.Errorf("invalid local port")
			}
			local = n
			remoteText = parts[1]
		}
		remote, e := strconv.Atoi(remoteText)
		if e != nil || remote < 1 || remote > 65535 {
			return nil, fmt.Errorf("invalid remote port")
		}
		if service != nil {
			found := false
			for _, servicePort := range service.Spec.Ports {
				if int(servicePort.Port) != remote {
					continue
				}
				if servicePort.Protocol != core.ProtocolTCP {
					return nil, fmt.Errorf("port forwarding requires TCP")
				}
				found = true
				if servicePort.TargetPort.Type == intstr.String {
					target := 0
					for _, container := range pod.Spec.Containers {
						for _, port := range container.Ports {
							if port.Name == servicePort.TargetPort.StrVal {
								target = int(port.ContainerPort)
							}
						}
					}
					if target == 0 {
						return nil, fmt.Errorf("named service target port not found")
					}
					remote = target
				} else if servicePort.TargetPort.IntVal != 0 {
					remote = int(servicePort.TargetPort.IntVal)
				}
				break
			}
			if !found {
				return nil, fmt.Errorf("service port %d not found", remote)
			}
		}
		ports = append(ports, fmt.Sprintf("%d:%d", local, remote))
	}
	client, cfg, e := streamCore(c)
	if e != nil {
		return nil, e
	}
	transport, upgrader, e := spdy.RoundTripperFor(cfg)
	if e != nil {
		return nil, e
	}
	url := client.CoreV1().RESTClient().Post().Resource("pods").Namespace(p.Namespace).Name(pod.Name).SubResource("portforward").URL()
	dialer := spdy.NewDialer(upgrader, &http.Client{Transport: transport, Timeout: 30 * time.Second}, http.MethodPost, url)
	s, e := m.open(c.Context, connection, "port-forward")
	if e != nil {
		return nil, e
	}
	ready := make(chan struct{})
	forwarder, e := portforward.NewOnAddresses(dialer, []string{"127.0.0.1"}, ports, s.ctx.Done(), ready, s, s)
	if e != nil {
		m.remove(connection, s.id)
		return nil, e
	}
	done := make(chan error, 1)
	go func() { err := forwarder.ForwardPorts(); s.finish(err); done <- err }()
	go func() {
		select {
		case <-s.ctx.Done():
			return
		case <-ready:
			bound, err := forwarder.GetPorts()
			if err != nil {
				s.finish(err)
				return
			}
			s.mu.Lock()
			s.ready = true
			s.ports = bound
			s.mu.Unlock()
		}
	}()
	// Wait briefly so callers normally get actual bound ports; slow handshakes can
	// be observed through port-forward/list without tying lifetime to this RPC.
	select {
	case <-ready:
		bound, err := forwarder.GetPorts()
		if err != nil {
			return nil, err
		}
		s.mu.Lock()
		s.ready = true
		s.ports = bound
		s.mu.Unlock()
		return s.read(), nil
	case err := <-done:
		if err != nil {
			return s.read(), nil
		}
		return s.read(), nil
	case <-time.After(2 * time.Second):
		return s.read(), nil
	case <-ctx.Done():
		return map[string]string{"sessionId": s.id}, nil
	}
}
