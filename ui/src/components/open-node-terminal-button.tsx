import { useTerminal } from '@/contexts/terminal-context'
import { TerminalSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useFeature } from '@/hooks/use-license'
import { Button } from '@/components/ui/button'

interface OpenNodeTerminalButtonProps {
  nodeName?: string
  variant?: React.ComponentProps<typeof Button>['variant']
  size?: React.ComponentProps<typeof Button>['size']
  label?: string
  iconOnly?: boolean
}

export function OpenNodeTerminalButton({
  nodeName,
  variant = 'outline',
  size = 'sm',
  label,
  iconOnly = false,
}: OpenNodeTerminalButtonProps) {
  const { t } = useTranslation()
  const { openSession } = useTerminal()
  const canUseNodeTerminal = useFeature('terminal.node')
  const buttonLabel = label ?? t('terminalLauncher.open', 'Open terminal')
  const upgradeLabel = t('terminalLauncher.proRequired', 'Requires Pro')

  return (
    <Button
      variant={variant}
      size={size}
      disabled={!nodeName || !canUseNodeTerminal}
      title={canUseNodeTerminal ? buttonLabel : upgradeLabel}
      aria-label={buttonLabel}
      onClick={() => {
        if (!nodeName || !canUseNodeTerminal) return
        openSession({
          type: 'node',
          nodeName,
          title: nodeName,
          source: `node/${nodeName}`,
          entry: 'resource-action',
        })
      }}
    >
      <TerminalSquare className="h-4 w-4" />
      {iconOnly ? <span className="sr-only">{buttonLabel}</span> : buttonLabel}
    </Button>
  )
}
