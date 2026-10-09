import i18n from '@/i18n'
import { copyTextToClipboard, saveTextFile } from '@/lib/desktop'
import { toast } from 'sonner'

import { useState } from 'react'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { YamlEditor } from './yaml-editor'

const originalYaml =
  'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\n'
const modifiedYaml =
  'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: changed\n'

vi.mock('@/lib/monaco-loader', () => ({
  MonacoEditor: ({
    value,
    onChange,
    options,
  }: {
    value: string
    onChange?: (value: string | undefined) => void
    options?: { readOnly?: boolean }
  }) => (
    <textarea
      aria-label="yaml-editor"
      readOnly={options?.readOnly}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
  MonacoDiffEditor: ({
    original,
    modified,
  }: {
    original: string
    modified: string
  }) => (
    <div aria-label="yaml-diff-editor">
      <pre data-testid="diff-original">{original}</pre>
      <pre data-testid="diff-modified">{modified}</pre>
    </div>
  ),
}))

describe('YamlEditor', () => {
  function ControlledYamlTab({
    initialValue = originalYaml,
    onSave,
  }: {
    initialValue?: string
    onSave?: Parameters<typeof YamlEditor<'configmaps'>>[0]['onSave']
  }) {
    const [value, setValue] = useState(initialValue)
    const [showYamlTab, setShowYamlTab] = useState(true)

    return (
      <div>
        <button onClick={() => setShowYamlTab(false)}>overview</button>
        <button onClick={() => setShowYamlTab(true)}>yaml</button>
        {showYamlTab ? (
          <YamlEditor<'configmaps'>
            value={value}
            onChange={setValue}
            onSave={onSave}
          />
        ) : null}
      </div>
    )
  }

  it('opens in view mode and switches to edit mode from the edit button', () => {
    render(<YamlEditor<'configmaps'> value={originalYaml} />)

    expect(screen.getByLabelText('yaml-editor')).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /save/i })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /edit/i }))

    expect(screen.getByLabelText('yaml-editor')).not.toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })

  it('restores the original YAML when editing is canceled', () => {
    const handleChange = vi.fn()

    render(
      <YamlEditor<'configmaps'> value={originalYaml} onChange={handleChange} />
    )

    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    fireEvent.change(screen.getByLabelText('yaml-editor'), {
      target: {
        value: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: changed\n',
      },
    })
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(screen.getByLabelText('yaml-editor')).toHaveValue(originalYaml)
    expect(handleChange).toHaveBeenLastCalledWith(originalYaml)
    expect(screen.getByLabelText('yaml-editor')).toHaveAttribute('readonly')
  })

  it('shows a diff before saving changed YAML and saves after confirmation', async () => {
    const handleSave = vi.fn().mockResolvedValue(undefined)

    render(
      <YamlEditor<'configmaps'> value={originalYaml} onSave={handleSave} />
    )

    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    fireEvent.change(screen.getByLabelText('yaml-editor'), {
      target: { value: modifiedYaml },
    })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(handleSave).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByTestId('diff-original').textContent).toBe(originalYaml)
    expect(screen.getByTestId('diff-modified').textContent).toBe(modifiedYaml)

    fireEvent.click(screen.getByRole('button', { name: /confirm save/i }))

    await waitFor(() => {
      expect(handleSave).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ name: 'changed' }),
        })
      )
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.getByLabelText('yaml-editor')).toHaveAttribute('readonly')
    })
  })

  it('continues editing from the diff dialog without saving', () => {
    const handleSave = vi.fn()

    render(
      <YamlEditor<'configmaps'> value={originalYaml} onSave={handleSave} />
    )

    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    fireEvent.change(screen.getByLabelText('yaml-editor'), {
      target: { value: modifiedYaml },
    })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    fireEvent.click(screen.getByRole('button', { name: /continue editing/i }))

    expect(handleSave).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByLabelText('yaml-editor')).not.toHaveAttribute('readonly')
  })

  it('keeps the diff open and stays editable when save returns false', async () => {
    const handleSave = vi.fn().mockResolvedValue(false)

    render(
      <YamlEditor<'configmaps'> value={originalYaml} onSave={handleSave} />
    )

    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    fireEvent.change(screen.getByLabelText('yaml-editor'), {
      target: { value: modifiedYaml },
    })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    fireEvent.click(screen.getByRole('button', { name: /confirm save/i }))

    await waitFor(() => {
      expect(handleSave).toHaveBeenCalled()
    })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('yaml-editor')).not.toHaveAttribute('readonly')
  })

  it('does not restore a failed save draft after the YAML tab remounts', async () => {
    const handleSave = vi.fn().mockResolvedValue(false)

    render(<ControlledYamlTab onSave={handleSave} />)

    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    fireEvent.change(screen.getByLabelText('yaml-editor'), {
      target: { value: modifiedYaml },
    })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    fireEvent.click(screen.getByRole('button', { name: /confirm save/i }))

    await waitFor(() => {
      expect(handleSave).toHaveBeenCalled()
    })

    fireEvent.click(screen.getByRole('button', { name: /continue editing/i }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    fireEvent.click(screen.getByRole('button', { name: /overview/i }))
    fireEvent.click(screen.getByRole('button', { name: /^yaml$/i }))

    expect(screen.getByLabelText('yaml-editor')).toHaveValue(originalYaml)
    expect(screen.getByLabelText('yaml-editor')).toHaveAttribute('readonly')
  })

  it('exits edit mode without opening diff when YAML is unchanged', () => {
    const handleSave = vi.fn()

    render(
      <YamlEditor<'configmaps'> value={originalYaml} onSave={handleSave} />
    )

    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(handleSave).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByLabelText('yaml-editor')).toHaveAttribute('readonly')
  })
})

