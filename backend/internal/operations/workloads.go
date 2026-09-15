package operations

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	appsv1 "k8s.io/api/apps/v1"
	autoscalingv1 "k8s.io/api/autoscaling/v1"
	batchv1 "k8s.io/api/batch/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
)

func restart(ctx context.Context, c *kube.Client, r Request) (any, error) {
	patch, _ := json.Marshal(map[string]any{"spec": map[string]any{"template": map[string]any{"metadata": map[string]any{"annotations": map[string]string{"kubectl.kubernetes.io/restartedAt": time.Now().UTC().Format(time.RFC3339Nano)}}}}})
	switch r.Resource {
	case "deployments":
		return c.Core.AppsV1().Deployments(r.Namespace).Patch(ctx, r.Name, types.MergePatchType, patch, metav1.PatchOptions{})
	case "statefulsets":
		return c.Core.AppsV1().StatefulSets(r.Namespace).Patch(ctx, r.Name, types.MergePatchType, patch, metav1.PatchOptions{})
	case "daemonsets":
		return c.Core.AppsV1().DaemonSets(r.Namespace).Patch(ctx, r.Name, types.MergePatchType, patch, metav1.PatchOptions{})
	default:
		return nil, fmt.Errorf("restart supports deployments, statefulsets and daemonsets")
	}
}

func scale(ctx context.Context, c *kube.Client, r Request) (any, error) {
	if r.Replicas == nil || *r.Replicas < 0 {
		return nil, fmt.Errorf("replicas must be a nonnegative integer")
	}
	var current *autoscalingv1.Scale
	var err error
	switch r.Resource {
	case "deployments":
		current, err = c.Core.AppsV1().Deployments(r.Namespace).GetScale(ctx, r.Name, metav1.GetOptions{})
	case "statefulsets":
		current, err = c.Core.AppsV1().StatefulSets(r.Namespace).GetScale(ctx, r.Name, metav1.GetOptions{})
	case "replicasets":
		current, err = c.Core.AppsV1().ReplicaSets(r.Namespace).GetScale(ctx, r.Name, metav1.GetOptions{})
	default:
		return nil, fmt.Errorf("scale supports deployments, statefulsets and replicasets; daemonsets cannot be scaled")
	}
	if err != nil {
		return nil, err
	}
	if r.ResourceVersion != "" && r.ResourceVersion != current.ResourceVersion {
		return nil, apierrors.NewConflict(schema.GroupResource{Group: "apps", Resource: r.Resource}, r.Name, fmt.Errorf("scale resourceVersion changed"))
	}
	current.Spec.Replicas = *r.Replicas
	switch r.Resource {
	case "deployments":
		return c.Core.AppsV1().Deployments(r.Namespace).UpdateScale(ctx, r.Name, current, metav1.UpdateOptions{})
	case "statefulsets":
		return c.Core.AppsV1().StatefulSets(r.Namespace).UpdateScale(ctx, r.Name, current, metav1.UpdateOptions{})
	default:
		return c.Core.AppsV1().ReplicaSets(r.Namespace).UpdateScale(ctx, r.Name, current, metav1.UpdateOptions{})
	}
}

func ownedHistory(ctx context.Context, c *kube.Client, r Request) (*appsv1.Deployment, []appsv1.ReplicaSet, error) {
	if r.Resource != "" && r.Resource != "deployments" {
		return nil, nil, fmt.Errorf("history and rollback support deployments only")
	}
	d, err := c.Core.AppsV1().Deployments(r.Namespace).Get(ctx, r.Name, metav1.GetOptions{})
	if err != nil {
		return nil, nil, err
	}
	list, err := c.Core.AppsV1().ReplicaSets(r.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, nil, err
	}
	items := make([]appsv1.ReplicaSet, 0)
	for _, rs := range list.Items {
		for _, o := range rs.OwnerReferences {
			if o.UID == d.UID && o.Kind == "Deployment" && o.Controller != nil && *o.Controller {
				items = append(items, rs)
				break
			}
		}
	}
	sort.Slice(items, func(i, j int) bool {
		a, _ := strconv.Atoi(items[i].Annotations["deployment.kubernetes.io/revision"])
		b, _ := strconv.Atoi(items[j].Annotations["deployment.kubernetes.io/revision"])
		return a > b
	})
	return d, items, nil
}
func history(ctx context.Context, c *kube.Client, r Request) (any, error) {
	d, items, err := ownedHistory(ctx, c, r)
	if err != nil {
		return nil, err
	}
	return map[string]any{"resourceVersion": d.ResourceVersion, "items": items}, nil
}
func rollback(ctx context.Context, c *kube.Client, r Request) (any, error) {
	n, err := strconv.Atoi(r.Revision)
	if err != nil || n <= 0 || r.ResourceVersion == "" {
		return nil, fmt.Errorf("rollback requires a positive revision and deployment resourceVersion from history")
	}
	d, items, err := ownedHistory(ctx, c, r)
	if err != nil {
		return nil, err
	}
	if d.ResourceVersion != r.ResourceVersion {
		return nil, apierrors.NewConflict(schema.GroupResource{Group: "apps", Resource: "deployments"}, r.Name, fmt.Errorf("deployment changed since history was loaded"))
	}
	var target *appsv1.ReplicaSet
	for i := range items {
		if items[i].Annotations["deployment.kubernetes.io/revision"] == r.Revision {
			if target != nil {
				return nil, fmt.Errorf("multiple ReplicaSets have revision %s", r.Revision)
			}
			target = &items[i]
		}
	}
	if target == nil {
		return nil, fmt.Errorf("owned ReplicaSet revision %s is unavailable", r.Revision)
	}
	d.Spec.Template = *target.Spec.Template.DeepCopy()
	delete(d.Spec.Template.Labels, "pod-template-hash")
	return c.Core.AppsV1().Deployments(r.Namespace).Update(ctx, d, metav1.UpdateOptions{})
}
func trigger(ctx context.Context, c *kube.Client, r Request) (any, error) {
	cj, err := c.Core.BatchV1().CronJobs(r.Namespace).Get(ctx, r.Name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	prefix := cj.Name
	if len(prefix) > 50 {
		prefix = prefix[:50]
	}
	job := &batchv1.Job{ObjectMeta: *cj.Spec.JobTemplate.ObjectMeta.DeepCopy(), Spec: *cj.Spec.JobTemplate.Spec.DeepCopy()}
	job.Name = ""
	job.GenerateName = prefix + "-manual-"
	job.Namespace = r.Namespace
	job.ResourceVersion = ""
	job.UID = ""
	job.OwnerReferences = []metav1.OwnerReference{*metav1.NewControllerRef(cj, batchv1.SchemeGroupVersion.WithKind("CronJob"))}
	return c.Core.BatchV1().Jobs(r.Namespace).Create(ctx, job, metav1.CreateOptions{})
}
func suspend(ctx context.Context, c *kube.Client, r Request) (any, error) {
	if r.Suspend == nil {
		return nil, fmt.Errorf("suspend must be provided explicitly")
	}
	cj, err := c.Core.BatchV1().CronJobs(r.Namespace).Get(ctx, r.Name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	cj.Spec.Suspend = r.Suspend
	return c.Core.BatchV1().CronJobs(r.Namespace).Update(ctx, cj, metav1.UpdateOptions{})
}
