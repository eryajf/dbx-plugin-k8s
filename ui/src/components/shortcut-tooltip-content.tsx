import { TooltipContent } from '@/components/ui/tooltip'

export function ShortcutTooltipContent({
  label,
  shortcut,
  side = 'bottom',
}: {
  label: string
  shortcut?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
}) {
  return (
    <TooltipContent
      side={side}
      sideOffset={8}
      className="flex items-center gap-2 rounded-full border border-border/70 bg-background/95 px-3 py-2 text-foreground shadow-lg backdrop-blur-sm"
    >
      <span className="text-sm font-medium">{label}</span>
      {shortcut ? (
        <kbd className="bg-muted text-foreground inline-flex h-7 min-w-7 items-center justify-center rounded-lg border border-border px-2 font-sans text-xs font-semibold shadow-sm">
          {shortcut}
        </kbd>
      ) : null}
    </TooltipContent>
  )
}
