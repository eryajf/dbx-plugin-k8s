import { trackEvent } from './analytics'
import { getCurrentAnalyticsPageKey } from './analytics-route'
import { withSubPath } from './subpath'

export const DESKTOP_LOCAL_RUNTIME = 'desktop-local'
export const DESKTOP_NAVIGATE_BACK_EVENT = 'kite:navigate-back'
export const DESKTOP_NAVIGATE_FORWARD_EVENT = 'kite:navigate-forward'
export const DESKTOP_WINDOW_NAME_CHANGE_EVENT = 'kite:window-name-change'

declare global {
  interface Window {
    __KITE_WINDOW_NAME__?: string
  }
}

export interface DesktopCapabilities {
  nativeFileDialog: boolean
  nativeSaveDialog: boolean
  tray: boolean
  menu: boolean
  singleInstance: boolean
}

export interface DesktopStatus {
  enabled: boolean
  runtime: string
  capabilities: DesktopCapabilities
}

export interface DesktopWindowOptions {
  title?: string
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
}

export interface DesktopAIChatPageContext {
  page: string
  namespace: string
  resourceName: string
  resourceKind: string
}

interface DesktopAIChatSidecarRequest extends DesktopWindowOptions {
  pageContext: DesktopAIChatPageContext
  sessionId?: string
}

export interface NativeFileFilter {
  displayName: string
  pattern: string
}

export interface NativeFileOptions {
  title?: string
  message?: string
  buttonText?: string
  directory?: string
  readContent?: boolean
  filters?: NativeFileFilter[]
}

export interface NativeFileSelection {
  canceled: boolean
  path?: string
  name?: string
  content?: string
}

export interface NativeSaveFileOptions {
  title?: string
  message?: string
  buttonText?: string
  directory?: string
  suggestedName?: string
  content: string
  filters?: NativeFileFilter[]
}

export interface NativeSaveFileResult {
  canceled: boolean
  path?: string
}

export interface NativeDownloadFileOptions {
  title?: string
  message?: string
  buttonText?: string
  directory?: string
  suggestedName?: string
  url: string
  filters?: NativeFileFilter[]
}

export interface NativeDownloadFileResult {
  canceled: boolean
  path?: string
  bytesWritten?: number
}

export interface DesktopAppPaths {
  configDir: string
  logsDir: string
  cacheDir: string
  tempDir: string
}

export interface DesktopAppInfo {
  name: string
  runtime: string
  version: string
  buildDate: string
  commitId: string
  paths: DesktopAppPaths
}

export interface DesktopUpdateAsset {
  name: string
  downloadUrl: string
  contentType?: string
  size?: number
}

export interface DesktopUpdateCheckInfo {
  currentVersion: string
  latestVersion: string
  comparison: 'update_available' | 'up_to_date' | 'local_newer' | 'uncomparable'
  hasNewVersion: boolean
  releaseUrl: string
  releaseNotes: string
  publishedAt: string
  ignored: boolean
  assetAvailable: boolean
  asset?: DesktopUpdateAsset
  checkedAt: string
}

export interface DesktopUpdateState {
  ignoredVersion: string
  lastCheck?: DesktopUpdateCheckInfo
  download?: {
    status: 'downloading' | 'download_failed'
    version: string
    assetName: string
    downloadUrl: string
    targetPath: string
    receivedBytes: number
    totalBytes: number
    speedBytesPerSec: number
    error?: string
    startedAt?: string
    updatedAt?: string
  }
  readyToApply?: {
    version: string
    assetName: string
    path: string
    downloadedAt?: string
  }
}

export interface DesktopNavigationState {
  windowName: string
  canGoBack: boolean
  canGoForward: boolean
}

const DEFAULT_CAPABILITIES: DesktopCapabilities = {
  nativeFileDialog: false,
  nativeSaveDialog: false,
  tray: false,
  menu: false,
  singleInstance: false,
}

let desktopModePromise: Promise<boolean> | null = null
let desktopStatusPromise: Promise<DesktopStatus> | null = null

function trackDesktopAction(
  name: string,
  data: Record<string, string | number | boolean> = {}
) {
  trackEvent(name, {
    runtime: 'desktop',
    page: getCurrentAnalyticsPageKey(),
    ...data,
  })
}

