import { describe, expect, it, vi } from 'vitest'
import { KiteSessionTransport } from './kite-session-transport'

describe('KiteSessionTransport', () => {
  it('routes lifecycle calls with connection isolation', async () => {
    const invoke = vi.fn(async (_m: string, p: Record<string, unknown>) => ({ sessionId: String(p.sessionId ?? 's') }))
    const t = new KiteSessionTransport(invoke, 'cluster-a')
    await t.openExec({ namespace: 'ns', name: 'pod', container: 'app' })
    await t.write('s', 'ls\n')
    await t.resize('s', 80, 24)
    await t.close('s')
    expect(invoke.mock.calls.map(c => c[0])).toEqual(['pod/exec-open', 'pod/exec-write', 'pod/exec-resize', 'session/close'])
    expect(invoke.mock.calls.every(([, p]) => p.connectionId === 'cluster-a')).toBe(true)
  })
  it('exposes file and forwarding operations', async () => {
    const invoke = vi.fn(async () => ({}))
    const t = new KiteSessionTransport(invoke, 'c')
    await t.listFiles({ namespace: 'n', name: 'p', path: '/' })
    await t.readFile({ namespace: 'n', name: 'p', path: '/a' })
    await t.writeFile({ namespace: 'n', name: 'p', path: '/a', content: 'x' })
    await t.deleteFile({ namespace: 'n', name: 'p', path: '/a' })
    await t.openPortForward({ namespace: 'n', name: 'p', ports: [{ localPort: 1, remotePort: 2 }] })
    expect(invoke.mock.calls.map(c => c[0])).toEqual(['pod/files-list','pod/file-read','pod/file-write','pod/file-delete','port-forward/open'])
  })
})
