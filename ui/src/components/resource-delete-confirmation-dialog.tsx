import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { ResourceType } from '@/types/api'
import { trackResourceAction } from '@/lib/analytics'
import { deleteResource } from '@/lib/api'
import { translateError } from '@/lib/utils'

import { DeleteConfirmationDialog } from './delete-confirmation-dialog'

interface ResourceDeleteConfirmationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  resourceName: string
  resourceType: ResourceType
  namespace?: string
  additionalNote?: string
  requireNameConfirmation?: boolean
  confirmationValue?: string
}

export function ResourceDeleteConfirmationDialog({
  open,
  onOpenChange,
  resourceName,
  resourceType,
  namespace,
  additionalNote,
  requireNameConfirmation = true,
  confirmationValue,
}: ResourceDeleteConfirmationDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false)
  const navigate = useNavigate()
  const { t } = useTranslation()

  useEffect(() => {
    if (!open) {
      return
    }

    trackResourceAction(resourceType, 'delete_open')
  }, [open, resourceType])

  const handleDelete = async (force?: boolean, wait?: boolean) => {
    setIsDeleting(true)
    try {
      await deleteResource(resourceType, resourceName, namespace, {
        force,
        wait,
      })
      trackResourceAction(resourceType, 'delete', {
        result: 'success',
        force: Boolean(force),
        wait: Boolean(wait),
      })
      toast.success(
        t('detail.status.deleted', {
          resource: resourceName,
        })
      )
      navigate(`/${resourceType}`)
    } catch (error) {
      trackResourceAction(resourceType, 'delete', {
        result: 'error',
        force: Boolean(force),
        wait: Boolean(wait),
      })
      toast.error(translateError(error, t))
    } finally {
      setIsDeleting(false)
      onOpenChange(false)
    }
  }

  return (
    <DeleteConfirmationDialog
      open={open}
      onOpenChange={onOpenChange}
      resourceName={resourceName}
      resourceType={resourceType}
      onConfirm={handleDelete}
      isDeleting={isDeleting}
      namespace={namespace}
      additionalNote={additionalNote}
      showAdditionalOptions={true}
      requireNameConfirmation={requireNameConfirmation}
      confirmationValue={confirmationValue}
    />
  )
}