function classifyTrackedUrl(url: string) {
  if (typeof window === 'undefined') {
    return 'unknown'
  }

  try {
    const resolved = new URL(url, window.location.href)
    return resolved.origin === window.location.origin
      ? 'same_origin'
      : 'external'
  } catch {
    return 'invalid'
  }
}

export function getDesktopStatus(): Promise<DesktopStatus> {
  if (!desktopStatusPromise) {
    desktopStatusPromise = fetchDesktopStatus()
  }
  return desktopStatusPromise
}

export function isDesktopMode(): Promise<boolean> {
  if (!desktopModePromise) {
    desktopModePromise = getDesktopStatus().then(
      (status) => status.enabled && status.runtime === DESKTOP_LOCAL_RUNTIME
    )
  }
  return desktopModePromise
}

export async function openURL(
  url: string,
  options: DesktopWindowOptions = {}
): Promise<void> {
  const target = classifyTrackedUrl(url)
  const desktopMode = await isDesktopMode()
  try {
    if (desktopMode) {
      await postDesktop('/api/desktop/open-url', {
        url,
        ...options,
      })
      trackDesktopAction('desktop_link_open', {
        target,
        transport: 'desktop_host',
      })
      return
    }
  } catch (error) {
    console.error('Desktop open-url failed:', error)
  }

  window.open(url, '_blank', 'noopener,noreferrer')
  if (desktopMode) {
    trackDesktopAction('desktop_link_open', {
      target,
      transport: 'browser',
    })
  }
}

export async function openAIChatSidecar(
  request: DesktopAIChatSidecarRequest
): Promise<boolean> {
  if (!(await isDesktopMode())) {
    return false
  }

  await postDesktop<DesktopActionResponse>(
    '/api/desktop/ai-sidecar/open',
    request
  )
  return true
}

export async function toggleAIChatSidecar(
  request: DesktopAIChatSidecarRequest
): Promise<boolean> {
  if (!(await isDesktopMode())) {
    return false
  }

  await postDesktop<DesktopActionResponse>(
    '/api/desktop/ai-sidecar/toggle',
    request
  )
  return true
}

export async function closeAIChatSidecar(): Promise<boolean> {
  return invokeDesktopAction('/api/desktop/ai-sidecar/close')
}

export async function openNativeFile(
  options: NativeFileOptions = {}
): Promise<NativeFileSelection | null> {
  if (!(await isDesktopMode())) {
    return null
  }

  const result = await postDesktop<NativeFileSelection>(
    '/api/desktop/open-file',
    {
      readContent: true,
      ...options,
    }
  )
  trackDesktopAction('desktop_file_open', {
    mode: options.readContent === false ? 'select' : 'read_content',
    result: result.canceled ? 'canceled' : 'selected',
  })
  return result
}

export async function saveNativeFile(
  options: NativeSaveFileOptions
): Promise<NativeSaveFileResult | null> {
  if (!(await isDesktopMode())) {
    return null
  }

  const result = await postDesktop<NativeSaveFileResult>(
    '/api/desktop/save-file',
    options
  )
  trackDesktopAction('desktop_file_save', {
    mode: 'native',
    result: result.canceled ? 'canceled' : 'saved',
  })
  return result
}

export async function saveTextFile(
  options: NativeSaveFileOptions
): Promise<NativeSaveFileResult> {
  const host = (window as unknown as {
    dbxPlugin?: { saveFile?: (options: { fileName: string; contentType: string }, data: Uint8Array) => Promise<{ path?: string } | null> }
  }).dbxPlugin
  if (host) {
    if (!host.saveFile) throw new Error('DBX host does not support saving files. Please update DBX.')
    const result = await host.saveFile({fileName: options.suggestedName || 'download.txt', contentType: 'text/plain;charset=utf-8'}, new TextEncoder().encode(options.content))
    return result ? { canceled: false, path: result.path } : { canceled: true }
  }

  const desktopMode = await isDesktopMode()
  const nativeResult = await saveNativeFile(options)
  if (nativeResult) {
    return nativeResult
  }

  browserDownload(options.content, options.suggestedName || 'download.txt')
  if (desktopMode) {
    trackDesktopAction('desktop_file_save', {
      mode: 'browser_fallback',
      result: 'saved',
    })
  }
  return { canceled: false }
}

