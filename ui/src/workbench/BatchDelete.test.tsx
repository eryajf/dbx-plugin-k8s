import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BatchDelete } from './BatchDelete'
import type { Invoke } from './types'
afterEach(cleanup)
const resource = { group: '', version: 'v1', resource: 'pods', kind: 'Pod', namespaced: true, verbs: ['delete'] }
const objects = ['one', 'two'].map((name, i) => ({ metadata: { name, namespace: 'test', uid: `uid-${i}`, resourceVersion: '7' } }))
function open() { fireEvent.click(screen.getByRole('button', { name: 'Delete selected (2)' })) }
describe('batch deletion', () => {
  it('requires confirmation, preserves preconditions and reports partial failure', async () => {
    const invoke = vi.fn(async (_method: string, p?: Record<string, unknown>) => {
      if (p?.name === 'two') throw new Error('forbidden')
      return { deleted: true }
    })
    const onDeleted = vi.fn()
    render(<BatchDelete resource={resource} objects={objects} invoke={invoke as Invoke} connectionLabel="local-test" zh={false} onDeleted={onDeleted} />)
    open()
    expect(screen.getByRole('alertdialog')).toHaveTextContent('local-test')
    expect(invoke).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Accepted: 1 · Failed: 1'))
    expect(invoke).toHaveBeenNthCalledWith(1, 'resource/delete', { group: '', version: 'v1', resource: 'pods', namespace: 'test', name: 'one', uid: 'uid-0', resourceVersion: '7' })
    expect(screen.getByRole('alertdialog')).toHaveTextContent('forbidden')
    expect(onDeleted).toHaveBeenCalledWith(['uid-0'])
  })
  it('keeps the confirmed list when selection changes', async () => {
    const invoke = vi.fn(async () => ({}))
    const props = { resource, invoke: invoke as Invoke, connectionLabel: 'local', zh: false, onDeleted: vi.fn() }
    const view = render(<BatchDelete {...props} objects={objects} />)
    open()
    view.rerender(<BatchDelete {...props} objects={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
  })
  it('does not send more deletions after leaving the page', async () => {
    let resolve!: (value: object) => void
    const invoke = vi.fn(() => new Promise(r => { resolve = r }))
    const onDeleted = vi.fn()
    const view = render(<BatchDelete resource={resource} objects={objects} invoke={invoke as Invoke} connectionLabel="local" zh={false} onDeleted={onDeleted} />)
    open(); fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion' }))
    expect(invoke).toHaveBeenCalledTimes(1)
    view.unmount(); resolve({})
    await Promise.resolve(); await Promise.resolve()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(onDeleted).not.toHaveBeenCalled()
  })
  it('refuses objects without a complete identity', async () => {
    const invoke = vi.fn()
    render(<BatchDelete resource={resource} objects={objects.map(o => ({ metadata: { ...o.metadata, uid: undefined } }))} invoke={invoke as Invoke} connectionLabel="local" zh={false} onDeleted={() => {}} />)
    open(); fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Failed: 2'))
    expect(invoke).not.toHaveBeenCalled()
  })
})
