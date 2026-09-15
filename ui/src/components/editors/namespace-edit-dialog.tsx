import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Namespace, ResourceQuota } from 'kubernetes-types/core/v1'
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Plus,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { createResource, updateResource } from '@/lib/api'
import {
  composeQuotaValue,
  getQuotaUnitOptions,
  NAMESPACE_RESOURCE_QUOTA_GROUPS,
  NAMESPACE_RESOURCE_QUOTA_KEY_OPTIONS,
  parseQuotaValue,
  quotaEntriesToHardRecord,
  resourceQuotaToEntries,
  type NamespaceResourceQuotaEntry,
  type NamespaceResourceQuotaGroupKey,
} from '@/lib/namespace-resource-quota'
import { translateError } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface NamespaceEditDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  namespace: Namespace | null
  resourceQuota: ResourceQuota | null
  hasMultipleResourceQuotas?: boolean
}

function updateQuotaHard(
  resourceQuota: ResourceQuota,
  entries: NamespaceResourceQuotaEntry[]
) {
  const nextHard = quotaEntriesToHardRecord(entries)

  return {
    ...resourceQuota,
    spec: {
      ...(resourceQuota.spec || {}),
      hard: nextHard,
    },
  }
}

export function NamespaceEditDialog({
  open,
  onOpenChange,
  namespace,
  resourceQuota,
  hasMultipleResourceQuotas = false,
}: NamespaceEditDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [entries, setEntries] = useState<NamespaceResourceQuotaEntry[]>([])
  const [openGroups, setOpenGroups] = useState<
    Record<NamespaceResourceQuotaGroupKey, boolean>
  >({
    compute: true,
    storage: false,
    other: false,
  })
  const [isSaving, setIsSaving] = useState(false)

  const namespaceName = namespace?.metadata?.name || ''

  useEffect(() => {
    if (!open || !namespace) {
      return
    }

    setEntries(resourceQuotaToEntries(resourceQuota))
    setOpenGroups({
      compute: true,
      storage: false,
      other: false,
    })
    setIsSaving(false)
  }, [namespace, open, resourceQuota])

  const resolvedEntries = useMemo(
    () => (entries.length > 0 ? entries : []),
    [entries]
  )
  const standardEntries = resolvedEntries.filter((entry) => !entry.isCustomKey)
  const customEntries = resolvedEntries
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => entry.isCustomKey)
  const standardEntryMap = useMemo(
    () =>
      standardEntries.reduce<Record<string, NamespaceResourceQuotaEntry>>(
        (result, entry) => {
          result[entry.key] = entry
          return result
        },
        {}
      ),
    [standardEntries]
  )

  const handleEntryChange = (
    targetKey: string,
    isCustomKey: boolean,
    updates: Partial<NamespaceResourceQuotaEntry>
  ) => {
    setEntries((current) =>
      current.map((entry) =>
        entry.key === targetKey && entry.isCustomKey === isCustomKey
          ? { ...entry, ...updates }
          : entry
      )
    )
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!namespace || !namespaceName) {
      return
    }

    setIsSaving(true)

    try {
      if (!hasMultipleResourceQuotas) {
        const nextHard = quotaEntriesToHardRecord(entries)
        const hasQuotaValues = Object.keys(nextHard).length > 0

        if (resourceQuota) {
          const updatedQuota = updateQuotaHard(resourceQuota, entries)

          if (hasQuotaValues) {
            await updateResource(
              'resourcequotas',
              resourceQuota.metadata?.name || `${namespaceName}-quota`,
              namespaceName,
              updatedQuota
            )
          }
        } else if (hasQuotaValues) {
          await createResource('resourcequotas', namespaceName, {
            apiVersion: 'v1',
            kind: 'ResourceQuota',
            metadata: {
              name: `${namespaceName}-quota`,
              namespace: namespaceName,
            },
            spec: {
              hard: nextHard,
            },
          })
        }
      }

      await queryClient.invalidateQueries({ queryKey: ['resourcequotas'] })

      toast.success(
        t('namespaceEditDialog.success', {
          defaultValue: 'Namespace updated successfully',
          name: namespaceName,
        })
      )
      onOpenChange(false)
    } catch (error) {
      toast.error(translateError(error, t))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] flex-col overflow-hidden sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            {t('namespaceEditDialog.title', {
              defaultValue: 'Edit namespace',
            })}
          </DialogTitle>
          <DialogDescription>
            {t('namespaceEditDialog.description', {
              defaultValue: 'Update namespace resource quota limits.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          onSubmit={handleSubmit}
        >
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="namespace-name-readonly">
                {t('common.name')}
              </Label>
              <Input
                id="namespace-name-readonly"
                value={namespaceName}
                disabled
              />
            </div>

            <div className="rounded-lg border bg-muted/30 p-4">
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {t('namespaceEditDialog.resourceQuotaGuideTitle')}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t('namespaceEditDialog.resourceQuotaGuideDescription')}
                </p>
              </div>
              <a
                href="https://kubernetes.io/zh-cn/docs/concepts/policy/resource-quotas"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
              >
                {t('namespaceEditDialog.resourceQuotaGuideLink')}
                <ExternalLink className="h-4 w-4" />
              </a>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="space-y-4 rounded-lg border p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label className="text-sm font-medium">
                    {t('namespaceEditDialog.resourceQuotaTitle', {
                      defaultValue: 'Resource quota limits',
                    })}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {hasMultipleResourceQuotas
                      ? t('namespaceEditDialog.multipleQuotasHint', {
                          defaultValue:
                            'Multiple ResourceQuota objects were found. Quick edit is disabled for resource quota limits.',
                        })
                      : t('namespaceEditDialog.resourceQuotaHint', {
                          defaultValue:
                            'Edit namespace-level resource quota items directly, including CPU, memory, object counts, and storage requests.',
                        })}
                  </p>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t('namespaceEditDialog.addCustomQuotaItem')}
                  disabled={hasMultipleResourceQuotas}
                  onClick={() =>
                    setEntries((current) => [
                      { key: '', value: '', isCustomKey: true },
                      ...current,
                    ])
                  }
                >
                  <Plus className="h-4 w-4" />
                  {t('namespaceEditDialog.addCustomQuotaItem')}
                </Button>
              </div>

              <div className="space-y-4">
                {NAMESPACE_RESOURCE_QUOTA_GROUPS.map((group) => (
                  <Collapsible
                    key={group.key}
                    open={openGroups[group.key]}
                    onOpenChange={(nextOpen) =>
                      setOpenGroups((current) => ({
                        ...current,
                        [group.key]: nextOpen,
                      }))
                    }
                  >
                    <div className="rounded-lg border">
                      <CollapsibleTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          className="flex w-full items-center justify-between rounded-lg px-4 py-3"
                          aria-label={t(group.labelKey)}
                        >
                          <span className="font-medium">
                            {t(group.labelKey)}
                          </span>
                          {openGroups[group.key] ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="px-4 pb-4">
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                          {group.optionValues.map((value) => {
                            const entry = standardEntryMap[value]
                            if (!entry) {
                              return null
                            }

                            const fieldLabel = t(
                              NAMESPACE_RESOURCE_QUOTA_KEY_OPTIONS.find(
                                (option) => option.value === entry.key
                              )?.labelKey || entry.key
                            )
                            const parsedValue = parseQuotaValue(
                              entry.key,
                              entry.value
                            )
                            const unitOptions = getQuotaUnitOptions(entry.key)
                            const inputId = `namespace-quota-${entry.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
                            const unitId = `${inputId}-unit`

                            return (
                              <div
                                key={entry.key}
                                className="space-y-3 rounded-md border border-dashed p-4"
                              >
                                <Label
                                  htmlFor={inputId}
                                  className="text-sm font-medium text-foreground"
                                >
                                  {fieldLabel}
                                </Label>
                                <div className="flex items-center">
                                  <Input
                                    id={inputId}
                                    aria-label={fieldLabel}
                                    className="min-w-0 flex-1 rounded-r-none"
                                    value={parsedValue.amount}
                                    onChange={(event) =>
                                      handleEntryChange(entry.key, false, {
                                        value: composeQuotaValue(
                                          entry.key,
                                          event.target.value,
                                          parsedValue.unit
                                        ),
                                      })
                                    }
                                    placeholder={t(
                                      'namespaceEditDialog.valuePlaceholder'
                                    )}
                                    disabled={hasMultipleResourceQuotas}
                                  />

                                  {unitOptions.length > 1 ? (
                                    <div className="shrink-0">
                                      <Select
                                        value={parsedValue.unit}
                                        onValueChange={(nextUnit) =>
                                          handleEntryChange(entry.key, false, {
                                            value: composeQuotaValue(
                                              entry.key,
                                              parsedValue.amount,
                                              nextUnit
                                            ),
                                          })
                                        }
                                        disabled={hasMultipleResourceQuotas}
                                      >
                                        <SelectTrigger
                                          id={unitId}
                                          aria-label={`${fieldLabel} ${t('namespaceEditDialog.unitLabel')}`}
                                          className="min-w-[4.75rem] rounded-l-none border-l-0 px-4"
                                        >
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {unitOptions.map((option) => (
                                            <SelectItem
                                              key={`${entry.key}-${option.value || 'default'}`}
                                              value={option.value}
                                            >
                                              {t(option.labelKey)}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                  ) : (
                                    <div className="flex h-9 min-w-[4.75rem] shrink-0 items-center rounded-l-none rounded-r-md border border-l-0 bg-muted px-4 text-sm text-muted-foreground">
                                      <span
                                        id={unitId}
                                        aria-label={`${fieldLabel} ${t('namespaceEditDialog.unitLabel')}`}
                                      >
                                        {t(unitOptions[0]?.labelKey || '')}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                ))}

                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label className="text-sm font-medium">
                      {t('namespaceEditDialog.customQuotaSectionTitle')}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {t('namespaceEditDialog.customQuotaSectionHint')}
                    </p>
                  </div>

                  {customEntries.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t('namespaceEditDialog.emptyCustomQuotaItems')}
                    </p>
                  ) : null}

                  {customEntries.map((entry) => (
                    <div
                      key={`custom-quota-entry-${entry.index}`}
                      className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto]"
                    >
                      <div className="space-y-2">
                        <Label className="text-xs text-muted-foreground">
                          {t('namespaceEditDialog.quotaKey')}
                        </Label>
                        <Input
                          value={entry.key}
                          onChange={(event) =>
                            handleEntryChange(entry.key, true, {
                              key: event.target.value,
                            })
                          }
                          placeholder={t(
                            'namespaceEditDialog.customQuotaKeyPlaceholder'
                          )}
                          disabled={hasMultipleResourceQuotas}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label className="text-xs text-muted-foreground">
                          {t('namespaceEditDialog.quotaValue')}
                        </Label>
                        <Input
                          value={entry.value}
                          onChange={(event) =>
                            handleEntryChange(entry.key, true, {
                              value: event.target.value,
                            })
                          }
                          placeholder={t(
                            'namespaceEditDialog.valuePlaceholder'
                          )}
                          disabled={hasMultipleResourceQuotas}
                        />
                      </div>

                      <div className="flex items-end justify-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={t('common.remove', 'Remove')}
                          disabled={hasMultipleResourceQuotas}
                          onClick={() =>
                            setEntries((current) =>
                              current.filter(
                                (_, itemIndex) => itemIndex !== entry.index
                              )
                            )
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="mt-4 shrink-0 border-t pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={isSaving || !namespaceName}>
              {isSaving
                ? t('common.saving', 'Saving')
                : t('common.save', 'Save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
