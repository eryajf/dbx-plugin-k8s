import { useMemo, useState } from 'react'
import {
  ColumnDef,
  ColumnFiltersState,
  FilterFn,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  PaginationState,
  SortingState,
  useReactTable,
} from '@tanstack/react-table'
import { ContainerImage } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'

import { formatBytes } from '@/lib/utils'

import { ResourceTableView } from './resource-table-view'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'

type NodeImageRow = {
  id: string
  primaryName: string
  sizeBytes: number
}

const arrIncludesSome: FilterFn<NodeImageRow> = (
  row,
  columnId,
  filterValue
) => {
  if (!Array.isArray(filterValue) || filterValue.length === 0) return true
  const value = String(row.getValue(columnId) ?? '')
  return filterValue.includes(value)
}

function stripImageDigest(name: string) {
  const digestIndex = name.indexOf('@')
  return digestIndex >= 0 ? name.slice(0, digestIndex) : name
}

function hasImageTag(name: string) {
  const withoutDigest = stripImageDigest(name)
  const lastSlashIndex = withoutDigest.lastIndexOf('/')
  const tagSeparatorIndex = withoutDigest.lastIndexOf(':')
  return tagSeparatorIndex > lastSlashIndex
}

function getPreferredImageName(names: string[], fallback: string) {
  const displayNames = names.map(stripImageDigest)
  const taggedDisplayName = displayNames.find(hasImageTag)
  if (taggedDisplayName) {
    return taggedDisplayName
  }

  return displayNames[0] || fallback
}

export function NodeImageTable({ images }: { images?: ContainerImage[] }) {
  const { t } = useTranslation()
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'sizeBytes', desc: true },
  ])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  })

  const rows = useMemo<NodeImageRow[]>(
    () =>
      (images || []).map((image) => {
        const names = image.names || []
        const primaryName = getPreferredImageName(names, t('common.unknown'))

        return {
          id: `${primaryName}-${image.sizeBytes || 0}-${names.join('|')}`,
          primaryName,
          sizeBytes: image.sizeBytes || 0,
        }
      }),
    [images, t]
  )

  const columns = useMemo<ColumnDef<NodeImageRow>[]>(
    () => [
      {
        accessorKey: 'primaryName',
        id: 'primaryName',
        header: t('common.name'),
        cell: ({ row }) => (
          <div
            className="min-w-0 truncate font-medium"
            title={row.original.primaryName}
          >
            {row.original.primaryName}
          </div>
        ),
      },
      {
        accessorKey: 'sizeBytes',
        id: 'sizeBytes',
        header: t('nodes.imageSize'),
        cell: ({ getValue }) => (
          <span className="text-sm text-muted-foreground tabular-nums">
            {formatBytes(Number(getValue()) || 0)}
          </span>
        ),
      },
    ],
    [t]
  )

  const columnsWithFilterFn = useMemo(
    () =>
      columns.map((column) => ({
        ...column,
        filterFn: column.filterFn ?? arrIncludesSome,
      })),
    [columns]
  )

  const table = useReactTable<NodeImageRow>({
    data: rows,
    columns: columnsWithFilterFn,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onPaginationChange: setPagination,
    getRowId: (row) => row.id,
    state: {
      sorting,
      columnFilters,
      pagination,
    },
    autoResetPageIndex: false,
  })

  const filteredRowCount = table.getFilteredRowModel().rows.length
  const totalRowCount = rows.length
  const hasActiveFilters = columnFilters.length > 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('nodes.images')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ResourceTableView
          table={table}
          columnCount={columns.length}
          isLoading={false}
          data={rows}
          emptyState={null}
          hasActiveFilters={hasActiveFilters}
          filteredRowCount={filteredRowCount}
          totalRowCount={totalRowCount}
          searchQuery=""
          pagination={pagination}
          setPagination={setPagination}
        />
      </CardContent>
    </Card>
  )
}
