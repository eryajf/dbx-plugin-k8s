import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  installAnalyticsErrorTracking,
  isAnalyticsEnabled,
  trackDesktopEvent,
  trackEvent,
  trackPage,
  trackResourceAction,
} from './analytics'

describe('analytics', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    window.__kite_analytics_enabled__ = false
    delete window.umami
  })

  it('reports whether analytics is enabled from the injected runtime flag', () => {
    expect(isAnalyticsEnabled()).toBe(false)
    window.__kite_analytics_enabled__ = true
    expect(isAnalyticsEnabled()).toBe(true)
  })

  it('tracks a sanitized page view when analytics is enabled', () => {
    const track = vi.fn()
    window.__kite_analytics_enabled__ = true
    window.umami = { track }

    trackPage('pods/detail')

    expect(track).toHaveBeenCalledTimes(1)
    const transformer = track.mock.calls[0][0] as (payload: {
      url?: string
      title?: string
    }) => { url?: string; title?: string }
    expect(transformer({ url: '/pods/default/nginx' })).toEqual({
      url: '/pods/detail',
      title: 'Kite Desktop - pods/detail',
    })
  })

  it('tracks custom events only when analytics is enabled', () => {
    const track = vi.fn()
    window.umami = { track }

    trackEvent('cluster_switch', { runtime: 'desktop' })
    expect(track).not.toHaveBeenCalled()

    window.__kite_analytics_enabled__ = true
    trackEvent('cluster_switch', { runtime: 'desktop' })

    expect(track).toHaveBeenCalledWith('cluster_switch', {
      runtime: 'desktop',
    })
  })

  it('adds desktop runtime metadata for desktop events', () => {
    const track = vi.fn()
    window.__kite_analytics_enabled__ = true
    window.umami = { track }

    trackDesktopEvent('clipboard_copy', { transport: 'native' })

    expect(track).toHaveBeenCalledWith('clipboard_copy', {
      runtime: 'desktop',
      page: 'overview',
      transport: 'native',
    })
  })

  it('tracks resource actions with sanitized resource metadata', () => {
    const track = vi.fn()
    window.__kite_analytics_enabled__ = true
    window.umami = { track }

    trackResourceAction('deployments', 'restart', {
      result: 'success',
    })

    expect(track).toHaveBeenCalledWith('resource_action', {
      runtime: 'desktop',
      page: 'overview',
      resource_type: 'deployments',
      action: 'restart',
      result: 'success',
    })
  })

  it('tracks sanitized UI error categories when enabled', () => {
    const track = vi.fn()
    window.__kite_analytics_enabled__ = true
    window.umami = { track }

    const cleanup = installAnalyticsErrorTracking()
    window.dispatchEvent(new Event('error'))
    window.dispatchEvent(new Event('unhandledrejection'))
    cleanup()

    expect(track).toHaveBeenNthCalledWith(1, 'ui_error', {
      runtime: 'desktop',
      page: 'overview',
      source: 'window_error',
    })
    expect(track).toHaveBeenNthCalledWith(2, 'ui_error', {
      runtime: 'desktop',
      page: 'overview',
      source: 'unhandled_rejection',
    })
  })
})
