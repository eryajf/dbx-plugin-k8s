import { useState } from 'react'
import { Check, CircleHelp, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

interface MonitoringChartHelpProps {
  description: string
  query: string
}

export function MonitoringChartHelp({
  description,
  query,
}: MonitoringChartHelpProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const copyQuery = async () => {
    let didCopy = false

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(query)
        didCopy = true
      } else {
        throw new Error('Clipboard API is unavailable')
      }
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = query
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      didCopy = document.execCommand('copy')
      textarea.remove()
    }

    if (didCopy) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={description}
        >
          <CircleHelp className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="left"
        sideOffset={8}
        className="max-w-[calc(100vw-2rem)] p-3 text-left leading-5 sm:max-w-[32rem]"
      >
        <p>{description}</p>
        <div className="relative mt-2">
          <button
            type="button"
            onClick={copyQuery}
            className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded text-primary-foreground/80 transition-colors hover:bg-white/15 hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground"
            aria-label={t('monitoring.copyPromQL')}
            title={t('monitoring.copyPromQL')}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded bg-black/20 p-2 pr-9 font-mono text-[10px] leading-4">
            {query}
          </pre>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
