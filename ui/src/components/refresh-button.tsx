import { useCallback, useEffect, useRef, useState } from 'react'
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
  isFetching?: boolean
}

export function RefreshButton({
  onClick,
  minSpinMs = 1000,
  children,
  className,
  disabled,
  isFetching = false,
  ...props
}: RefreshButtonProps) {
  const [isSpinning, setIsSpinning] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const handleClick = useCallback(() => {
    if (disabled || isFetching || timerRef.current) return
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
  }, [onClick, minSpinMs, disabled, isFetching])

  return (
    <Button className={className} onClick={handleClick} disabled={disabled || isFetching || isSpinning} aria-busy={isFetching} {...props}>
      <IconRefresh className={cn('h-4 w-4', (isSpinning || isFetching) && 'animate-spin')} />
      {children}
    </Button>
  )
}
