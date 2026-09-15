const PAGE_FIND_MATCH_ATTR = 'data-page-find-match'
const PAGE_FIND_CURRENT_ATTR = 'data-page-find-current'

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'BUTTON',
  'MARK',
])

function shouldSkipTextNode(node: Text) {
  const parent = node.parentElement
  if (!parent) {
    return true
  }

  if (!node.nodeValue?.trim()) {
    return true
  }

  if (SKIP_TAGS.has(parent.tagName)) {
    return true
  }

  if (parent.closest('[data-page-find-ignore="true"]')) {
    return true
  }

  if (parent.closest('[hidden], [aria-hidden="true"]')) {
    return true
  }

  if (parent.closest('.monaco-editor')) {
    return true
  }

  return parent.isContentEditable
}

export function clearPageFindHighlights(root: ParentNode) {
  const marks = Array.from(
    root.querySelectorAll<HTMLElement>(`mark[${PAGE_FIND_MATCH_ATTR}]`)
  )

  if (marks.length === 0) {
    return
  }

  const parents = new Set<ParentNode>()
  for (const mark of marks) {
    const parent = mark.parentNode
    if (!parent) {
      continue
    }
    parents.add(parent)
    parent.replaceChild(document.createTextNode(mark.textContent || ''), mark)
  }

  for (const parent of parents) {
    parent.normalize()
  }
}

export function highlightPageFindMatches(root: ParentNode, query: string) {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) {
    return [] as HTMLElement[]
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return shouldSkipTextNode(node as Text)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
    },
  })

  const textNodes: Text[] = []
  let currentNode = walker.nextNode()
  while (currentNode) {
    textNodes.push(currentNode as Text)
    currentNode = walker.nextNode()
  }

  const matches: HTMLElement[] = []
  const queryLower = normalizedQuery.toLocaleLowerCase()

  for (const textNode of textNodes) {
    const text = textNode.nodeValue || ''
    const textLower = text.toLocaleLowerCase()
    let searchFrom = 0
    let foundAt = textLower.indexOf(queryLower, searchFrom)

    if (foundAt === -1) {
      continue
    }

    const fragment = document.createDocumentFragment()
    while (foundAt !== -1) {
      if (foundAt > searchFrom) {
        fragment.appendChild(
          document.createTextNode(text.slice(searchFrom, foundAt))
        )
      }

      const mark = document.createElement('mark')
      mark.setAttribute(PAGE_FIND_MATCH_ATTR, 'true')
      mark.className =
        'rounded-[2px] bg-amber-200 px-0 text-inherit dark:bg-amber-700/60'
      mark.textContent = text.slice(foundAt, foundAt + normalizedQuery.length)
      fragment.appendChild(mark)
      matches.push(mark)

      searchFrom = foundAt + normalizedQuery.length
      foundAt = textLower.indexOf(queryLower, searchFrom)
    }

    if (searchFrom < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(searchFrom)))
    }

    textNode.parentNode?.replaceChild(fragment, textNode)
  }

  return matches
}

export function setCurrentPageFindMatch(
  matches: HTMLElement[],
  nextIndex: number,
  scrollIntoView = true
) {
  for (const match of matches) {
    match.removeAttribute(PAGE_FIND_CURRENT_ATTR)
    match.classList.remove('bg-amber-400', 'dark:bg-amber-500')
    match.classList.add('bg-amber-200', 'dark:bg-amber-700/60')
  }

  if (nextIndex < 0 || nextIndex >= matches.length) {
    return
  }

  const current = matches[nextIndex]
  current.setAttribute(PAGE_FIND_CURRENT_ATTR, 'true')
  current.classList.remove('bg-amber-200', 'dark:bg-amber-700/60')
  current.classList.add('bg-amber-400', 'dark:bg-amber-500')

  if (scrollIntoView) {
    current.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    })
  }
}