const liveYaml = `${originalYaml}  resourceVersion: '7'\n  finalizers:\n    - example.com/cleanup\ndata:\n  greeting: hello\nstatus:\n  ready: true\n`

vi.mock('@/lib/desktop', () => ({
  copyTextToClipboard: vi.fn(),
  saveTextFile: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

describe('YamlEditor simplified export dialog', () => {
  const button = (key: string) =>
    screen.getByRole('button', {
      name: i18n.t(`yamlEditor.neat.${key}`),
      exact: true,
    })
  const editor = () =>
    within(screen.getByRole('dialog')).getByLabelText(
      'yaml-editor'
    ) as HTMLTextAreaElement
  const mainEditor = () =>
    screen.getByLabelText('yaml-editor') as HTMLTextAreaElement
  const closeDialog = () =>
    fireEvent.click(
      within(screen.getByRole('dialog')).getAllByRole('button', {
        name: i18n.t('yamlEditor.neat.close'),
        exact: true,
      })[0]
    )

  beforeEach(() => {
    vi.mocked(copyTextToClipboard).mockReset().mockResolvedValue(undefined)
    vi.mocked(saveTextFile)
      .mockReset()
      .mockResolvedValue({ canceled: false, path: '/tmp/demo.yaml' })
    vi.mocked(toast.success).mockClear()
    vi.mocked(toast.error).mockClear()
  })

  it('previews and exports read-only simplified YAML without saving the resource', async () => {
    const onSave = vi.fn()
    render(<YamlEditor<'configmaps'> value={liveYaml} onSave={onSave} />)
    fireEvent.click(button('export'))
    expect(editor()).toHaveAttribute('readonly')
    expect(editor().value).not.toContain('resourceVersion')
    expect(editor().value).not.toContain('status:')
    expect(editor().value).toContain('finalizers:')
    expect(screen.getAllByLabelText('yaml-editor')[0]).toHaveValue(liveYaml)
    fireEvent.click(button('copyResult'))
    await waitFor(() =>
      expect(copyTextToClipboard).toHaveBeenCalledWith(editor().value)
    )
    await waitFor(() => expect(button('downloadResult')).toBeEnabled())
    fireEvent.click(button('downloadResult'))
    await waitFor(() =>
      expect(saveTextFile).toHaveBeenCalledWith({
        content: editor().value,
        suggestedName: 'ConfigMap-demo.neat.yaml',
      })
    )
    fireEvent.click(button('comparison'))
    expect(screen.getByTestId('diff-original').textContent).toContain(
      'resourceVersion'
    )
    expect(screen.getByTestId('diff-modified').textContent).not.toContain(
      'resourceVersion'
    )
    expect(
      screen.queryByRole('button', { name: /confirm save/i })
    ).not.toBeInTheDocument()
    fireEvent.click(button('result'))
    expect(editor()).toHaveAttribute('readonly')
    expect(editor().value).not.toContain('resourceVersion')
    closeDialog()
    expect(mainEditor()).toHaveValue(liveYaml)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('disables export while a draft is being edited', () => {
    render(<YamlEditor<'configmaps'> value={liveYaml} />)
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    fireEvent.change(mainEditor(), { target: { value: modifiedYaml } })
    expect(button('export')).toBeDisabled()
    fireEvent.click(button('export'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mainEditor()).toHaveValue(modifiedYaml)
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(button('export')).toBeEnabled()
    expect(mainEditor()).toHaveValue(liveYaml)
  })

  it('keeps the opened snapshot fixed and resets options when reopening the latest resource', () => {
    const { rerender } = render(<YamlEditor<'configmaps'> value={liveYaml} />)
    fireEvent.click(button('export'))
    fireEvent.click(screen.getByRole('checkbox'))
    expect(editor().value).not.toContain('finalizers:')
    rerender(
      <YamlEditor<'configmaps'>
        value={liveYaml.replace('hello', 'refreshed')}
      />
    )
    expect(editor().value).toContain('hello')
    expect(editor().value).not.toContain('refreshed')
    fireEvent.click(button('comparison'))
    expect(screen.getByTestId('diff-original').textContent).toContain('hello')
    closeDialog()
    expect(mainEditor().value).toContain('refreshed')
    fireEvent.click(button('export'))
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(editor().value).toContain('refreshed')
    expect(editor().value).toContain('finalizers:')
    closeDialog()
    rerender(
      <YamlEditor<'configmaps'>
        value={liveYaml.replace('name: demo', 'name: other')}
      />
    )
    fireEvent.click(button('export'))
    expect(editor().value).toContain('name: other')
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })

  it('uses the canonical Secret snapshot for simplified preview and diff', () => {
    const source = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'secret', resourceVersion: '7' },
      data: { token: btoa('secret') },
    }
    render(
      <YamlEditor<'secrets'>
        value={
          'apiVersion: v1\nkind: Secret\nmetadata:\n  name: secret\nstringData:\n  token: secret\n'
        }
        neatSource={source}
      />
    )
    fireEvent.click(button('export'))
    expect(editor().value).toContain('c2VjcmV0')
    expect(editor().value).not.toContain('stringData')
    fireEvent.click(button('comparison'))
    expect(screen.getByTestId('diff-original').textContent).toContain(
      'c2VjcmV0'
    )
    expect(screen.getByTestId('diff-original').textContent).not.toContain(
      'stringData'
    )
  })

  it('retains the original view and reports a safe error for invalid YAML', () => {
    render(<YamlEditor<'configmaps'> value="metadata: [" />)
    fireEvent.click(button('export'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mainEditor()).toHaveValue('metadata: [')
    expect(toast.error).toHaveBeenCalledWith(i18n.t('yamlEditor.neat.invalid'))
  })

  it('silently handles a canceled download', async () => {
    vi.mocked(saveTextFile).mockResolvedValue({ canceled: true, path: '' })
    render(<YamlEditor<'configmaps'> value={liveYaml} />)
    fireEvent.click(button('export'))
    fireEvent.click(button('downloadResult'))
    await waitFor(() => expect(button('downloadResult')).toBeEnabled())
    expect(saveTextFile).toHaveBeenCalledOnce()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it.each(['original', 'simplified'] as const)(
    'reports an actual browser fallback failure when copying %s YAML',
    async (view) => {
      const desktop =
        await vi.importActual<typeof import('@/lib/desktop')>('@/lib/desktop')
      vi.mocked(copyTextToClipboard).mockImplementation(
        desktop.copyTextToClipboard
      )
      const originalCommand = Object.getOwnPropertyDescriptor(
        document,
        'execCommand'
      )
      const copy = vi.fn(() => false)
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: copy,
      })
      vi.stubGlobal('navigator', { clipboard: undefined })
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
      try {
        render(<YamlEditor<'configmaps'> value={liveYaml} />)
        if (view === 'simplified') fireEvent.click(button('export'))
        const editorCount = document.querySelectorAll('textarea').length
        fireEvent.click(button(view === 'original' ? 'copy' : 'copyResult'))
        await waitFor(() =>
          expect(toast.error).toHaveBeenCalledWith(
            i18n.t('yamlEditor.neat.copyFailed')
          )
        )
        expect(copy).toHaveBeenCalledWith('copy')
        expect(toast.success).not.toHaveBeenCalled()
        expect(document.querySelectorAll('textarea')).toHaveLength(editorCount)
      } finally {
        if (originalCommand) {
          Object.defineProperty(document, 'execCommand', originalCommand)
        } else {
          Reflect.deleteProperty(document, 'execCommand')
        }
        vi.unstubAllGlobals()
      }
    }
  )

  it.each(['copy', 'download'] as const)(
    'reports %s failures without leaking host error details',
    async (operation) => {
      const failure = new Error('host error containing secret data')
      if (operation === 'copy')
        vi.mocked(copyTextToClipboard).mockRejectedValue(failure)
      else vi.mocked(saveTextFile).mockRejectedValue(failure)
      render(<YamlEditor<'configmaps'> value={liveYaml} />)
      fireEvent.click(button('export'))
      fireEvent.click(button(`${operation}Result`))
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          i18n.t(
            `yamlEditor.neat.${operation === 'copy' ? 'copyFailed' : 'downloadFailed'}`
          )
        )
      )
      expect(toast.error).not.toHaveBeenCalledWith(failure.message)
      expect(button(`${operation}Result`)).toBeEnabled()
    }
  )
})
