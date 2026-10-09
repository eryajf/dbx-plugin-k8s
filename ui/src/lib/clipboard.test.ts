import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { copyTextToClipboard } from './desktop'

describe('clipboard compatibility fallback', () => {
  const originalCommand = Object.getOwnPropertyDescriptor(
    document,
    'execCommand'
  )

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    vi.stubGlobal('navigator', { clipboard: undefined })
  })

  afterEach(() => {
    if (originalCommand) {
      Object.defineProperty(document, 'execCommand', originalCommand)
    } else {
      Reflect.deleteProperty(document, 'execCommand')
    }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function command(implementation: () => boolean) {
    const copy = vi.fn(implementation)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: copy,
    })
    return copy
  }

  it('rejects a failed copy without leaking the content and removes the temporary textarea', async () => {
    const copy = command(() => false)
    const existing = document.createElement('textarea')
    document.body.appendChild(existing)
    try {
      await expect(copyTextToClipboard('private content')).rejects.toThrow(
        'Clipboard copy failed'
      )
      expect(copy).toHaveBeenCalledWith('copy')
      expect(document.querySelectorAll('textarea')).toHaveLength(1)
      expect(existing).toBeInTheDocument()
    } finally {
      existing.remove()
    }
  })

  it('resolves only when the browser reports success and cleans up', async () => {
    const copy = command(() => true)
    await expect(copyTextToClipboard('example')).resolves.toBeUndefined()
    expect(copy).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('cleans up when the browser throws instead of returning a result', async () => {
    command(() => {
      throw new Error('Browser denied copying')
    })
    await expect(copyTextToClipboard('example')).rejects.toThrow(
      'Browser denied copying'
    )
    expect(document.querySelector('textarea')).toBeNull()
  })
})
