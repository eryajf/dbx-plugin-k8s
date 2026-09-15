import { ResourceType, ResourceTypeMap } from '@/types/api'
import { FeatureGate } from '@/components/license/feature-gate'
import { ProFeaturePanel } from '@/components/license/pro-feature-panel'
import { ResourceHistoryTable } from '@/components/resource-history-table'

interface ProResourceHistoryTableProps<T extends ResourceType> {
  resourceType: T
  name: string
  namespace?: string
  currentResource?: ResourceTypeMap[T]
}

export function ProResourceHistoryTable<T extends ResourceType>({
  resourceType,
  name,
  namespace,
  currentResource,
}: ProResourceHistoryTableProps<T>) {
  return (
    <FeatureGate
      feature="resource.history.extended"
      fallback={<ProFeaturePanel feature="resource.history.extended" />}
    >
      <ResourceHistoryTable
        resourceType={resourceType}
        name={name}
        namespace={namespace}
        currentResource={currentResource}
      />
    </FeatureGate>
  )
}
