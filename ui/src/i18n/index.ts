import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'

import { normalizeLocale, languages } from './locale'
import en from './locales/en.json'
import az from './locales/az.json'
import es from './locales/es.json'
import it from './locales/it.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import ptBR from './locales/pt-BR.json'
import tr from './locales/tr.json'
import zhCN from './locales/zh-CN.json'
import zhTW from './locales/zh-TW.json'

const LANGUAGE_STORAGE_KEY = 'i18nextLng'

const resources = {
  en: {
    translation: en,
  },
  zh: { translation: zhCN },
  'zh-CN': { translation: zhCN },
  'zh-TW': { translation: zhTW },
  az: { translation: az },
  es: { translation: es },
  it: { translation: it },
  ja: { translation: ja },
  ko: { translation: ko },
  'pt-BR': { translation: ptBR },
  tr: { translation: tr },
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    supportedLngs: [...languages.map(({ code }) => code), 'zh'],
    load: 'currentOnly',
    debug: false,

    interpolation: {
      escapeValue: false,
    },

    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      convertDetectedLanguage: normalizeLocale,
      caches: ['localStorage'],
    },
  })

if (typeof document !== 'undefined') {
  document.documentElement.lang = i18n.resolvedLanguage || i18n.language || 'en'
}

i18n.on('languageChanged', (language) => {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language
  }

  if (typeof window !== 'undefined') {
    const current = window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
    if (current !== language) {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
    }
  }
})

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== LANGUAGE_STORAGE_KEY) {
      return
    }

    if ('dbxPlugin' in window) return

    const nextLanguage = normalizeLocale(event.newValue ?? undefined)
    if (!nextLanguage || nextLanguage === i18n.language) {
      return
    }

    void i18n.changeLanguage(nextLanguage)
  })
}

export default i18n
