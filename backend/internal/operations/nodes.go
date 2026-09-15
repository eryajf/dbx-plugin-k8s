package operations

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func cordon(ctx context.Context, c *kube.Client, r Request, unschedulable bool) (any, error) {
	node, err := c.Core.CoreV1().Nodes().Get(ctx, r.Name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	node.Spec.Unschedulable = unschedulable
	return c.Core.CoreV1().Nodes().Update(ctx, node, metav1.UpdateOptions{})
}

type DrainResult struct {
	Node     string   `json:"node"`
	Cordoned bool     `json:"cordoned"`
	Evicted  []string `json:"evicted"`
	Skipped  []string `json:"skipped"`
	Failures []string `json:"failures"`
	Complete bool     `json:"complete"`
}

// drainCandidate never treats force as permission to bypass disruption budgets.
func drainCandidate(p corev1.Pod, r Request) (bool, error) {
	if _, mirror := p.Annotations[corev1.MirrorPodAnnotationKey]; mirror {
		return false, nil
	}
	controller := metav1.GetControllerOf(&p)
	if controller != nil && controller.Kind == "DaemonSet" {
		if r.IgnoreDaemonSets {
			return false, nil
		}
		return false, fmt.Errorf("DaemonSet-managed Pod: enable ignoreDaemonSets to leave it running")
	}
	terminal := p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed
	if !terminal && controller == nil && !r.Force {
		return false, fmt.Errorf("Pod has no controller: force is required")
	}
	if !terminal && !r.DeleteLocalData {
		for _, v := range p.Spec.Volumes {
			if v.EmptyDir != nil {
				return false, fmt.Errorf("Pod uses emptyDir: deleteLocalData is required")
			}
		}
	}
	return true, nil
}

func drain(ctx context.Context, c *kube.Client, r Request) (any, error) {
	if r.TimeoutSeconds < 0 || r.TimeoutSeconds > 3600 {
		return nil, fmt.Errorf("timeoutSeconds must be between 0 and 3600")
	}
	if r.GracePeriod != nil && *r.GracePeriod < 0 {
		return nil, fmt.Errorf("gracePeriod must be nonnegative")
	}
	timeout := time.Duration(r.TimeoutSeconds) * time.Second
	if timeout == 0 {
		timeout = 5 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	result := &DrainResult{Node: r.Name, Evicted: []string{}, Skipped: []string{}, Failures: []string{}}
	pods, err := c.Core.CoreV1().Pods("").List(ctx, metav1.ListOptions{FieldSelector: "spec.nodeName=" + r.Name})
	if err != nil {
		return nil, err
	}
	candidates := make([]corev1.Pod, 0)
	for _, p := range pods.Items {
		// Also filter locally for API fakes and proxies that do not apply field selectors.
		if p.Spec.NodeName != r.Name {
			continue
		}
		ok, e := drainCandidate(p, r)
		ref := p.Namespace + "/" + p.Name
		if e != nil {
			result.Failures = append(result.Failures, ref+": "+e.Error())
		} else if ok {
			candidates = append(candidates, p)
		} else {
			result.Skipped = append(result.Skipped, ref)
		}
	}
	// Preflight is deliberately non-mutating. A blocked drain must not cordon or evict partially.
	if len(result.Failures) > 0 {
		return result, fmt.Errorf("drain blocked: %s", strings.Join(result.Failures, "; "))
	}
	if _, err = cordon(ctx, c, r, true); err != nil {
		return result, err
	}
	result.Cordoned = true
	for _, p := range candidates {
		ref := p.Namespace + "/" + p.Name
		if err = evictAndWait(ctx, c, p, r); err != nil {
			result.Failures = append(result.Failures, ref+": "+err.Error())
			return result, fmt.Errorf("drain stopped; node remains cordoned; evicted=%v, failed=%s: %w", result.Evicted, ref, err)
		}
		result.Evicted = append(result.Evicted, ref)
	}
	result.Complete = true
	return result, nil
}

func evictAndWait(ctx context.Context, c *kube.Client, p corev1.Pod, r Request) error {
	eviction := &policyv1.Eviction{ObjectMeta: metav1.ObjectMeta{Name: p.Name, Namespace: p.Namespace}, DeleteOptions: &metav1.DeleteOptions{GracePeriodSeconds: r.GracePeriod, Preconditions: &metav1.Preconditions{UID: &p.UID}}}
	for {
		err := c.Core.PolicyV1().Evictions(p.Namespace).Evict(ctx, eviction)
		if apierrors.IsNotFound(err) {
			return nil
		}
		if err == nil {
			break
		}
		if !apierrors.IsTooManyRequests(err) {
			return err
		}
		if err = pause(ctx); err != nil {
			return fmt.Errorf("waiting for disruption budget: %w", err)
		}
	}
	for {
		current, err := c.Core.CoreV1().Pods(p.Namespace).Get(ctx, p.Name, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if current.UID != p.UID {
			return nil
		}
		if err = pause(ctx); err != nil {
			return fmt.Errorf("waiting for Pod termination: %w", err)
		}
	}
}
func pause(ctx context.Context) error {
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
