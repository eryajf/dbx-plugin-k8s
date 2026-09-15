import { useNavigation } from '@/contexts/navigation-context'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutTooltipContent } from '@/components/shortcut-tooltip-content'

function getNavigationShortcutLabel(direction: 'back' | 'forward') {
  if (typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)) {
    return direction === 'back' ? '⌘[' : '⌘]'
  }

  return direction === 'back' ? 'Alt+Left' : 'Alt+Right'
}

export function NavigationControls() {
  const { t } = useTranslation()
  const { canGoBack, canGoForward, goBack, goForward } = useNavigation()

  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={goBack}
              disabled={!canGoBack}
              aria-label={t('common.back', 'Back')}
              className="size-8 rounded-md text-muted-foreground hover:text-foreground disabled:text-muted-foreground/40 disabled:opacity-100"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="sr-only">{t('common.back', 'Back')}</span>
            </Button>
          </span>
        </TooltipTrigger>
        <ShortcutTooltipContent
          side="bottom"
          label={t('common.back', 'Back')}
          shortcut={getNavigationShortcutLabel('back')}
        />
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={goForward}
              disabled={!canGoForward}
              aria-label={t('common.forward', 'Forward')}
              className="size-8 rounded-md text-muted-foreground hover:text-foreground disabled:text-muted-foreground/40 disabled:opacity-100"
            >
              <ArrowRight className="h-4 w-4" />
              <span className="sr-only">{t('common.forward', 'Forward')}</span>
            </Button>
          </span>
        </TooltipTrigger>
        <ShortcutTooltipContent
          side="bottom"
          label={t('common.forward', 'Forward')}
          shortcut={getNavigationShortcutLabel('forward')}
        />
      </Tooltip>
    </div>
  )
}
