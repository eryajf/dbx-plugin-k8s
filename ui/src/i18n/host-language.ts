import i18n from './index'
import { normalizeLocale } from './locale'

type LocaleEvent = { locale?: string }
type LanguageHost = {
  ready: Promise<unknown>
  locale?: string
  onLocaleChange?: (listener: (locale: string) => void) => () => void
  onEvent?: (listener: (event: LocaleEvent) => void) => () => void
}

/** Use the host language at startup and on updates, across DBX bridge versions. */
export function syncHostLanguage(host: LanguageHost): () => void {
  let active = true
  const apply = (locale?: string) => {
    if (!active || !locale) return
    const language = normalizeLocale(locale)
    if (i18n.language !== language) void i18n.changeLanguage(language)
  }
  const offLocale = host.onLocaleChange?.(apply)
  const offEvent = host.onEvent?.((event) => apply(event.locale))
  const onEnvironment = (event: Event) => {
    apply((event as CustomEvent<LocaleEvent>).detail?.locale ?? host.locale)
  }
  document.addEventListener('dbx-plugin-env', onEnvironment)
  window.addEventListener('dbx-plugin-env', onEnvironment)
  let lastLocale = ''
  const timer = window.setInterval(() => {
    const locale = host.locale
    if (locale && locale !== lastLocale) {
      lastLocale = locale
      apply(locale)
    }
  }, 500)
  void host.ready.then(
    () => apply(host.locale),
    () => {}
  )
  return () => {
    active = false
    window.clearInterval(timer)
    offLocale?.()
    offEvent?.()
    document.removeEventListener('dbx-plugin-env', onEnvironment)
    window.removeEventListener('dbx-plugin-env', onEnvironment)
  }
}
