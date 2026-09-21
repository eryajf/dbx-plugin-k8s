import { useState } from 'react'
import { Pod } from 'kubernetes-types/core/v1'
import { Check, ChevronsUpDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn, getAge } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

interface PodSelectorProps {
  pods: Pod[]
  selectedPods?: string[]
  onPodsChange?: (podNames: string[]) => void
  selectedPod?: string
  onPodChange?: (podName?: string) => void
  placeholder?: string
  showAllOption?: boolean
}

export function PodSelector({
  pods,
  selectedPods,
  onPodsChange,
  selectedPod,
  onPodChange,
  showAllOption = false,
}: PodSelectorProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const allOption: Pod = {
    metadata: {
      name: t('selector.allPods'),
      uid: 'all',
      creationTimestamp: undefined,
    },
  }
  const options = showAllOption ? [allOption, ...pods] : pods

  const resolvedSelectedPods = selectedPods || (selectedPod ? [selectedPod] : [])
  const supportsMultipleSelection = Boolean(onPodsChange)
  const selectedLabel = resolvedSelectedPods.length === 0
    ? t('selector.allPods')
    : resolvedSelectedPods.length === 1
      ? resolvedSelectedPods[0]
      : `${resolvedSelectedPods.length} ${t('selector.selectedPods', 'pods selected')}`

  const togglePod = (podName?: string) => {
    if (!podName || podName === allOption.metadata?.name) {
      onPodsChange?.([])
      onPodChange?.(undefined)
      return
    }
    if (!supportsMultipleSelection) {
      onPodChange?.(podName)
      setOpen(false)
      return
    }
    onPodsChange?.(
      resolvedSelectedPods.includes(podName)
        ? resolvedSelectedPods.filter((name) => name !== podName)
        : [...resolvedSelectedPods, podName]
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full min-w-0 justify-between md:w-fit md:min-w-[18rem] md:max-w-[min(48rem,calc(100vw-2rem))]"
        >
          <span className="truncate">
            {selectedLabel}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-max min-w-[var(--radix-popover-trigger-width)] max-w-[min(48rem,calc(100vw-1rem))] p-0">
        <Command>
          <CommandInput placeholder={t('selector.searchPods')} />
          <CommandList>
            <CommandEmpty>{t('selector.noPodsFound')}</CommandEmpty>
            <CommandGroup>
              {options.map((pod) => (
                <CommandItem
                  key={pod.metadata?.uid}
                  value={pod.metadata?.name}
                  onSelect={togglePod}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      resolvedSelectedPods.includes(pod.metadata?.name || '') ||
                        (resolvedSelectedPods.length === 0 &&
                          pod.metadata?.name === allOption.metadata?.name)
                        ? 'opacity-100'
                        : 'opacity-0'
                    )}
                  />
                  <div className="flex min-w-0 flex-col">
                    <span className="font-medium">{pod.metadata?.name}</span>
                    {pod.metadata?.creationTimestamp && (
                      <span className="truncate text-xs text-muted-foreground">
                        {`${t('pods.age')}: ${getAge(pod.metadata?.creationTimestamp || '')}, ${t('pods.node')}: ${pod.spec?.nodeName}`}
                      </span>
                    )}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
