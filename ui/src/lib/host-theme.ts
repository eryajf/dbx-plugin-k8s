export type HostAppearance = 'dark' | 'light'

type ThemeEvent = { theme?: { appearance?: string }; appearance?: string }
type ThemeHost = {
  ready?: Promise<unknown>
  theme?: { appearance?: string }
  onEvent?: (listener: (event: ThemeEvent) => void) => () => void
}

export function normalizeAppearance(value: unknown): HostAppearance | null {
  return value === 'dark' || value === 'light' ? value : null
}

export function getThemeHost(): ThemeHost | null {
  return (window as unknown as { dbxPlugin?: ThemeHost }).dbxPlugin ?? null
}

/** Use the host appearance at startup and on updates, across DBX bridge versions. */
export function syncHostTheme(
  host: ThemeHost,
  apply: (appearance: HostAppearance | null) => void
): () => void {
  let active = true
  const emit = (value: unknown) => {
    if (active) apply(normalizeAppearance(value))
  }
  const offEvent = host.onEvent?.((event) =>
    emit(event.theme?.appearance ?? event.appearance)
  )
  const onEnvironment = (event: Event) => {
    const detail = (event as CustomEvent<ThemeEvent>).detail
    emit(detail?.theme?.appearance ?? detail?.appearance ?? host.theme?.appearance)
  }
  document.addEventListener('dbx-plugin-env', onEnvironment)
  window.addEventListener('dbx-plugin-env', onEnvironment)
  let lastAppearance: string | undefined
  const timer = window.setInterval(() => {
    const appearance = host.theme?.appearance
    if (appearance !== lastAppearance) {
      lastAppearance = appearance
      emit(appearance)
    }
  }, 500)
  void host.ready?.then(
    () => emit(host.theme?.appearance),
    () => {}
  )
  emit(host.theme?.appearance)
  return () => {
    active = false
    window.clearInterval(timer)
    offEvent?.()
    document.removeEventListener('dbx-plugin-env', onEnvironment)
    window.removeEventListener('dbx-plugin-env', onEnvironment)
  }
}