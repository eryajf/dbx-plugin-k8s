import type { ReactNode } from 'react'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'

interface MonitoringChartFullscreenProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: ReactNode
}

export function MonitoringChartFullscreen({
  open,
  onOpenChange,
  title,
  children,
}: MonitoringChartFullscreenProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[calc(100dvh-1rem)] !max-w-[calc(100vw-1rem)] flex-col gap-0 overflow-hidden p-0 sm:!max-w-[calc(100vw-1rem)]">
        <DialogHeader className="border-b px-6 py-5 pr-12">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 p-4 sm:p-6">{children}</div>
      </DialogContent>
    </Dialog>
  )
}
