const staticPageKeyMap: Record<string, string> = {
  '/': 'overview',
  '/dashboard': 'overview',
  '/settings': 'settings',
  '/favorites': 'favorites',
  '/networking/advanced': 'networking/advanced',
  '/ai-chat-box': 'ai-chat',
}

function normalizePathname(pathname: string) {
  const trimmed = pathname.trim()
  if (!trimmed) {
    return '/'
  }

  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  if (normalized !== '/' && normalized.endsWith('/')) {
    return normalized.slice(0, -1)
  }
  return normalized
}

export function getAnalyticsPageKey(pathname: string) {
  const normalizedPathname = normalizePathname(pathname)

  if (staticPageKeyMap[normalizedPathname]) {
    return staticPageKeyMap[normalizedPathname]
  }

  const segments = normalizedPathname.split('/').filter(Boolean)
  if (segments.length === 0) {
    return 'overview'
  }

  if (segments[0] === 'crds') {
    return segments.length <= 2 ? 'crds/list' : 'crds/detail'
  }

  if (segments.length === 1) {
    return `${segments[0].toLowerCase()}/list`
  }

  return `${segments[0].toLowerCase()}/detail`
}

export function getAnalyticsPageUrl(pageKey: string) {
  return `/${pageKey}`
}

export function getCurrentAnalyticsPageKey() {
  if (typeof window === 'undefined') {
    return 'overview'
  }

  return getAnalyticsPageKey(window.location.pathname)
}
