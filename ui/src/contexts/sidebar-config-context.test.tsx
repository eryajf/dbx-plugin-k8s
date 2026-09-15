import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SidebarConfigProvider,
  useSidebarConfig,
} from './sidebar-config-context'

const workloadsGroupId = 'sidebar-groups-workloads'
const networkGroupId = 'sidebar-groups-network'
const workloadsPodsItemId = 'sidebar-groups-workloads--pods'
const customGroupId = 'custom-my-group'
const customGroupItemId = 'custom-my-group-widgets-example-com'
let storedSidebarPreference = ''

function SidebarConfigConsumer() {
  const {
    config,
    isLoading,
    toggleItemVisibility,
    toggleItemPin,
    toggleGroupVisibility,
    toggleGroupCollapse,
    createCustomGroup,
    addCRDToGroup,
    removeCRDToGroup,
    removeCustomGroup,
    moveGroup,
  } = useSidebarConfig()

  if (isLoading || !config) {
    return <div data-testid="loading">loading</div>
  }

  const sortedGroups = [...config.groups].sort((a, b) => a.order - b.order)
  const workloadsGroup = config.groups.find(
    (group) => group.id === workloadsGroupId
  )
  const customGroup = config.groups.find((group) => group.id === customGroupId)
  const securityGroup = config.groups.find(
    (group) => group.id === 'sidebar-groups-security'
  )
  const extensionGroup = config.groups.find(
    (group) => group.id === 'sidebar-groups-extension'
  )

  return (
    <div>
      <div data-testid="group-order">
        {sortedGroups.map((group) => group.id).join(',')}
      </div>
      <div data-testid="hidden-items">{config.hiddenItems.join(',')}</div>
      <div data-testid="pinned-items">{config.pinnedItems.join(',')}</div>
      <div data-testid="workloads-visible">
        {String(workloadsGroup?.visible)}
      </div>
      <div data-testid="workloads-collapsed">
        {String(workloadsGroup?.collapsed)}
      </div>
      <div data-testid="security-collapsed">
        {String(securityGroup?.collapsed)}
      </div>
      <div data-testid="extension-collapsed">
        {String(extensionGroup?.collapsed)}
      </div>
      <div data-testid="custom-groups">
        {config.groups
          .filter((group) => group.isCustom)
          .map((group) => group.id)
          .join(',')}
      </div>
      <div data-testid="custom-items">
        {customGroup?.items.map((item) => item.id).join(',') ?? ''}
      </div>

      <button type="button" onClick={() => toggleItemPin(workloadsPodsItemId)}>
        toggle default pin
      </button>
      <button
        type="button"
        onClick={() => toggleItemVisibility(workloadsPodsItemId)}
      >
        toggle default visibility
      </button>
      <button
        type="button"
        onClick={() => toggleGroupVisibility(workloadsGroupId)}
      >
        toggle workloads visibility
      </button>
      <button
        type="button"
        onClick={() => toggleGroupCollapse(workloadsGroupId)}
      >
        toggle workloads collapse
      </button>
      <button type="button" onClick={() => moveGroup(workloadsGroupId, 'up')}>
        move workloads up
      </button>
      <button type="button" onClick={() => moveGroup(workloadsGroupId, 'down')}>
        move workloads down
      </button>
      <button type="button" onClick={() => moveGroup(networkGroupId, 'up')}>
        move network up
      </button>
      <button type="button" onClick={() => createCustomGroup('My Group')}>
        create custom group
      </button>
      <button
        type="button"
        onClick={() =>
          addCRDToGroup(customGroupId, 'widgets.example.com', 'Widget')
        }
      >
        add custom item
      </button>
      <button type="button" onClick={() => toggleItemPin(customGroupItemId)}>
        toggle custom pin
      </button>
      <button
        type="button"
        onClick={() => toggleItemVisibility(customGroupItemId)}
      >
        toggle custom visibility
      </button>
      <button
        type="button"
        onClick={() => removeCRDToGroup(customGroupId, customGroupItemId)}
      >
        remove custom item
      </button>
      <button type="button" onClick={() => removeCustomGroup(customGroupId)}>
        remove custom group
      </button>
    </div>
  )
}

async function renderProvider() {
  render(
    <SidebarConfigProvider>
      <SidebarConfigConsumer />
    </SidebarConfigProvider>
  )

  await waitFor(() =>
    expect(screen.queryByTestId('loading')).not.toBeInTheDocument()
  )
}

