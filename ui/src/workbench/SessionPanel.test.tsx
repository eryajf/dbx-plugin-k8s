import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SessionPanel from './SessionPanel'
import type { Invoke } from './types'

vi.mock('@xterm/xterm', () => ({ Terminal: class {
  loadAddon() {} open() {} reset() {} write() {} writeln() {} dispose() {}
  onData() { return { dispose() {} } }
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }))
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const resource = { group: '', version: 'v1', resource: 'pods', kind: 'Pod', namespaced: true, verbs: [] }
const object = { metadata: { name: 'web', namespace: 'test' }, spec: { containers: [{ name: 'app' }] } }
function setup(invoke = vi.fn(async (method: string) => method === 'pod/file-read' ? { content: 'hello', truncated: false } : { items: [] })) {
  render(<SessionPanel resource={resource} object={object} invoke={invoke as Invoke} onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '文件 Files' }))
  return invoke
}
function upload(content: string, name = 'note.txt') {
  const file = new File([content], name)
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(content).buffer })
  fireEvent.change(screen.getByLabelText('上传文本文件 Upload text file'), { target: { files: [file] } })
}
describe('Pod file operations', () => {
  it('confirms deletion in the page, then refreshes the directory', async () => {
    const invoke = setup()
    fireEvent.change(screen.getByLabelText('文件路径 File path'), { target: { value: '/tmp/note.txt' } })
    fireEvent.click(screen.getByRole('button', { name: '读取文件 Read' }))
    fireEvent.click(await screen.findByRole('button', { name: '删除文件 Delete' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('/tmp/note.txt')
    expect(invoke).not.toHaveBeenCalledWith('pod/file-delete', expect.anything())
    fireEvent.click(screen.getByRole('button', { name: '确认删除 Confirm delete' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('pod/files-list', expect.objectContaining({ path: '/' })))
    expect(invoke).toHaveBeenCalledWith('pod/file-delete', { namespace: 'test', name: 'web', container: 'app', path: '/tmp/note.txt' })
    expect(screen.getByLabelText('文件路径 File path')).toHaveValue('')
  })
  it('uploads UTF-8 text and refreshes without opening a session', async () => {
    const invoke = setup()
    upload('你好')
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('pod/file-write', expect.objectContaining({ path: '/note.txt', content: '你好' })))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('pod/files-list', expect.anything()))
    expect(screen.getByLabelText('文件路径 File path')).toHaveValue('/note.txt')
    expect(invoke.mock.calls.map(c => c[0])).toEqual(['pod/file-write', 'pod/files-list'])
  })
  it('rejects binary text before sending an upload', async () => {
    const invoke = setup()
    upload('a\0b')
    expect(await screen.findByRole('alert')).toHaveTextContent('UTF-8')
    expect(invoke).not.toHaveBeenCalled()
  })
  it('keeps a failed upload distinct from a failed directory refresh', async () => {
    const invoke = setup(vi.fn(async (method: string) => {
      if (method === 'pod/files-list') throw new Error('forbidden')
      return { items: [] }
    }))
    upload('ok')
    expect(await screen.findByRole('alert')).toHaveTextContent('File uploaded')
    expect(screen.getByRole('alert')).toHaveTextContent('Directory refresh failed')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})
