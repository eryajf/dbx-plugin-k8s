package kube

import (
	"context"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/dynamic"
)

type groupResourceFlight struct {
	done chan struct{}
	list *metav1.APIResourceList
	err  error
	at   time.Time
}

// SearchDynamic isolates background indexing from interactive request budgets.
func (c *Client) SearchDynamic() dynamic.Interface {
	if c.BackgroundDynamic != nil {
		return c.BackgroundDynamic
	}
	return c.Dynamic
}

// APIResourcesForGroupVersion never waits for unrelated API groups. A shared
// lookup has its own connection-bound deadline; cancelling one waiter does not
// cancel other callers. Failed lookups are retried, not cached for the TTL.
func (c *Client) APIResourcesForGroupVersion(ctx context.Context, gv string) (*metav1.APIResourceList, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	c.discoveryMu.Lock()
	if !c.discoveryAt.IsZero() && time.Since(c.discoveryAt) < discoveryCacheTTL {
		for _, list := range c.discoveryLists {
			if list.GroupVersion == gv {
				result := list.DeepCopy()
				c.discoveryMu.Unlock()
				return result, nil
			}
		}
	}
	if c.groupResources == nil {
		c.groupResources = make(map[string]*groupResourceFlight)
	}
	f := c.groupResources[gv]
	if f == nil || (!f.at.IsZero() && (f.err != nil || time.Since(f.at) >= discoveryCacheTTL)) {
		f = &groupResourceFlight{done: make(chan struct{})}
		c.groupResources[gv] = f
		go c.fetchGroupResources(gv, f)
	}
	c.discoveryMu.Unlock()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-f.done:
		if f.list == nil {
			return nil, f.err
		}
		return f.list.DeepCopy(), f.err
	}
}

func (c *Client) fetchGroupResources(gv string, f *groupResourceFlight) {
	ctx, cancel := c.RequestContext(discoveryRequestTimeout)
	defer cancel()
	var list *metav1.APIResourceList
	var err error
	if c.Discovery != nil {
		path := "/apis/" + gv
		if gv == "v1" {
			path = "/api/v1"
		}
		list = &metav1.APIResourceList{}
		err = c.Discovery.WithLegacy().RESTClient().Get().AbsPath(path).Do(ctx).Into(list)
	} else {
		// Compatibility for fake clients used by existing callers and tests.
		list, err = c.Core.Discovery().ServerResourcesForGroupVersion(gv)
	}
	c.discoveryMu.Lock()
	f.list, f.err, f.at = list, err, time.Now()
	close(f.done)
	c.discoveryMu.Unlock()
}