describe('SidebarConfigProvider', () => {
  beforeEach(() => {
    localStorage.clear()
    storedSidebarPreference = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as {
            sidebar_preference: string
          }
          storedSidebarPreference = body.sidebar_preference
          return {
            ok: true,
            status: 204,
            headers: new Headers(),
            json: async () => ({}),
            text: async () => '',
          } satisfies Partial<Response>
        }

        return {
          ok: true,
          status: 200,
          headers: new Headers({
            'content-type': 'application/json',
          }),
          json: async () => ({
            sidebar_preference: storedSidebarPreference,
          }),
          text: async () =>
            JSON.stringify({
              sidebar_preference: storedSidebarPreference,
            }),
        } satisfies Partial<Response>
      })
    )
  })

  it('persists sidebar config to the desktop preferences endpoint', async () => {
    const fetchMock = vi.mocked(fetch)

    await renderProvider()

    fireEvent.click(
      screen.getByRole('button', { name: 'toggle default visibility' })
    )

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/preferences/sidebar'),
        expect.objectContaining({ method: 'PUT' })
      )
    )
  })

  it('toggles default item pinning and visibility', async () => {
    await renderProvider()

    fireEvent.click(screen.getByRole('button', { name: 'toggle default pin' }))
    await waitFor(() =>
      expect(screen.getByTestId('pinned-items')).toHaveTextContent(
        workloadsPodsItemId
      )
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'toggle default visibility' })
    )
    await waitFor(() =>
      expect(screen.getByTestId('hidden-items')).toHaveTextContent(
        workloadsPodsItemId
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'toggle default pin' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'toggle default visibility' })
    )

    await waitFor(() => {
      expect(screen.getByTestId('pinned-items')).toBeEmptyDOMElement()
      expect(screen.getByTestId('hidden-items')).toBeEmptyDOMElement()
    })
  })

  it('toggles group visibility and collapsed state', async () => {
    await renderProvider()

    expect(screen.getByTestId('security-collapsed')).toHaveTextContent('true')
    expect(screen.getByTestId('extension-collapsed')).toHaveTextContent('true')

    fireEvent.click(
      screen.getByRole('button', { name: 'toggle workloads visibility' })
    )
    await waitFor(() =>
      expect(screen.getByTestId('workloads-visible')).toHaveTextContent('false')
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'toggle workloads collapse' })
    )
    await waitFor(() =>
      expect(screen.getByTestId('workloads-collapsed')).toHaveTextContent(
        'true'
      )
    )
  })

  it('reorders groups and ignores invalid boundary moves', async () => {
    await renderProvider()

    expect(screen.getByTestId('group-order')).toHaveTextContent(
      [
        'sidebar-groups-cluster',
        workloadsGroupId,
        networkGroupId,
        'sidebar-groups-config',
        'sidebar-groups-storage',
        'sidebar-groups-security',
        'sidebar-groups-extension',
      ].join(',')
    )

    fireEvent.click(screen.getByRole('button', { name: 'move workloads up' }))
    await waitFor(() =>
      expect(screen.getByTestId('group-order')).toHaveTextContent(
        [
          workloadsGroupId,
          'sidebar-groups-cluster',
          networkGroupId,
          'sidebar-groups-config',
          'sidebar-groups-storage',
          'sidebar-groups-security',
          'sidebar-groups-extension',
        ].join(',')
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'move workloads down' }))
    await waitFor(() =>
      expect(screen.getByTestId('group-order')).toHaveTextContent(
        [
          'sidebar-groups-cluster',
          workloadsGroupId,
          networkGroupId,
          'sidebar-groups-config',
          'sidebar-groups-storage',
          'sidebar-groups-security',
          'sidebar-groups-extension',
        ].join(',')
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'move network up' }))
    await waitFor(() =>
      expect(screen.getByTestId('group-order')).toHaveTextContent(
        [
          'sidebar-groups-cluster',
          networkGroupId,
          workloadsGroupId,
          'sidebar-groups-config',
          'sidebar-groups-storage',
          'sidebar-groups-security',
          'sidebar-groups-extension',
        ].join(',')
      )
    )
  })

  it('migrates legacy sidebar configs to the new group structure', async () => {
    storedSidebarPreference = JSON.stringify({
      version: 1,
      groups: [
        {
          id: 'sidebar-groups-workloads',
          nameKey: 'sidebar.groups.workloads',
          visible: true,
          collapsed: false,
          order: 0,
          items: [
            {
              id: workloadsPodsItemId,
              titleKey: 'nav.pods',
              url: '/pods',
              icon: 'IconBox',
              visible: true,
              pinned: false,
              order: 0,
            },
          ],
        },
        {
          id: 'sidebar-groups-other',
          nameKey: 'sidebar.groups.other',
          visible: true,
          collapsed: false,
          order: 1,
          items: [
            {
              id: 'sidebar-groups-other--nodes',
              titleKey: 'nav.nodes',
              url: '/nodes',
              icon: 'IconServer2',
              visible: true,
              pinned: false,
              order: 0,
            },
            {
              id: 'sidebar-groups-other--events',
              titleKey: 'nav.events',
              url: '/events',
              icon: 'IconBell',
              visible: true,
              pinned: false,
              order: 1,
            },
            {
              id: 'sidebar-groups-other--crds',
              titleKey: 'nav.crds',
              url: '/crds',
              icon: 'IconCode',
              visible: true,
              pinned: false,
              order: 2,
            },
          ],
        },
      ],
      hiddenItems: ['sidebar-groups-other--events'],
      pinnedItems: ['sidebar-groups-other--nodes'],
      groupOrder: ['sidebar-groups-workloads', 'sidebar-groups-other'],
      lastUpdated: Date.now(),
    })

    await renderProvider()

    expect(screen.getByTestId('group-order')).toHaveTextContent(
      [
        'sidebar-groups-cluster',
        'sidebar-groups-workloads',
        'sidebar-groups-network',
        'sidebar-groups-config',
        'sidebar-groups-storage',
        'sidebar-groups-security',
        'sidebar-groups-extension',
      ].join(',')
    )
    expect(screen.getByTestId('pinned-items')).toHaveTextContent(
      'sidebar-groups-cluster--nodes'
    )
    expect(screen.getByTestId('hidden-items')).toHaveTextContent(
      'sidebar-groups-cluster--events'
    )
    expect(screen.getByTestId('security-collapsed')).toHaveTextContent('true')
    expect(screen.getByTestId('extension-collapsed')).toHaveTextContent('true')
  })

  it('creates a custom group and manages CRD items inside it', async () => {
    await renderProvider()

    fireEvent.click(screen.getByRole('button', { name: 'create custom group' }))
    await waitFor(() =>
      expect(screen.getByTestId('custom-groups')).toHaveTextContent(
        customGroupId
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'add custom item' }))
    await waitFor(() =>
      expect(screen.getByTestId('custom-items')).toHaveTextContent(
        customGroupItemId
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'toggle custom pin' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'toggle custom visibility' })
    )

    await waitFor(() => {
      expect(screen.getByTestId('pinned-items')).toHaveTextContent(
        customGroupItemId
      )
      expect(screen.getByTestId('hidden-items')).toHaveTextContent(
        customGroupItemId
      )
    })

    fireEvent.click(screen.getByRole('button', { name: 'remove custom item' }))
    await waitFor(() => {
      expect(screen.getByTestId('custom-items')).toBeEmptyDOMElement()
      expect(screen.getByTestId('pinned-items')).not.toHaveTextContent(
        customGroupItemId
      )
      expect(screen.getByTestId('hidden-items')).not.toHaveTextContent(
        customGroupItemId
      )
    })
  })

  it('removes a custom group and clears item state tied to it', async () => {
    await renderProvider()

    fireEvent.click(screen.getByRole('button', { name: 'create custom group' }))
    fireEvent.click(screen.getByRole('button', { name: 'add custom item' }))

    await waitFor(() =>
      expect(screen.getByTestId('custom-items')).toHaveTextContent(
        customGroupItemId
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'toggle custom pin' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'toggle custom visibility' })
    )

    await waitFor(() =>
      expect(screen.getByTestId('pinned-items')).toHaveTextContent(
        customGroupItemId
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'remove custom group' }))

    await waitFor(() => {
      expect(screen.getByTestId('custom-groups')).toBeEmptyDOMElement()
      expect(screen.getByTestId('custom-items')).toBeEmptyDOMElement()
      expect(screen.getByTestId('pinned-items')).not.toHaveTextContent(
        customGroupItemId
      )
      expect(screen.getByTestId('hidden-items')).not.toHaveTextContent(
        customGroupItemId
      )
    })
  })
})
