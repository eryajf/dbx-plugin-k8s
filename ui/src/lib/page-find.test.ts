import { describe, expect, it } from 'vitest'

import {
  clearPageFindHighlights,
  highlightPageFindMatches,
  setCurrentPageFindMatch,
} from './page-find'

describe('page-find helpers', () => {
  it('highlights all text matches and can clear them', () => {
    document.body.innerHTML = `
      <main>
        <p>Kite helps manage Kubernetes clusters.</p>
        <p>Desktop Kite keeps the same workflow.</p>
      </main>
    `

    const matches = highlightPageFindMatches(document.body, 'kite')
    expect(matches).toHaveLength(2)
    expect(
      document.querySelectorAll('mark[data-page-find-match]')
    ).toHaveLength(2)

    clearPageFindHighlights(document.body)

    expect(
      document.querySelectorAll('mark[data-page-find-match]')
    ).toHaveLength(0)
    expect(document.body.textContent).toContain(
      'Kite helps manage Kubernetes clusters.'
    )
  })

  it('skips ignored containers and updates the current match marker', () => {
    document.body.innerHTML = `
      <main>
        <p>Kite desktop</p>
        <div data-page-find-ignore="true">Kite hidden</div>
        <p>Kite visible</p>
      </main>
    `

    const matches = highlightPageFindMatches(document.body, 'kite')
    expect(matches).toHaveLength(2)

    setCurrentPageFindMatch(matches, 1, false)

    expect(matches[0].hasAttribute('data-page-find-current')).toBe(false)
    expect(matches[1].hasAttribute('data-page-find-current')).toBe(true)
  })
})
