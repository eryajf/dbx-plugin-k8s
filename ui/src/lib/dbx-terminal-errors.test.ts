import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'
import { languages } from '../i18n/locale'
import { TerminalInputError, translateTerminalInputError } from './dbx-terminal-errors'

const locales = import.meta.glob('../i18n/locales/*.json', {eager: true, import: 'default'})

describe('terminal input error translations', () => {
  it.each(languages.map(language => language.code))('resolves all input errors in %s without English fallback', async locale => {
    const i18n = createInstance()
    await i18n.init({lng: locale, fallbackLng: false, resources: {
      [locale]: {translation: locales[`../i18n/locales/${locale}.json`] as Record<string, unknown>},
    }})
    for (const code of ['INPUT_INCOMPLETE', 'INPUT_INVALID', 'INPUT_QUEUE_FULL'] as const) {
      const text = translateTerminalInputError(code, i18n.t.bind(i18n))
      expect(text).toBeTruthy()
      expect(text).not.toContain('terminalInputErrors.')
      if (locale !== 'en') expect(text).not.toBe(new TerminalInputError(code).message)
    }
    if (locale === 'zh-CN') {
      expect(translateTerminalInputError('INPUT_QUEUE_FULL', i18n.t.bind(i18n))).toBe('终端输入队列已满，请重新连接后再继续')
      expect(translateTerminalInputError('INPUT_INCOMPLETE', i18n.t.bind(i18n))).toBe('终端输入未完整写入，请重新连接后再继续')
    }
    expect(translateTerminalInputError('REMOTE_ERROR', i18n.t.bind(i18n))).toBeUndefined()
  })
})
