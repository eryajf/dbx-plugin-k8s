import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RefreshButton } from './refresh-button'

afterEach(() => vi.useRealTimers())

describe('RefreshButton', () => {
  it('guards re-entry for the minimum spin and honors the actual fetching state', () => {
    vi.useFakeTimers()
    const onClick = vi.fn()
    const view = render(<RefreshButton onClick={onClick}>Refresh</RefreshButton>)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button')).toBeDisabled()
    view.rerender(<RefreshButton onClick={onClick} isFetching>Refresh</RefreshButton>)
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByRole('button')).toBeDisabled()
    view.rerender(<RefreshButton onClick={onClick}>Refresh</RefreshButton>)
    expect(screen.getByRole('button')).not.toBeDisabled()
  })

  it('cleans up its animation timer on unmount', () => {
    vi.useFakeTimers()
    const view = render(<RefreshButton onClick={vi.fn()}>Refresh</RefreshButton>)
    fireEvent.click(screen.getByRole('button'))
    expect(vi.getTimerCount()).toBe(1)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
