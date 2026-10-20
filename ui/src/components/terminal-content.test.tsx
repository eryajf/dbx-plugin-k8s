import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import type { Pod } from 'kubernetes-types/core/v1'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { Terminal } from './terminal-content'

const websocketUrls: string[] = []
const terminalWriteLine = vi.hoisted(() => vi.fn())
const terminals = vi.hoisted(() => [] as Array<{disposed: boolean; writes: Array<{disposed: boolean; text: string}>}>)
vi.mock('sonner', () => ({toast: {warning: vi.fn()}}))
vi.mock('./connection-indicator', () => ({ConnectionIndicator: ({isConnected, onReconnect}: {isConnected: boolean; onReconnect: () => void}) => <button onClick={onReconnect}>{isConnected ? 'connected' : 'reconnect'}</button>}))
const sockets: WebSocketMock[] = []

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    loadAddon = vi.fn()
    open = vi.fn()
    disposed = false
    writes: Array<{disposed: boolean; text: string}> = []
    constructor() {terminals.push(this)}
    writeln = (text: string) => {this.write(text); terminalWriteLine(text)}
    write = (text: string) => {this.writes.push({disposed: this.disposed, text})}
    dispose = () => {this.disposed = true}
    onData = vi.fn()
    refresh = vi.fn()
    element = {
      style: {},
      addEventListener: vi.fn(),
    }
    rows = 24
    cols = 80
    options: Record<string, unknown> = {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }))
  },
}))

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {},
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()

  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, string>) =>
        options?.name ? `${key}:${options.name}` : key,
    }),
  }
})

vi.mock('@/lib/desktop-preferences', () => ({
  loadViewerPreference: vi.fn().mockResolvedValue({
    terminal: {
      theme: 'classic',
      cursorStyle: 'bar',
      fontSize: 14,
    },
  }),
  updateViewerPreference: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./pod-terminal-file-tree', () => ({
  PodTerminalFileTree: () => (
    <aside data-testid="pod-terminal-file-tree">pod file tree</aside>
  ),
}))

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

class WebSocketMock {
  static OPEN = 1
  static CLOSED = 3
  readyState = WebSocketMock.OPEN
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  constructor(url: string) {
    sockets.push(this)
    websocketUrls.push(url)
    setTimeout(() => this.onopen?.(), 0)
  }

  send() {}
  close() {}
}

beforeAll(() => {
  globalThis.ResizeObserver =
    ResizeObserverMock as unknown as typeof ResizeObserver
  globalThis.WebSocket = WebSocketMock as unknown as typeof WebSocket
})

const pods = [
  {
    metadata: {
      name: 'web-abc',
      uid: 'pod-1',
    },
  },
] as Pod[]

