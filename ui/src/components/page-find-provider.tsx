/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useRuntime } from '@/contexts/runtime-context'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'

import {
  clearPageFindHighlights,
  highlightPageFindMatches,
  setCurrentPageFindMatch,
} from '@/lib/page-find'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const PAGE_FIND_OPEN_EVENT = 'kite:page-find-open'
const PAGE_FIND_NEXT_EVENT = 'kite:page-find-next'
const PAGE_FIND_PREVIOUS_EVENT = 'kite:page-find-previous'

interface PageFindContextValue {
  isOpen: boolean
  query: string
  matchCount: number
  currentMatch: number
  openFind: () => void
  closeFind: () => void
  setQuery: (query: string) => void
  findNext: () => void
  findPrevious: () => void
}

const PageFindContext = createContext<PageFindContextValue | undefined>(
  undefined
)

function isShortcutTargetExcluded(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  return Boolean(
    target.closest('.monaco-editor, [data-page-find-ignore="true"]')
  )
}

function getNextMatchIndex(
  currentIndex: number,
  total: number,
  direction: 1 | -1
) {
  if (total <= 0) {
    return -1
  }

  if (currentIndex < 0) {
    return direction === 1 ? 0 : total - 1
  }

  return (currentIndex + direction + total) % total
}

export function usePageFind() {
  const context = useContext(PageFindContext)
  if (!context) {
    throw new Error('usePageFind must be used within a PageFindProvider')
  }
  return context
}

export function PageFindProvider({ children }: { children: ReactNode }) {
  const { isDesktop } = useRuntime()
  const location = useLocation()
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQueryState] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [currentMatch, setCurrentMatch] = useState(-1)
  const matchesRef = useRef<HTMLElement[]>([])
  const queryRef = useRef('')
  const currentMatchRef = useRef(-1)
  const observerTimeoutRef = useRef<number | null>(null)
  const observerPausedRef = useRef(false)

  const refreshMatches = useCallback(
    (nextQuery: string, preferredIndex?: number) => {
      if (!isDesktop || typeof document === 'undefined') {
        return
      }

      observerPausedRef.current = true
      clearPageFindHighlights(document.body)

      const trimmedQuery = nextQuery.trim()
      if (!trimmedQuery) {
        matchesRef.current = []
        setMatchCount(0)
        setCurrentMatch(-1)
        currentMatchRef.current = -1
        window.setTimeout(() => {
          observerPausedRef.current = false
        }, 0)
        return
      }

      const matches = highlightPageFindMatches(document.body, trimmedQuery)
      matchesRef.current = matches
      setMatchCount(matches.length)

      const nextIndex =
        matches.length === 0
          ? -1
          : Math.min(
              Math.max(preferredIndex ?? currentMatchRef.current, 0),
              matches.length - 1
            )

      setCurrentPageFindMatch(matches, nextIndex, false)
      setCurrentMatch(nextIndex)
      currentMatchRef.current = nextIndex

      window.setTimeout(() => {
        observerPausedRef.current = false
      }, 0)
    },
    [isDesktop]
  )

  const openFind = useCallback(() => {
    if (!isDesktop) {
      return
    }
    setIsOpen(true)
  }, [isDesktop])

  const closeFind = useCallback(() => {
    setIsOpen(false)
    if (typeof document !== 'undefined') {
      clearPageFindHighlights(document.body)
    }
    matchesRef.current = []
    setMatchCount(0)
    setCurrentMatch(-1)
    currentMatchRef.current = -1
  }, [])

  const setQuery = useCallback(
    (nextQuery: string) => {
      queryRef.current = nextQuery
      setQueryState(nextQuery)
      currentMatchRef.current = 0
      refreshMatches(nextQuery, 0)
    },
    [refreshMatches]
  )

  const findNext = useCallback(() => {
    if (!queryRef.current.trim()) {
      openFind()
      return
    }

    const nextIndex = getNextMatchIndex(
      currentMatchRef.current,
      matchesRef.current.length,
      1
    )
    setCurrentPageFindMatch(matchesRef.current, nextIndex)
    setCurrentMatch(nextIndex)
    currentMatchRef.current = nextIndex
  }, [openFind])

  const findPrevious = useCallback(() => {
    if (!queryRef.current.trim()) {
      openFind()
      return
    }

    const nextIndex = getNextMatchIndex(
      currentMatchRef.current,
      matchesRef.current.length,
      -1
    )
    setCurrentPageFindMatch(matchesRef.current, nextIndex)
    setCurrentMatch(nextIndex)
    currentMatchRef.current = nextIndex
  }, [openFind])

  useEffect(() => {
    queryRef.current = query
  }, [query])

  useEffect(() => {
    currentMatchRef.current = currentMatch
  }, [currentMatch])

  useEffect(() => {
    if (!isDesktop) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isShortcutTargetExcluded(event.target)) {
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        openFind()
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'g') {
        event.preventDefault()
        if (event.shiftKey) {
          findPrevious()
        } else {
          findNext()
        }
        return
      }

      if (event.key === 'F3') {
        event.preventDefault()
        if (event.shiftKey) {
          findPrevious()
        } else {
          findNext()
        }
        return
      }

      if (event.key === 'Escape' && isOpen) {
        event.preventDefault()
        closeFind()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeFind, findNext, findPrevious, isDesktop, isOpen, openFind])

  useEffect(() => {
    if (!isDesktop) {
      return
    }

    const handleOpen = () => openFind()
    const handleNext = () => findNext()
    const handlePrevious = () => findPrevious()

    window.addEventListener(PAGE_FIND_OPEN_EVENT, handleOpen)
    window.addEventListener(PAGE_FIND_NEXT_EVENT, handleNext)
    window.addEventListener(PAGE_FIND_PREVIOUS_EVENT, handlePrevious)

    return () => {
      window.removeEventListener(PAGE_FIND_OPEN_EVENT, handleOpen)
      window.removeEventListener(PAGE_FIND_NEXT_EVENT, handleNext)
      window.removeEventListener(PAGE_FIND_PREVIOUS_EVENT, handlePrevious)
    }
  }, [findNext, findPrevious, isDesktop, openFind])

  useEffect(() => {
    if (!isDesktop || !isOpen || !query.trim()) {
      return
    }

    refreshMatches(query, currentMatchRef.current)
  }, [isDesktop, isOpen, location.key, query, refreshMatches])

  useEffect(() => {
    if (!isDesktop || !isOpen || !query.trim()) {
      return
    }

    const observer = new MutationObserver(() => {
      if (observerPausedRef.current) {
        return
      }

      if (observerTimeoutRef.current !== null) {
        window.clearTimeout(observerTimeoutRef.current)
      }

      observerTimeoutRef.current = window.setTimeout(() => {
        refreshMatches(queryRef.current, currentMatchRef.current)
      }, 120)
    })

    observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    })

    return () => {
      observer.disconnect()
      if (observerTimeoutRef.current !== null) {
        window.clearTimeout(observerTimeoutRef.current)
        observerTimeoutRef.current = null
      }
    }
  }, [isDesktop, isOpen, query, refreshMatches])

  const value = useMemo<PageFindContextValue>(
    () => ({
      isOpen,
      query,
      matchCount,
      currentMatch,
      openFind,
      closeFind,
      setQuery,
      findNext,
      findPrevious,
    }),
    [
      closeFind,
      currentMatch,
      findNext,
      findPrevious,
      isOpen,
      matchCount,
      openFind,
      query,
      setQuery,
    ]
  )

  return (
    <PageFindContext.Provider value={value}>
      {children}
      <PageFindBar />
    </PageFindContext.Provider>
  )
}

