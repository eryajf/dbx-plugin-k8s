import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ loading: vi.fn().mockReturnValue('toast'), dismiss: vi.fn(), download: vi.fn(), transport: vi.fn(), managed: vi.fn() }))
vi.mock('sonner', () => ({ toast: { loading: mocks.loading, dismiss: mocks.dismiss, info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/api/core', () => ({ podDownloadFile: mocks.download }))
vi.mock('@/lib/dbx-transport', () => ({ getDBXTransport: mocks.transport }))
vi.mock('@/lib/dbx-files', () => ({ hasManagedDownload: mocks.managed, DBXDownloadUnavailableError: class extends Error {} }))
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }))

import { downloadPodFile } from './pod-download'

describe('downloadPodFile', () => {
 it('does not offer an ineffective cancel action for non-DBX downloads', async () => {
  mocks.transport.mockReturnValue(null)
  mocks.download.mockResolvedValue('started')
  await downloadPodFile('default', 'pod', 'app', '/file', {})
  expect(mocks.loading.mock.calls[0][1].action).toBeUndefined()
  expect(mocks.dismiss).toHaveBeenCalledWith('toast')
 })
 it('does not offer cancel on a DBX host lacking managed downloads', async () => {
  mocks.loading.mockClear()
  mocks.transport.mockReturnValue({})
  mocks.managed.mockReturnValue(false)
  mocks.download.mockResolvedValue('started')
  await downloadPodFile('default', 'pod', 'app', '/file', {})
  expect(mocks.loading.mock.calls[0][1].action).toBeUndefined()
 })
 it('offers cancel for managed downloads', async () => {
  mocks.loading.mockClear()
  mocks.transport.mockReturnValue({})
  mocks.managed.mockReturnValue(true)
  mocks.download.mockResolvedValue('canceled')
  await downloadPodFile('default', 'pod', 'app', '/file', {})
  expect(mocks.loading.mock.calls[0][1].action.label).toBe('podFiles.cancelDownload')
 })
})
