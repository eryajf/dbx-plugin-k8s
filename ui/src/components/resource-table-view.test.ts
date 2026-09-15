import { describe, expect, it } from 'vitest'

import { shouldOverlayHeaderControls } from './resource-table-view'

describe('resource-table-view', () => {
  it('overlays header controls for centered sortable or filterable columns', () => {
    expect(shouldOverlayHeaderControls(undefined, 2, true, false)).toBeTruthy()
    expect(shouldOverlayHeaderControls(undefined, 3, false, true)).toBeTruthy()
  })

  it('keeps inline controls for left aligned columns', () => {
    expect(shouldOverlayHeaderControls('left', 1, true, true)).toBeFalsy()
  })
})