describe('Terminal', () => {
  beforeEach(() => {
    websocketUrls.length = 0
    sockets.length = 0
    terminalWriteLine.mockClear()
    terminals.length = 0
    vi.mocked(toast.warning).mockClear()
    localStorage.clear()
  })

  afterEach(() => {cleanup(); Reflect.deleteProperty(globalThis, 'dbxPlugin')})

  it.each(['unmount', 'reconnect', 'switch-target'] as const)('routes late cleanup rejection through global toast after %s without writing to disposed terminals', async action => {
    let rejectClose!: (error: Error) => void
    const closed = new Promise((_, reject) => {rejectClose = reject})
    let opens = 0
    const invoke = vi.fn(async (method: string) => {
      if (method === 'node/exec-open') return {sessionId: `s${++opens}`}
      if (method === 'session/read') return new Promise(() => {})
      if (method === 'session/close') return closed
      return {ok: true}
    })
    Object.assign(globalThis, {dbxPlugin: {context: {connectionId: 'cluster-a'}, invoke}})
    const view = render(<Terminal type="node" nodeName="node-a" />)
    await waitFor(() => expect(screen.getByText('connected')).toBeInTheDocument())
    if (action === 'unmount') view.unmount()
    else if (action === 'switch-target') view.rerender(<Terminal type="node" nodeName="node-b" />)
    else fireEvent.click(screen.getByText('connected'))
    if (action !== 'unmount') await waitFor(() => expect(opens).toBe(2))
    await act(async () => {rejectClose(new Error('temporary pod deletion forbidden'))})
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('node-a'), {description: 'temporary pod deletion forbidden'})
    expect(terminals[0].disposed).toBe(true)
    expect(terminals.flatMap(t => t.writes).some(w => w.disposed || w.text.includes('forbidden'))).toBe(false)
    if (action !== 'unmount') expect(screen.getByText('connected')).toBeInTheDocument()
  })

  it('toasts final cleanup warning after unmount even when close already succeeded, without late data or error writes', async () => {
    let resolveRead!: (frame: unknown) => void
    const read = new Promise(resolve => {resolveRead = resolve})
    const invoke = vi.fn(async (method: string) => {
      if (method === 'node/exec-open') return {sessionId: 'terminal'}
      if (method === 'session/read') return read
      return {closed: true}
    })
    Object.assign(globalThis, {dbxPlugin: {context: {connectionId: 'cluster-a'}, invoke}})
    const view = render(<Terminal type="node" nodeName="node-a" />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('session/read', expect.anything()))
    view.unmount()
    await act(async () => {resolveRead({sessionId: 'terminal', closed: true, warning: 'cleanup forbidden', data: 'late data', error: 'late error'})})
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('cluster-a / node-a'), {description: 'cleanup forbidden'})
    expect(terminals[0].writes.some(w => w.disposed || /late|forbidden/.test(w.text))).toBe(false)
  })

  it('keeps active warnings yellow and connected, deduplicates them, and identifies old and new sessions in late toasts', async () => {
    render(<Terminal type="node" nodeName="node-a" />)
    await waitFor(() => expect(screen.getByText('connected')).toBeInTheDocument())
    const message = {data: JSON.stringify({type: 'warning', data: 'output incomplete'})} as MessageEvent
    act(() => {sockets[0].onmessage?.(message); sockets[0].onmessage?.(message)})
    expect(terminalWriteLine.mock.calls.filter(([text]) => text.includes('output incomplete'))).toEqual([['\x1b[33moutput incomplete\x1b[0m']])
    expect(toast.warning).not.toHaveBeenCalled()
    expect(screen.getByText('connected')).toBeInTheDocument()
    fireEvent.click(screen.getByText('connected'))
    await waitFor(() => expect(sockets).toHaveLength(2))
    const late = {data: JSON.stringify({type: 'warning', data: 'cleanup forbidden'})} as MessageEvent
    act(() => {sockets[0].onmessage?.(late); sockets[0].onmessage?.(late)})
    act(() => {sockets[1].onclose?.({code: 1000} as CloseEvent); sockets[1].onmessage?.(late)})
    expect(toast.warning).toHaveBeenCalledTimes(2)
    const titles = vi.mocked(toast.warning).mock.calls.map(([title]) => title)
    expect(titles[0]).not.toBe(titles[1])
    expect(terminals.flatMap(t => t.writes).some(w => w.disposed || w.text.includes('cleanup forbidden'))).toBe(false)
  })

  it('shows a pod file tree toggle for pod terminals', () => {
    render(
      <Terminal
        type="pod"
        namespace="default"
        podName="web-abc"
        pods={pods}
        containers={[{ name: 'nginx', image: 'nginx:latest' }]}
      />
    )

    const toggle = screen.getByRole('button', {
      name: 'terminalContent.toggleFileTree',
    })
    fireEvent.click(toggle)

    expect(screen.getByTestId('pod-terminal-file-tree')).toBeInTheDocument()
  })

  it('does not show the pod file tree toggle for node terminals', () => {
    render(<Terminal type="node" nodeName="node-a" />)

    expect(
      screen.queryByRole('button', {
        name: 'terminalContent.toggleFileTree',
      })
    ).not.toBeInTheDocument()
  })

  it('uses the frozen session cluster for websocket connections', async () => {
    localStorage.setItem('current-cluster', 'cluster-b')

    render(
      <Terminal
        type="pod"
        clusterName="cluster-a"
        namespace="default"
        podName="web-abc"
        containers={[{ name: 'nginx', image: 'nginx:latest' }]}
      />
    )

    await waitFor(() => {
      expect(websocketUrls[0]).toContain('x-cluster-name=cluster-a')
    })
    expect(websocketUrls[0]).not.toContain('cluster-b')
  })

  it('translates known terminal input errors and preserves remote error details', async () => {
    render(<Terminal type="node" nodeName="node-a" />)
    await waitFor(() => expect(sockets[0]?.onmessage).toBeTypeOf('function'))
    act(() => sockets[0]?.onmessage?.({data: JSON.stringify({type: 'error', code: 'INPUT_QUEUE_FULL', data: 'English fallback'})} as MessageEvent))
    expect(terminalWriteLine).toHaveBeenCalledWith(expect.stringContaining('terminalInputErrors.queueFull'))
    act(() => sockets[0]?.onmessage?.({data: JSON.stringify({type: 'error', code: 'REMOTE_ERROR', data: 'server unavailable'})} as MessageEvent))
    expect(terminalWriteLine).toHaveBeenCalledWith(expect.stringContaining('server unavailable'))
  })
})
