import { useContext, useState } from 'react'
import { IconStar, IconStarFilled } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { useFavorites } from '@/hooks/use-favorites'
import { ClusterContext } from '@/contexts/cluster-context'
import { cn, translateError } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export interface FavoriteResourceIdentity {
  name: string
  namespace?: string
  resourceType: string
  customResource?: boolean
  group?: string
  version?: string
}

interface ResourceFavoriteButtonProps {
  resource: FavoriteResourceIdentity
  className?: string
}

export function ResourceFavoriteButton({
  resource,
  className,
}: ResourceFavoriteButtonProps) {
  const { t } = useTranslation()
  const clusterContext = useContext(ClusterContext)

  if (!clusterContext) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn('h-8 w-8 shrink-0', className)}
        aria-label={t('common.favorite', 'Add to favorites')}
        title={t('common.favorite', 'Add to favorites')}
      >
        <IconStar className="h-4 w-4" />
      </Button>
    )
  }

  return <ConnectedResourceFavoriteButton resource={resource} className={className} />
}

function ConnectedResourceFavoriteButton({
  resource,
  className,
}: ResourceFavoriteButtonProps) {
  const { t } = useTranslation()
  const {
    isFavorite,
    isError,
    isLoading,
    isMutating,
    toggleFavorite,
  } = useFavorites()
  const favorite = isFavorite(resource)
  const [isToggling, setIsToggling] = useState(false)
  const isDisabled = isLoading || isError || isMutating || isToggling

  const handleToggle = async () => {
    if (isDisabled) {
      return
    }

    setIsToggling(true)
    try {
      await toggleFavorite({ ...resource, id: '', createdAt: '' })
    } catch (error) {
      toast.error(translateError(error, t))
    } finally {
      setIsToggling(false)
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn('h-8 w-8 shrink-0', className)}
      disabled={isDisabled}
      aria-busy={isLoading || isMutating || isToggling}
      aria-label={
        favorite
          ? t('common.unfavorite', 'Remove from favorites')
          : t('common.favorite', 'Add to favorites')
      }
      title={
        favorite
          ? t('common.unfavorite', 'Remove from favorites')
          : t('common.favorite', 'Add to favorites')
      }
      onClick={() => void handleToggle()}
    >
      {favorite ? (
        <IconStarFilled className="h-4 w-4 text-yellow-500" />
      ) : (
        <IconStar className="h-4 w-4" />
      )}
    </Button>
  )
}
