import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { dispatchDBXFiles } from '@/lib/dbx-files'
import { PodFileBrowser } from './pod-file-browser'
import { PodTerminalFileTree } from './pod-terminal-file-tree'

const { invoke, copy, refetch } = vi.hoisted(() => ({ invoke: vi.fn(), copy: vi.fn(), refetch: vi.fn() }))
vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/lib/desktop', () => ({ copyTextToClipboard: copy }))
vi.mock('@/lib/api', () => ({
  usePodFiles: () => ({ data: [{ name: 'data', isDir: true, size: '0' }], isLoading: false, refetch }),
  podListFiles: vi.fn(), podDownloadFile: vi.fn(), podPreviewFile: vi.fn(),
  podReadFileContent: vi.fn(), podUpdateFileContent: vi.fn(), podDeleteFile: vi.fn(),
  podUploadFile: (namespace: string, name: string, container: string, path: string, file: File) => {
    const form = new FormData(); form.append('file', file)
    return dispatchDBXFiles(invoke, { namespace, name, container, path }, 'upload', 'PUT', form)
  },
}))
// Expose context-menu actions without depending on pointer positioning in jsdom.
vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => <button onClick={onSelect}>{children}</button>,
  ContextMenuSeparator: () => null,
}))
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('actual Pod upload entry points', () => {
  it.each(['browser', 'tree'])('%s displays and copies the DBX fallback command', async (entry) => {
    invoke.mockResolvedValue({ context: 'prod', kubeconfigPath: '/configs/prod' })
    copy.mockResolvedValue(undefined)
    const view = render(entry === 'browser'
      ? <PodFileBrowser namespace="default" podName="web" containers={[{ name: 'app' }]} />
      : <PodTerminalFileTree namespace="default" podName="web" containerName="app" />)
    if (entry === 'tree') fireEvent.click(screen.getByRole('button', { name: 'podFiles.upload' }))
    const input = view.container.querySelector('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['x'.repeat(262145)], 'large.bin')] } })
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent("--context='prod'")
    expect(dialog).toHaveTextContent("--kubeconfig='/configs/prod'")
    expect(dialog).toHaveTextContent(entry === 'tree' ? 'default/web:/data/large.bin' : 'default/web:/large.bin')
    fireEvent.click(screen.getByRole('button', { name: 'common.copy' }))
    await waitFor(() => expect(copy).toHaveBeenCalledWith(expect.stringContaining('kubectl cp')))
    expect(invoke.mock.calls.map(([method]) => method)).toEqual(['kube/cluster-info'])
    expect(refetch).not.toHaveBeenCalled()
  })
})