export async function downloadNativeFile(
  options: NativeDownloadFileOptions
): Promise<NativeDownloadFileResult | null> {
  if (!(await isDesktopMode())) {
    return null
  }

  const result = await postDesktop<NativeDownloadFileResult>(
    '/api/desktop/download-to-path',
    options
  )
  trackDesktopAction('desktop_file_download', {
    result: result.canceled ? 'canceled' : 'saved',
  })
  return result
}

export async function openPath(path: string): Promise<boolean> {
  const opened = await invokeDesktopAction('/api/desktop/open-path', { path })
  if (opened) {
    trackDesktopAction('desktop_path_action', {
      action: 'open_path',
    })
  }
  return opened
}

export async function revealPath(path: string): Promise<boolean> {
  const revealed = await invokeDesktopAction('/api/desktop/reveal-path', {
    path,
  })
  if (revealed) {
    trackDesktopAction('desktop_path_action', {
      action: 'reveal_path',
    })
  }
  return revealed
}

export async function openLogsDir(): Promise<boolean> {
  const opened = await invokeDesktopAction('/api/desktop/open-logs-dir')
  if (opened) {
    trackDesktopAction('desktop_path_action', {
      action: 'open_logs_dir',
    })
  }
  return opened
}

export async function openConfigDir(): Promise<boolean> {
  const opened = await invokeDesktopAction('/api/desktop/open-config-dir')
  if (opened) {
    trackDesktopAction('desktop_path_action', {
      action: 'open_config_dir',
    })
  }
  return opened
}

export async function focusDesktopApp(): Promise<boolean> {
  const focused = await invokeDesktopAction('/api/desktop/window/focus')
  if (focused) {
    trackDesktopAction('desktop_window_action', {
      action: 'focus',
    })
  }
  return focused
}

export async function hideDesktopApp(): Promise<boolean> {
  const hidden = await invokeDesktopAction('/api/desktop/window/hide')
  if (hidden) {
    trackDesktopAction('desktop_window_action', {
      action: 'hide',
    })
  }
  return hidden
}

export async function quitDesktopApp(): Promise<boolean> {
  const quit = await invokeDesktopAction('/api/desktop/window/quit')
  if (quit) {
    trackDesktopAction('desktop_window_action', {
      action: 'quit',
    })
  }
  return quit
}

export async function copyTextToClipboard(text: string): Promise<void> {
  const desktopMode = await isDesktopMode()

  if (
    desktopMode &&
    (await invokeDesktopAction('/api/desktop/copy-to-clipboard', { text }))
  ) {
    trackDesktopAction('clipboard_copy', {
      transport: 'native',
    })
    return
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    if (desktopMode) {
      trackDesktopAction('clipboard_copy', {
        transport: 'clipboard_api',
      })
    }
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'absolute'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
  if (desktopMode) {
    trackDesktopAction('clipboard_copy', {
      transport: 'exec_command',
    })
  }
}

export async function importKubeconfig(content?: string): Promise<boolean> {
  const imported = await invokeDesktopAction('/api/desktop/import-kubeconfig', {
    content,
  })
  if (imported) {
    trackEvent('kubeconfig_import', {
      runtime: 'desktop',
      mode: content?.trim() ? 'text_import' : 'file_dialog',
      page: getCurrentAnalyticsPageKey(),
    })
  }
  return imported
}

export async function getDesktopAppInfo(): Promise<DesktopAppInfo | null> {
  if (!(await isDesktopMode())) {
    return null
  }

  const response = await fetch(withSubPath('/api/desktop/app-info'), {
    credentials: 'include',
  })
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      error?: string
    }
    throw new Error(error.error || `Desktop request failed: ${response.status}`)
  }

  return (await response.json()) as DesktopAppInfo
}

export async function getDesktopUpdateState(): Promise<DesktopUpdateState | null> {
  if (!(await isDesktopMode())) {
    return null
  }

  const response = await fetch(withSubPath('/api/desktop/update/state'), {
    credentials: 'include',
  })
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      error?: string
    }
    throw new Error(error.error || `Desktop request failed: ${response.status}`)
  }

  return (await response.json()) as DesktopUpdateState
}

