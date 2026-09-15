import { render, screen } from '@testing-library/react'
import { Outlet, RouterProvider } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { router } from './routes'

vi.mock('./App', () => ({
  __esModule: true,
  default: () => (
    <div>
      <div>app shell</div>
      <Outlet />
    </div>
  ),
  StandaloneAIChatApp: () => <div>standalone ai chat</div>,
}))

vi.mock('./pages/overview', () => ({
  Overview: () => <div>overview page</div>,
}))

vi.mock('./pages/favorites', () => ({
  FavoritesPage: () => <div>favorites page</div>,
}))

vi.mock('./pages/settings', () => ({
  SettingsPage: () => <div>settings page</div>,
}))

vi.mock('./pages/cr-list-page', () => ({
  CRListPage: () => <div>cr list page</div>,
}))

vi.mock('./pages/resource-detail', () => ({
  ResourceDetail: () => <div>resource detail page</div>,
}))

vi.mock('./pages/resource-list', () => ({
  ResourceList: () => <div>resource list page</div>,
}))

vi.mock('./lib/subpath', () => ({
  getSubPath: () => '/',
}))

async function renderRouter(path: string) {
  window.history.pushState({}, '', path)
  await router.navigate(path)
  return render(<RouterProvider router={router} />)
}

describe('router', () => {
  it('renders the root app without login/setup guards', async () => {
    await renderRouter('/')

    expect(await screen.findByText('app shell')).toBeInTheDocument()
    expect(screen.queryByTestId('init-check-route')).not.toBeInTheDocument()
    expect(screen.queryByTestId('protected-route')).not.toBeInTheDocument()
  })

  it('registers the advanced networking aggregate route before generic resources', () => {
    const rootRoute = (
      router as unknown as {
        routes: Array<{ path?: string; children?: Array<{ path?: string }> }>
      }
    ).routes.find((route) => route.path === '/')

    const childPaths = rootRoute?.children?.map((route) => route.path) || []
    const advancedNetworkingIndex = childPaths.indexOf('networking/advanced')
    const resourceDetailIndex = childPaths.indexOf(':resource/:name')
    const resourceListIndex = childPaths.indexOf(':resource')

    expect(advancedNetworkingIndex).toBeGreaterThan(-1)
    expect(advancedNetworkingIndex).toBeLessThan(resourceDetailIndex)
    expect(advancedNetworkingIndex).toBeLessThan(resourceListIndex)
  })

  it('does not register /login or /setup routes', () => {
    const routes = (
      router as unknown as {
        routes: Array<{ path?: string }>
      }
    ).routes

    expect(routes.some((route) => route.path === '/login')).toBe(false)
    expect(routes.some((route) => route.path === '/setup')).toBe(false)
  })

  it('renders the dedicated favorites page before generic resource routes', async () => {
    await renderRouter('/favorites')

    expect(await screen.findByText('favorites page')).toBeInTheDocument()
    expect(screen.queryByText('resource list page')).not.toBeInTheDocument()
  })
})
