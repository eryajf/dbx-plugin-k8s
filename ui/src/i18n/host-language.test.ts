import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useTranslation } from 'react-i18next'
import { languages } from './locale'
import i18n from './index'
import { syncHostLanguage } from './host-language'

let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
  stop = undefined
  cleanup()
  vi.useRealTimers()
})

describe('DBX language synchronization', () => {
  it('replaces cached Chinese on startup and receives SDK locale changes', async () => {
    await i18n.changeLanguage('zh')
    let listener: (locale: string) => void = () => {}
    stop = syncHostLanguage({
      ready: Promise.resolve(),
      locale: 'en',
      onLocaleChange: (callback) => {
        listener = callback
        return () => {
          listener = () => {}
        }
      },
    })
    await Promise.resolve()
    expect(i18n.resolvedLanguage).toBe('en')
    listener('zh-CN')
    expect(i18n.resolvedLanguage).toBe('zh-CN')
    listener('en')
    expect(i18n.resolvedLanguage).toBe('en')
    stop()
    listener('zh-CN')
    expect(i18n.resolvedLanguage).toBe('en')
  })

  it('handles document env events in bridges without onLocaleChange', async () => {
    stop = syncHostLanguage({ ready: Promise.resolve(), locale: 'zh-CN' })
    await Promise.resolve()
    document.dispatchEvent(
      new CustomEvent('dbx-plugin-env', { detail: { locale: 'en' } })
    )
    expect(i18n.resolvedLanguage).toBe('en')
  })
})

function TranslatedSave() {
  const { t } = useTranslation()
  return createElement('button', null, t('common.save'))
}

describe('host locale integration', () => {
  it.each(languages.map(({ code }) => code))(
    'loads %s at startup and updates rendered text at runtime',
    async (code) => {
      await i18n.changeLanguage(code === 'en' ? 'zh-CN' : 'en')
      let change: (locale: string) => void = () => {}
      render(createElement(TranslatedSave))
      await act(async () => {
        stop = syncHostLanguage({
          ready: Promise.resolve(),
          locale: code,
          onLocaleChange: (callback) => {
            change = callback
            return () => {}
          },
        })
        await Promise.resolve()
      })
      expect(i18n.resolvedLanguage).toBe(code)
      expect(screen.getByRole('button').textContent).toBe(
        i18n.getResource(code, 'translation', 'common.save')
      )
      act(() => change(code === 'en' ? 'zh-CN' : 'en'))
      act(() => change(code))
      expect(i18n.resolvedLanguage).toBe(code)
      expect(screen.getByRole('button').textContent).toBe(
        i18n.getResource(code, 'translation', 'common.save')
      )
    }
  )

  it('polls getter-only bridges every 500ms and stops all updates after cleanup', async () => {
    vi.useFakeTimers()
    let locale = 'en'
    stop = syncHostLanguage({
      ready: Promise.resolve(),
      get locale() {
        return locale
      },
    })
    await Promise.resolve()
    locale = 'ja'
    vi.advanceTimersByTime(499)
    expect(i18n.resolvedLanguage).toBe('en')
    vi.advanceTimersByTime(1)
    expect(i18n.resolvedLanguage).toBe('ja')
    stop()
    locale = 'ko'
    vi.advanceTimersByTime(1000)
    for (const target of [document, window]) {
      target.dispatchEvent(
        new CustomEvent('dbx-plugin-env', { detail: { locale: 'ko' } })
      )
    }
    expect(i18n.resolvedLanguage).toBe('ja')
  })

  it.each(['document', 'window'])(
    'handles %s environment events and normalizes aliases',
    async (targetName) => {
      stop = syncHostLanguage({ ready: Promise.resolve(), locale: 'en' })
      await Promise.resolve()
      const target = targetName === 'document' ? document : window
      for (const [locale, expected] of [
        ['zh_CN', 'zh-CN'],
        ['zh_Hant', 'zh-TW'],
        ['pt_BR', 'pt-BR'],
        ['unknown', 'en'],
      ]) {
        target.dispatchEvent(
          new CustomEvent('dbx-plugin-env', { detail: { locale } })
        )
        expect(i18n.resolvedLanguage).toBe(expected)
      }
    }
  )
})
