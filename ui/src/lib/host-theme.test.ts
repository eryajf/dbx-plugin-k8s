import { afterEach, describe, expect, it, vi } from 'vitest'

import { normalizeAppearance, syncHostTheme } from './host-theme'

describe('host theme sync', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('normalizes only dark and light appearances', () => {
    expect(normalizeAppearance('dark')).toBe('dark')
    expect(normalizeAppearance('light')).toBe('light')
    expect(normalizeAppearance('system')).toBeNull()
    expect(normalizeAppearance(undefined)).toBeNull()
  })

  it('applies the host appearance at startup and on environment updates', async () => {
    const host = { ready: Promise.resolve(), theme: { appearance: 'dark' } }
    const apply = vi.fn()
    const stop = syncHostTheme(host, apply)
    expect(apply).toHaveBeenCalledWith('dark')

    window.dispatchEvent(
      new CustomEvent('dbx-plugin-env', {
        detail: { theme: { appearance: 'light' } },
      })
    )
    expect(apply).toHaveBeenLastCalledWith('light')

    host.theme.appearance = 'dark'
    await vi.waitFor(() => expect(apply).toHaveBeenLastCalledWith('dark'))

    stop()
    window.dispatchEvent(
      new CustomEvent('dbx-plugin-env', {
        detail: { theme: { appearance: 'light' } },
      })
    )
    expect(apply).toHaveBeenLastCalledWith('dark')
  })
})