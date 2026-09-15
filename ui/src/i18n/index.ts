import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'

import en from './locales/en.json'
import zh from './locales/zh.json'

const LANGUAGE_STORAGE_KEY = 'i18nextLng'

const resources = {
  en: {
    translation: en,
  },
  zh: {
    translation: zh,
  },
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    debug: false,

    interpolation: {
      escapeValue: false,
    },

    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
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

    const nextLanguage = event.newValue?.trim()
    if (!nextLanguage || nextLanguage === i18n.language) {
      return
    }

    void i18n.changeLanguage(nextLanguage)
  })
}

export default i18n
