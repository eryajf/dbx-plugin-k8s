import '@/i18n'

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ClusterContext } from '@/contexts/cluster-context'

import { ResourceFavoriteButton } from './resource-favorite-button'

const useFavoritesMock = vi.fn()
const toggleFavoriteMock = vi.fn()

vi.mock('@/hooks/use-favorites', () => ({
  useFavorites: () => useFavoritesMock(),
}))

const clusterContextValue = {
  clusters: [],
  currentCluster: 'test-cluster',
  setCurrentCluster: vi.fn(),
  isLoading: false,
  isSwitching: false,
  error: null,
}

function renderButton() {
  return render(
    <ClusterContext.Provider value={clusterContextValue}>
      <ResourceFavoriteButton
        resource={{
          name: 'demo',
          namespace: 'default',
          resourceType: 'deployments',
        }}
      />
    </ClusterContext.Provider>
  )
}

describe('ResourceFavoriteButton', () => {
  beforeEach(() => {
    toggleFavoriteMock.mockReset()
    toggleFavoriteMock.mockResolvedValue(true)
    useFavoritesMock.mockReset()
    useFavoritesMock.mockReturnValue({
      isFavorite: () => false,
      isError: false,
      isLoading: false,
      isMutating: false,
      toggleFavorite: toggleFavoriteMock,
    })
  })

  it.each([
    ['while favorites are loading', { isLoading: true }],
    ['when loading favorites failed', { isError: true }],
    ['while another favorite mutation is pending', { isMutating: true }],
  ])('disables the button %s', (_label, state) => {
    useFavoritesMock.mockReturnValue({
      isFavorite: () => false,
      isError: false,
      isLoading: false,
      isMutating: false,
      toggleFavorite: toggleFavoriteMock,
      ...state,
    })

    renderButton()

    const button = screen.getByRole('button', { name: 'Add to favorites' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(toggleFavoriteMock).not.toHaveBeenCalled()
  })

  it('toggles when favorite state is ready', async () => {
    renderButton()

    fireEvent.click(screen.getByRole('button', { name: 'Add to favorites' }))

    expect(toggleFavoriteMock).toHaveBeenCalledWith({
      name: 'demo',
      namespace: 'default',
      resourceType: 'deployments',
      id: '',
      createdAt: '',
    })
  })
})