export async function checkDesktopUpdate(
  force: boolean = false
): Promise<DesktopUpdateCheckInfo | null> {
  if (!(await isDesktopMode())) {
    return null
  }

  return postDesktop<DesktopUpdateCheckInfo>('/api/desktop/update/check', {
    force,
  })
}

export async function ignoreDesktopUpdate(version: string): Promise<boolean> {
  return invokeDesktopAction('/api/desktop/update/ignore', { version })
}

export async function clearIgnoredDesktopUpdate(): Promise<boolean> {
  return invokeDesktopAction('/api/desktop/update/clear-ignore')
}

export async function startDesktopUpdateDownload(
  version: string
): Promise<DesktopUpdateState | null> {
  if (!(await isDesktopMode())) {
    return null
  }

  return postDesktop<DesktopUpdateState>('/api/desktop/update/download', {
    version,
  })
}

export async function retryDesktopUpdateDownload(): Promise<DesktopUpdateState | null> {
  if (!(await isDesktopMode())) {
    return null
  }

  return postDesktop<DesktopUpdateState>('/api/desktop/update/retry', {})
}

export async function cancelDesktopUpdateDownload(): Promise<DesktopUpdateState | null> {
  if (!(await isDesktopMode())) {
    return null
  }

  return postDesktop<DesktopUpdateState>('/api/desktop/update/cancel', {})
}

export async function applyDesktopUpdate(): Promise<boolean> {
  return invokeDesktopAction('/api/desktop/update/apply')
}

export function getDesktopWindowName(): string {
  if (typeof window === 'undefined') {
    return ''
  }
  return window.__KITE_WINDOW_NAME__ || ''
}

export async function syncDesktopNavigationState(
  state: DesktopNavigationState
): Promise<void> {
  if (!(await isDesktopMode())) {
    return
  }

  await postDesktop<DesktopActionResponse>(
    '/api/desktop/navigation/state',
    state
  )
}

export function installDesktopTargetBlankInterceptor(): () => void {
  let cleanup = () => {}
  let active = true

  void isDesktopMode().then((enabled) => {
    if (!active || !enabled) {
      return
    }

    const handleClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return
      }

      const target = event.target
      if (!(target instanceof Element)) {
        return
      }

      const anchor = target.closest('a[target="_blank"]')
      if (!(anchor instanceof HTMLAnchorElement)) {
        return
      }

      const href = anchor.href || anchor.getAttribute('href')
      if (!href) {
        return
      }

      event.preventDefault()
      void openURL(href)
    }

    document.addEventListener('click', handleClick, true)
    cleanup = () => {
      document.removeEventListener('click', handleClick, true)
    }
  })

  return () => {
    active = false
    cleanup()
  }
}

async function fetchDesktopStatus(): Promise<DesktopStatus> {
  try {
    const response = await fetch(withSubPath('/api/desktop/status'), {
      credentials: 'include',
    })
    if (!response.ok) {
      return normalizeDesktopStatus()
    }

    const data = (await response
      .json()
      .catch(() => ({}))) as Partial<DesktopStatus>
    return normalizeDesktopStatus(data)
  } catch {
    return normalizeDesktopStatus()
  }
}

async function invokeDesktopAction(
  path: string,
  body: Record<string, unknown> = {}
): Promise<boolean> {
  if (!(await isDesktopMode())) {
    return false
  }

  await postDesktop<DesktopActionResponse>(path, body)
  return true
}

async function postDesktop<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(withSubPath(path), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      error?: string
    }
    throw new Error(error.error || `Desktop request failed: ${response.status}`)
  }

  return response.json() as Promise<T>
}

function normalizeDesktopStatus(
  status: Partial<DesktopStatus> = {}
): DesktopStatus {
  return {
    enabled: status.enabled === true,
    runtime: status.runtime || 'server',
    capabilities: {
      ...DEFAULT_CAPABILITIES,
      ...(status.capabilities || {}),
    },
  }
}

function browserDownload(content: string, fileName: string) {
  const blob = new Blob([content], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

interface DesktopActionResponse {
  ok: boolean
}
