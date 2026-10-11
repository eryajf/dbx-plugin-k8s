import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  useReactTable,
  type ColumnFiltersState,
} from '@tanstack/react-table'
import { describe, expect, it, vi } from 'vitest'

import { matchesColumnFilter } from '@/lib/column-filter-match'
import { ColumnFilterPopover } from './column-filter-popover'

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}))

function Fixture() {
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const table = useReactTable({
    data: [{ status: 'Ready' }, { status: 'NotReady' }],
    columns: [
      {
        accessorKey: 'status',
        meta: {
          filterLabel: (value) => (value === 'Ready' ? '就绪' : '未就绪'),
        },
        filterFn: (row, id, values: string[]) =>
          matchesColumnFilter(row.getValue(id), values, (value) =>
            value === 'Ready' ? '就绪' : '未就绪'
          ),
      },
    ],
    state: { columnFilters },
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  })
  return (
    <>
      <ColumnFilterPopover column={table.getColumn('status')!} />
      <output data-testid="matches">
        {table
          .getFilteredRowModel()
          .rows.map((row) => row.original.status)
          .join(',')}
      </output>
    </>
  )
}

describe('column filter labels', () => {
  it('searches displayed labels and matches original values', () => {
    render(<Fixture />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.change(
      screen.getByPlaceholderText('resourceTable.columnFilter.search'),
      { target: { value: '未就绪' } }
    )
    expect(screen.queryByText('就绪')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: /未就绪/ }))
    expect(screen.getByTestId('matches')).toHaveTextContent(/^NotReady$/)
  })
})

function RefreshFixture({ cpu, unit = '核' }: { cpu: number; unit?: string }) {
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const label = (value: unknown) =>
    `${(Number(value) / 1000).toFixed(1)} ${unit}`
  const table = useReactTable({
    data: [{ cpu }],
    columns: [
      {
        accessorKey: 'cpu',
        meta: { filterLabel: label },
        filterFn: (row, id, selected: string[]) =>
          matchesColumnFilter(row.getValue(id), selected, label),
      },
    ],
    state: { columnFilters },
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  })
  return (
    <>
      <ColumnFilterPopover column={table.getColumn('cpu')!} />
      <output data-testid="count">
        {table.getFilteredRowModel().rows.length}
      </output>
    </>
  )
}

it('keeps display groups selected after refresh and language changes, and can clear them', () => {
  const view = render(<RefreshFixture cpu={1001} />)
  fireEvent.click(screen.getByRole('button'))
  fireEvent.click(screen.getByRole('checkbox', { name: /1.0 核/ }))
  view.rerender(<RefreshFixture cpu={1002} unit="cores" />)
  expect(screen.getByTestId('count')).toHaveTextContent('1')
  expect(screen.getByRole('checkbox', { name: /1.0 cores/ })).toHaveAttribute(
    'data-state',
    'checked'
  )
  fireEvent.click(screen.getByRole('checkbox', { name: /1.0 cores/ }))
  view.rerender(<RefreshFixture cpu={2000} />)
  expect(screen.getByTestId('count')).toHaveTextContent('1')
})

it('select-all follows refreshed display groups but excludes different groups', () => {
  const view = render(<RefreshFixture cpu={1001} />)
  fireEvent.click(screen.getByRole('button'))
  fireEvent.click(
    screen.getByRole('checkbox', {
      name: 'resourceTable.columnFilter.selectAll',
    })
  )
  view.rerender(<RefreshFixture cpu={1002} />)
  expect(screen.getByTestId('count')).toHaveTextContent('1')
  view.rerender(<RefreshFixture cpu={2000} />)
  expect(screen.getByTestId('count')).toHaveTextContent('0')
})
