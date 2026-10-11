import type { RowData } from '@tanstack/react-table'

declare module '@tanstack/react-table' {
  // Keep sorting and persisted filters independent of localized display text.
  // TData is required by the upstream declaration.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    align?: 'left' | 'center' | 'right'
    filterLabel?(value: TValue): string
  }
}
