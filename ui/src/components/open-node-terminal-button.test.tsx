import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OpenNodeTerminalButton } from './open-node-terminal-button'

const openSessionMock = vi.fn()
const useFeatureMock = vi.fn()

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/contexts/terminal-context', () => ({
  useTerminal: () => ({
    openSession: openSessionMock,
  }),
}))

vi.mock('@/hooks/use-license', () => ({
  useFeature: (feature: string) => useFeatureMock(feature),
}))

describe('OpenNodeTerminalButton', () => {
  beforeEach(() => {
    openSessionMock.mockReset()
    useFeatureMock.mockReset()
  })

  it('disables node terminal access for Community edition', async () => {
    const user = userEvent.setup()
    useFeatureMock.mockReturnValue(false)

    render(<OpenNodeTerminalButton nodeName="node-1" />)

    const button = screen.getByRole('button', { name: 'Open terminal' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Requires Pro')

    await user.click(button)

    expect(useFeatureMock).toHaveBeenCalledWith('terminal.node')
    expect(openSessionMock).not.toHaveBeenCalled()
  })

  it('opens a node terminal session when Pro is active', async () => {
    const user = userEvent.setup()
    useFeatureMock.mockReturnValue(true)

    render(<OpenNodeTerminalButton nodeName="node-1" />)

    const button = screen.getByRole('button', { name: 'Open terminal' })
    expect(button).not.toBeDisabled()

    await user.click(button)

    expect(openSessionMock).toHaveBeenCalledWith({
      type: 'node',
      nodeName: 'node-1',
      title: 'node-1',
      source: 'node/node-1',
      entry: 'resource-action',
    })
  })
})
