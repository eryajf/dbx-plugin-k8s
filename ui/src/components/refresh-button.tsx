import { useCallback, useRef, useState } from 'react'
import { IconRefresh } from '@tabler/icons-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface RefreshButtonProps extends Omit<
  React.ComponentProps<typeof Button>,
  'onClick'
> {
  onClick: () => void
  /** Minimum spin duration in ms, default 1000 */
  minSpinMs?: number
}

export function RefreshButton({
  onClick,
  minSpinMs = 1000,
  children,
  className,
  ...props
}: RefreshButtonProps) {
  const [isSpinning, setIsSpinning] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleClick = useCallback(() => {
    onClick()
    setIsSpinning(true)

    // Clear any existing timer
    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }

    timerRef.current = setTimeout(() => {
      setIsSpinning(false)
      timerRef.current = null
    }, minSpinMs)
  }, [onClick, minSpinMs])

  return (
    <Button className={className} onClick={handleClick} {...props}>
      <IconRefresh className={cn('h-4 w-4', isSpinning && 'animate-spin')} />
      {children}
    </Button>
  )
}