function PageFindBar() {
  const { t } = useTranslation()
  const {
    isOpen,
    query,
    matchCount,
    currentMatch,
    closeFind,
    findNext,
    findPrevious,
    setQuery,
  } = usePageFind()
  const { isDesktop } = useRuntime()
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!isOpen) {
      return
    }

    window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
  }, [isOpen])

  if (!isDesktop || !isOpen) {
    return null
  }

  const hasMatches = matchCount > 0
  const matchLabel = hasMatches
    ? `${currentMatch + 1} / ${matchCount}`
    : query.trim()
      ? t('pageFind.noResults')
      : '0 / 0'

  return (
    <div
      className="fixed top-3 right-4 z-[80] flex items-center gap-2 rounded-lg border bg-background/95 px-3 py-2 shadow-lg backdrop-blur"
      data-page-find-ignore="true"
    >
      <div className="text-muted-foreground">
        <Search className="size-4" />
      </div>
      <Input
        ref={inputRef}
        className="h-8 w-56"
        placeholder={t('pageFind.placeholder')}
        value={query}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            if (event.shiftKey) {
              findPrevious()
            } else {
              findNext()
            }
            return
          }

          if (event.key === 'Escape') {
            event.preventDefault()
            closeFind()
          }
        }}
      />
      <span
        className={`min-w-14 text-right text-xs ${
          hasMatches ? 'text-muted-foreground' : 'text-destructive'
        }`}
      >
        {matchLabel}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={findPrevious}
        aria-label={t('pageFind.previous')}
      >
        <ChevronUp className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={findNext}
        aria-label={t('pageFind.next')}
      >
        <ChevronDown className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={closeFind}
        aria-label={t('common.close')}
      >
        <X className="size-4" />
      </Button>
    </div>
  )
}
