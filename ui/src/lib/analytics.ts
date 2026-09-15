import type { ResourceType } from '@/types/api'

import {
  getAnalyticsPageUrl,
  getCurrentAnalyticsPageKey,
} from './analytics-route'

type AnalyticsValue = string | number | boolean

type UmamiPayload = {
  url?: string
  title?: string
  name?: string
  data?: Record<string, AnalyticsValue>
}

type UmamiPayloadTransformer = (payload: UmamiPayload) => UmamiPayload

type UmamiTracker = {
  track: {
    (payload?: UmamiPayload | UmamiPayloadTransformer): void
    (name: string, data?: Record<string, AnalyticsValue>): void
  }
}

declare global {
  interface Window {
    __kite_analytics_enabled__?: boolean
    umami?: UmamiTracker
  }
}

function isWindowAvailable() {
  return typeof window !== 'undefined'
}

function getUmamiTracker() {
  if (!isWindowAvailable()) {
    return null
  }
  return typeof window.umami?.track === 'function' ? window.umami : null
}

export function isAnalyticsEnabled() {
  return isWindowAvailable() && window.__kite_analytics_enabled__ === true
}

export function trackPage(pageKey: string) {
  if (!isAnalyticsEnabled()) {
    return
  }

  const tracker = getUmamiTracker()
  if (!tracker) {
    return
  }

  const pageUrl = getAnalyticsPageUrl(pageKey)
  tracker.track((payload) => ({
    ...payload,
    url: pageUrl,
    title: `Kite Desktop - ${pageKey}`,
  }))
}

export function trackEvent(
  name: string,
  data?: Record<string, AnalyticsValue>
) {
  if (!isAnalyticsEnabled()) {
    return
  }

  const tracker = getUmamiTracker()
  if (!tracker) {
    return
  }

  tracker.track(name, data)
}

export function trackDesktopEvent(
  name: string,
  data: Record<string, AnalyticsValue> = {}
) {
  trackEvent(name, {
    runtime: 'desktop',
    page: getCurrentAnalyticsPageKey(),
    ...data,
  })
}

export function trackResourceAction(
  resourceType: ResourceType,
  action: string,
  data: Record<string, AnalyticsValue> = {}
) {
  trackDesktopEvent('resource_action', {
    resource_type: resourceType,
    action,
    ...data,
  })
}

export function installAnalyticsErrorTracking() {
  if (!isWindowAvailable()) {
    return () => {}
  }

  const handleError = () => {
    trackDesktopEvent('ui_error', {
      source: 'window_error',
    })
  }

  const handleUnhandledRejection = () => {
    trackDesktopEvent('ui_error', {
      source: 'unhandled_rejection',
    })
  }

  window.addEventListener('error', handleError)
  window.addEventListener('unhandledrejection', handleUnhandledRejection)

  return () => {
    window.removeEventListener('error', handleError)
    window.removeEventListener('unhandledrejection', handleUnhandledRejection)
  }
}
