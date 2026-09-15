import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NavigationControls } from './navigation-controls'

const useNavigationMock = vi.fn()

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: string) => fallback ?? _key,
    }),
  }
})

vi.mock('@/contexts/navigation-context', () => ({
  useNavigation: () => useNavigationMock(),
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))

function setNavigatorPlatform(platform: string) {
  Object.defineProperty(window.navigator, 'platform', {
    value: platform,
    configurable: true,
  })
}

describe('NavigationControls', () => {
  afterEach(() => {
    useNavigationMock.mockReset()
  })

  it('shows mac shortcuts in tooltip content', () => {
    setNavigatorPlatform('MacIntel')
    useNavigationMock.mockReturnValue({
      canGoBack: true,
      canGoForward: true,
      goBack: vi.fn(),
      goForward: vi.fn(),
    })

    render(<NavigationControls />)

    expect(screen.getByText('⌘[')).toBeInTheDocument()
    expect(screen.getByText('⌘]')).toBeInTheDocument()
  })

  it('shows non-mac shortcuts in tooltip content', () => {
    setNavigatorPlatform('Win32')
    useNavigationMock.mockReturnValue({
      canGoBack: false,
      canGoForward: false,
      goBack: vi.fn(),
      goForward: vi.fn(),
    })

    render(<NavigationControls />)

    expect(screen.getByText('Alt+Left')).toBeInTheDocument()
    expect(screen.getByText('Alt+Right')).toBeInTheDocument()
  })
})
