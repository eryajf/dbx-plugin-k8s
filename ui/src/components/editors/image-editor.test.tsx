import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Container } from 'kubernetes-types/core/v1'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ImageEditor } from './image-editor'

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}))

function EditorHarness({ onUpdate }: { onUpdate: ReturnType<typeof vi.fn> }) {
  const [container, setContainer] = useState<Container>({
    name: 'web',
    image: 'nginx:1.0',
  })
  return (
    <ImageEditor
      container={container}
      onUpdate={(updates) => {
        onUpdate(updates)
        setContainer((previous) => ({ ...previous, ...updates }))
      }}
    />
  )
}

const clients: QueryClient[] = []

function renderEditor(cachedTags?: unknown) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(client)
  if (cachedTags !== undefined) {
    client.setQueryData(['image-tags', 'nginx'], cachedTags)
  }
  const onUpdate = vi.fn()
  const invoke = vi.fn()
  vi.stubGlobal('dbxPlugin', {
    context: { connectionId: 'image-editor-regression' },
    invoke,
  })
  render(
    <QueryClientProvider client={client}>
      <EditorHarness onUpdate={onUpdate} />
    </QueryClientProvider>,
  )
  const input = screen.getByRole('textbox', {
    name: 'imageEditor.containerImage',
  })
  act(() => input.focus())
  return { client, input, onUpdate, invoke }
}

afterEach(() => {
  clients.splice(0).forEach((client) => client.clear())
  vi.unstubAllGlobals()
})

describe('ImageEditor', () => {
  it.each([
    ['object', { items: [{ name: 'unexpected' }] }],
    ['string', 'not-an-array'],
    ['null', null],
    ['empty array', []],
  ])('keeps the input usable with %s in the query cache', (_, cachedTags) => {
    const { input, onUpdate } = renderEditor(cachedTags)

    expect(screen.getByText('imageEditor.noTagsAvailable')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'nginx:2.0' } })
    expect(onUpdate).toHaveBeenLastCalledWith({ image: 'nginx:2.0' })
    expect(input).toHaveValue('nginx:2.0')
  })

  it('filters invalid cached entries and strips invalid timestamps before rendering', () => {
    renderEditor([
      null,
      'invalid',
      {},
      { name: 42 },
      { name: '   ' },
      { name: 'stable', timestamp: 'not-a-date' },
      { name: 'latest', timestamp: '2026-10-13T01:00:00Z' },
    ])

    expect(screen.getByText('stable')).toBeInTheDocument()
    expect(screen.getByText('latest')).toBeInTheDocument()
    expect(screen.queryByText('Invalid Date')).not.toBeInTheDocument()
    expect(screen.queryByText('not-a-date')).not.toBeInTheDocument()
    expect(screen.queryByText('42')).not.toBeInTheDocument()
  })

  it('handles the real DBX tag request failure without Kubernetes RPC and permits repeated focus and editing', async () => {
    const { client, input, invoke, onUpdate } = renderEditor()

    await waitFor(() => {
      expect(client.getQueryState(['image-tags', 'nginx'])?.status).toBe(
        'error',
      )
    })
    expect(screen.getByText('imageEditor.noTagsAvailable')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalled()

    act(() => input.blur())
    expect(
      screen.queryByText('imageEditor.noTagsAvailable'),
    ).not.toBeInTheDocument()
    act(() => input.focus())
    expect(
      await screen.findByText('imageEditor.noTagsAvailable'),
    ).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'nginx:manual-release' } })
    expect(input).toHaveValue('nginx:manual-release')
    expect(onUpdate).toHaveBeenLastCalledWith({
      image: 'nginx:manual-release',
    })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('selects a valid tag and closes the dropdown while keeping input focus', () => {
    const { input, onUpdate } = renderEditor([{ name: '2.0' }])

    fireEvent.mouseDown(screen.getByText('2.0'))

    expect(input).toHaveValue('nginx:2.0')
    expect(onUpdate).toHaveBeenLastCalledWith({ image: 'nginx:2.0' })
    expect(screen.queryByText('2.0')).not.toBeInTheDocument()
    expect(input).toHaveFocus()
  })
})
