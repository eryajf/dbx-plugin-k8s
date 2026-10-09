import { Suspense, useMemo, useState } from 'react'
import * as yaml from 'js-yaml'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { copyTextToClipboard, saveTextFile } from '@/lib/desktop'
import { MonacoDiffEditor, MonacoEditor } from '@/lib/monaco-loader'
import {
  defineMonacoBackgroundThemes,
  useMonacoBackgroundColor,
} from '@/lib/monaco-theme'
import { neatResource } from '@/lib/yaml-neat'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAppearance } from './appearance-provider'

/** A session-local export tool. It deliberately has no resource update callbacks. */
export function YamlNeatDialog({
  snapshot,
  onClose,
}: {
  snapshot: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { actualTheme, colorTheme } = useAppearance()
  const backgroundColor = useMonacoBackgroundColor(
    '--background',
    actualTheme === 'dark' ? 'dark' : 'light',
    colorTheme
  )
  const [comparison, setComparison] = useState(false)
  const [removeBindings, setRemoveBindings] = useState(false)
  const [exporting, setExporting] = useState(false)
  const source = useMemo(
    () => yaml.load(snapshot) as Record<string, unknown>,
    [snapshot]
  )
  const result = useMemo(
    () =>
      yaml.dump(
        neatResource(source, { removeRuntimeBindings: removeBindings }).object,
        { indent: 2, noRefs: true }
      ),
    [source, removeBindings]
  )
  const metadata = source.metadata as Record<string, unknown> | undefined
  const fileName =
    `${String(source.kind)}-${String(metadata?.name || 'resource')}`.replace(
      /[^a-zA-Z0-9._-]/g,
      '_'
    )
  const theme =
    actualTheme === 'dark'
      ? `custom-dark-${colorTheme}`
      : `custom-vs-${colorTheme}`
  const common = {
    language: 'yaml',
    theme,
    beforeMount: (monaco: Parameters<typeof defineMonacoBackgroundThemes>[0]) =>
      defineMonacoBackgroundThemes(monaco, {
        darkThemeName: `custom-dark-${colorTheme}`,
        lightThemeName: `custom-vs-${colorTheme}`,
        backgroundColor,
      }),
  }
  const exportResult = async (download: boolean) => {
    setExporting(true)
    try {
      if (download) {
        const saved = await saveTextFile({
          content: result,
          suggestedName: `${fileName}.neat.yaml`,
        })
        if (!saved.canceled) toast.success(t('yamlEditor.neat.downloaded'))
      } else {
        await copyTextToClipboard(result)
        toast.success(t('yamlEditor.neat.copied'))
      }
    } catch {
      toast.error(
        t(
          download
            ? 'yamlEditor.neat.downloadFailed'
            : 'yamlEditor.neat.copyFailed'
        )
      )
    } finally {
      setExporting(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="!max-w-6xl sm:!max-w-6xl h-[90dvh] max-h-[90dvh] flex min-h-0 flex-col">
        <DialogHeader>
          <DialogTitle>{t('yamlEditor.neat.title')}</DialogTitle>
          <p className="text-sm text-muted-foreground break-all">
            {[source.kind, metadata?.namespace, metadata?.name]
              .filter(Boolean)
              .map(String)
              .join(' / ')}
          </p>
          <DialogDescription>
            {t('yamlEditor.neat.snapshotDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2">
            <Button
              variant={comparison ? 'outline' : 'default'}
              aria-pressed={!comparison}
              onClick={() => setComparison(false)}
            >
              {t('yamlEditor.neat.result')}
            </Button>
            <Button
              variant={comparison ? 'default' : 'outline'}
              aria-pressed={comparison}
              onClick={() => setComparison(true)}
            >
              {t('yamlEditor.neat.comparison')}
            </Button>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={removeBindings}
              disabled={exporting}
              onChange={(event) => setRemoveBindings(event.target.checked)}
            />
            {t('yamlEditor.neat.removeBindings')}
          </label>
        </div>
        {removeBindings && (
          <p className="text-sm text-muted-foreground" role="note">
            {t('yamlEditor.neat.bindingWarning')}
          </p>
        )}
        {source.apiVersion === 'v1' && source.kind === 'Secret' && (
          <p className="text-sm text-muted-foreground">
            {t('yamlEditor.neat.secretNotice')}
          </p>
        )}
        {comparison && (
          <div className="grid grid-cols-2 gap-3 text-sm text-muted-foreground">
            <span>{t('yamlEditor.neat.source')}</span>
            <span>{t('yamlEditor.neat.result')}</span>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-muted-foreground">
                {t('yamlEditor.loadingEditor')}
              </div>
            }
          >
            {comparison ? (
              <MonacoDiffEditor
                {...common}
                original={snapshot}
                modified={result}
                options={{
                  readOnly: true,
                  originalEditable: false,
                  renderSideBySide: true,
                  useInlineViewWhenSpaceIsLimited: false,
                  automaticLayout: true,
                  scrollBeyondLastLine: false,
                  minimap: { enabled: false },
                  wordWrap: 'on',
                }}
              />
            ) : (
              <MonacoEditor
                {...common}
                value={result}
                options={{
                  readOnly: true,
                  automaticLayout: true,
                  scrollBeyondLastLine: false,
                  minimap: { enabled: false },
                  wordWrap: 'on',
                  tabSize: 2,
                }}
              />
            )}
          </Suspense>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('yamlEditor.neat.description')}
        </p>
        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={onClose}>
            {t('yamlEditor.neat.close')}
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={exporting}
              onClick={() => void exportResult(true)}
            >
              {t('yamlEditor.neat.downloadResult')}
            </Button>
            <Button
              disabled={exporting}
              onClick={() => void exportResult(false)}
            >
              {t('yamlEditor.neat.copyResult')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
