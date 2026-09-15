import { useCallback, useMemo, useRef, useState } from 'react'
import { Column } from '@tanstack/react-table'
import { ListFilter } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

interface ColumnFilterPopoverProps<TData> {
  column: Column<TData, unknown>
}

export function ColumnFilterPopover<TData>({
  column,
}: ColumnFilterPopoverProps<TData>) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const filterValue = column.getFilterValue()
  const hasActiveFilter = Array.isArray(filterValue)
    ? filterValue.length > 0
    : false

  // Skip columns whose values are all objects (not suitable for filtering)
  const facetedValues = column.getFacetedUniqueValues()
  const allObjects = useMemo(() => {
    if (facetedValues.size === 0) return true
    return Array.from(facetedValues.keys()).every(
      (v) => v != null && typeof v === 'object'
    )
  }, [facetedValues])

  if (allObjects) return null

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          className={cn(
            'inline-flex items-center justify-center rounded-sm p-0.5 transition-opacity',
            hasActiveFilter || open
              ? 'opacity-100 text-primary'
              : 'opacity-0 group-hover/header:opacity-60 hover:!opacity-100',
            'hover:bg-accent'
          )}
        >
          <ListFilter className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-fit min-w-[8rem] max-w-[20rem] p-1.5"
        align="start"
        side="bottom"
        sideOffset={6}
        sticky="always"
        collisionPadding={8}
      >
        <FacetedFilterContent
          column={column}
          search={search}
          onSearchChange={setSearch}
          hasActiveFilter={hasActiveFilter}
          t={t}
        />
      </PopoverContent>
    </Popover>
  )
}

function FacetedFilterContent<TData>({
  column,
  search,
  onSearchChange,
  hasActiveFilter,
  t,
}: {
  column: Column<TData, unknown>
  search: string
  onSearchChange: (search: string) => void
  hasActiveFilter: boolean
  t: (key: string) => string
}) {
  const facetedValues = column.getFacetedUniqueValues()
  const listRef = useRef<HTMLDivElement>(null)
  const [highlightIndex, setHighlightIndex] = useState(-1)

  const selectedValues = useMemo(() => {
    const val = column.getFilterValue()
    return Array.isArray(val)
      ? new Set<string>(val as string[])
      : new Set<string>()
  }, [column.getFilterValue()])

  const sortedEntries = useMemo(() => {
    return Array.from(facetedValues.entries())
      .filter(([value]) => value != null && String(value) !== '')
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  }, [facetedValues])

  const filteredEntries = useMemo(() => {
    if (!search) return sortedEntries
    const lower = search.toLowerCase()
    return sortedEntries.filter(([value]) =>
      String(value).toLowerCase().includes(lower)
    )
  }, [sortedEntries, search])

  // "Select All" is index 0, items start at index 1
  const totalItems = filteredEntries.length > 0 ? filteredEntries.length + 1 : 0

  const allFilteredSelected = useMemo(() => {
    if (filteredEntries.length === 0) return false
    return filteredEntries.every(([value]) => selectedValues.has(String(value)))
  }, [filteredEntries, selectedValues])

  const handleToggle = useCallback(
    (value: string) => {
      const next = new Set(selectedValues)
      if (next.has(value)) {
        next.delete(value)
      } else {
        next.add(value)
      }
      column.setFilterValue(next.size > 0 ? Array.from(next) : undefined)
    },
    [selectedValues, column]
  )

  const handleSelectAll = useCallback(() => {
    if (allFilteredSelected) {
      const next = new Set(selectedValues)
      filteredEntries.forEach(([value]) => next.delete(String(value)))
      column.setFilterValue(next.size > 0 ? Array.from(next) : undefined)
    } else {
      const next = new Set(selectedValues)
      filteredEntries.forEach(([value]) => next.add(String(value)))
      column.setFilterValue(Array.from(next))
    }
  }, [allFilteredSelected, selectedValues, filteredEntries, column])

  const scrollToIndex = useCallback((index: number) => {
    if (!listRef.current) return
    const items = listRef.current.querySelectorAll('[data-filter-item]')
    items[index]?.scrollIntoView({ block: 'nearest' })
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (totalItems === 0) return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = highlightIndex < totalItems - 1 ? highlightIndex + 1 : 0
        setHighlightIndex(next)
        scrollToIndex(next)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const next = highlightIndex > 0 ? highlightIndex - 1 : totalItems - 1
        setHighlightIndex(next)
        scrollToIndex(next)
      } else if (e.key === 'Enter' || e.key === ' ') {
        if (highlightIndex < 0) return
        e.preventDefault()
        if (highlightIndex === filteredEntries.length) {
          handleSelectAll()
        } else {
          const entry = filteredEntries[highlightIndex]
          if (entry) handleToggle(String(entry[0]))
        }
      }
    },
    [
      totalItems,
      highlightIndex,
      handleSelectAll,
      handleToggle,
      filteredEntries,
      scrollToIndex,
    ]
  )

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onSearchChange(e.target.value)
      setHighlightIndex(-1)
    },
    [onSearchChange]
  )

  return (
    <div className="space-y-1">
      <input
        placeholder={t('resourceTable.columnFilter.search')}
        value={search}
        onChange={handleSearchChange}
        onKeyDown={handleKeyDown}
        size={1}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        className="flex h-7 w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div ref={listRef} className="max-h-40 overflow-auto space-y-px">
        {filteredEntries.map(([value, count], idx) => {
          const strVal = String(value)
          return (
            <label
              key={strVal}
              data-filter-item
              className={cn(
                'flex items-center gap-1.5 px-1 py-0.5 cursor-pointer text-xs rounded',
                highlightIndex === idx ? 'bg-accent' : 'hover:bg-accent'
              )}
            >
              <Checkbox
                className="h-3.5 w-3.5"
                checked={selectedValues.has(strVal)}
                onCheckedChange={() => handleToggle(strVal)}
              />
              <span className="flex-1 truncate">{strVal}</span>
              <span className="text-muted-foreground text-[10px] shrink-0">
                {count}
              </span>
            </label>
          )
        })}
        {filteredEntries.length > 0 && (
          <label
            data-filter-item
            className={cn(
              'flex items-center gap-1.5 px-1 py-0.5 cursor-pointer text-xs rounded',
              highlightIndex === filteredEntries.length
                ? 'bg-accent'
                : 'hover:bg-accent'
            )}
          >
            <Checkbox
              className="h-3.5 w-3.5"
              checked={allFilteredSelected}
              onCheckedChange={handleSelectAll}
            />
            <span className="font-medium">
              {t('resourceTable.columnFilter.selectAll')}
            </span>
          </label>
        )}
        {filteredEntries.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-1.5">
            {t('resourceTable.columnFilter.noResults')}
          </p>
        )}
      </div>
      {hasActiveFilter && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full h-6 text-xs"
          onClick={() => {
            column.setFilterValue(undefined)
            onSearchChange('')
            setHighlightIndex(-1)
          }}
        >
          {t('resourceTable.columnFilter.clear')}
        </Button>
      )}
    </div>
  )
}
