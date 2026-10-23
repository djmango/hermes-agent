import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { capabilityScoped, hermesApi, type ProfileScope, sessionReadOwnerPin } from '@/api/client'
import {
  cachedTimelineIndex,
  previousPromptRowId,
  timelineIndexKey
} from '@/components/assistant-ui/thread/timeline-index'
import { type ChatMessage, toChatMessages } from '@/lib/chat-messages'
import type { SessionMessagesResponse } from '@/types/hermes'

import { mergeOlderTranscriptPage } from './transcript-backfill'

export const HISTORY_WINDOW_LIMIT = 120

/** The around route is intentionally isolated from tail/backfill bookkeeping. */
export interface HistoryWindowResponse extends SessionMessagesResponse {
  pagination: NonNullable<SessionMessagesResponse['pagination']> & {
    has_older: boolean
    has_newer: boolean
    /** The prompt row the page is anchored on, echoed back by the route. */
    row_id?: number
  }
}

interface HistoryPage {
  messages: ChatMessage[]
  olderAvailable: boolean
  newerAvailable: boolean
  /** Display rows before this page's first row; how two pages prove they touch. */
  offset: number
  /** The prompt row the backend actually anchored on. For a message-addressed
   *  page the caller did not name a prompt, so this is the row to scroll to. */
  anchorRowId: number | null
}

/** What an around-read is anchored on: a prompt row the caller already knows, or
 *  a stored message whose owning prompt only the backend can resolve. */
export type HistoryAnchor = { rowId: number } | { messageId: number }

export async function fetchHistoryWindow(
  storedId: string,
  anchor: HistoryAnchor,
  scope: ProfileScope,
  signal: AbortSignal
): Promise<HistoryPage> {
  signal.throwIfAborted()

  // Owner connection pin (#125372): an around-read for a session owned by another
  // registry connection must read THAT host, not the ambient one.
  const route = {
    ...capabilityScoped(scope),
    ...(typeof scope === 'object' && scope?.connectionId === 'local' ? { connectionId: 'local' } : {}),
    ...sessionReadOwnerPin(storedId, scope)
  }

  const query =
    'rowId' in anchor
      ? new URLSearchParams({ row_id: String(anchor.rowId), limit: String(HISTORY_WINDOW_LIMIT) })
      : new URLSearchParams({ message_id: String(anchor.messageId), limit: String(HISTORY_WINDOW_LIMIT) })

  if (route.profile) {
    query.set('profile', route.profile)
  }

  // The Electron REST bridge cannot transfer AbortSignal over IPC. Cancellation
  // below releases the caller immediately and fences the eventual bounded read;
  // it does not pretend to cancel backend I/O or fall back to a full transcript.
  const response = await hermesApi<HistoryWindowResponse>({
    ...route,
    method: 'GET',
    path: `/api/sessions/${encodeURIComponent(storedId)}/messages/around?${query}`
  })

  signal.throwIfAborted()

  if (!Array.isArray(response.messages) || response.messages.length > HISTORY_WINDOW_LIMIT) {
    throw new Error('History response exceeds the bounded page size.')
  }

  const resolved = Number(response.pagination.row_id)

  return {
    messages: toChatMessages(response.messages),
    olderAvailable: response.pagination.has_older === true,
    newerAvailable: response.pagination.has_newer === true,
    offset: Math.max(0, Number(response.pagination.offset) || 0),
    anchorRowId: Number.isSafeInteger(resolved) && resolved > 0 ? resolved : null
  }
}

interface HistoryWindowOptions {
  /** Include runtime, durable id, owner connection/profile, and suppression. */
  scopeKey: string
  storedId: string | null
  scope: ProfileScope
  isCurrent: () => boolean
}

/** A single replaceable display page, never merged into the live message store. */
export function useHistoryWindow({ scopeKey, storedId, scope, isCurrent }: HistoryWindowOptions) {
  const lifetime = useMemo(() => ({ scopeKey }), [scopeKey])
  const latest = useRef({ lifetime, page: null as HistoryPage | null, storedId, scope, isCurrent })
  const pending = useRef<AbortController | null>(null)
  const [selection, setSelection] = useState<{ lifetime: object; page: HistoryPage } | null>(null)
  const page = selection?.lifetime === lifetime ? selection.page : null

  latest.current = { lifetime, page, storedId, scope, isCurrent }

  const cancel = useCallback(() => {
    pending.current?.abort()
    pending.current = null
  }, [])

  useEffect(() => cancel, [cancel, lifetime])

  const returnToLatest = useCallback(() => {
    cancel()
    setSelection(null)
  }, [cancel])

  /**
   * Replace the display page with the one anchored at `anchor`, and return the
   * runtime id of the row `pick` selects from it. A message-addressed read has no
   * prompt the caller knows, so the route resolves one and reports it.
   */
  const openAnchoredPage = useCallback(
    async (
      anchor: HistoryAnchor,
      pick: (page: HistoryPage) => ChatMessage | undefined,
      signal: AbortSignal
    ): Promise<string | null> => {
      cancel()

      const address = 'rowId' in anchor ? anchor.rowId : anchor.messageId

      if (signal.aborted || !Number.isSafeInteger(address) || address <= 0) {
        return null
      }

      const captured = latest.current

      if (!captured.storedId || !captured.isCurrent()) {
        return null
      }

      const controller = new AbortController()
      pending.current = controller
      const abort = () => controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      let release!: () => void

      const aborted = new Promise<null>(resolve => {
        release = () => resolve(null)
        controller.signal.addEventListener('abort', release, { once: true })
      })

      try {
        const next = await Promise.race([
          fetchHistoryWindow(captured.storedId, anchor, captured.scope, controller.signal),
          aborted
        ])

        if (
          !next ||
          controller.signal.aborted ||
          latest.current.lifetime !== captured.lifetime ||
          !captured.isCurrent()
        ) {
          return null
        }

        const target = pick(next)

        if (!target) {
          return null
        }

        setSelection({ lifetime: captured.lifetime, page: next })

        return target.id
      } catch {
        // Missing/older backend, unreadable row, and failed reads preserve the
        // current page. The caller reports failure and can retry explicitly.
        return null
      } finally {
        signal.removeEventListener('abort', abort)
        controller.signal.removeEventListener('abort', release)

        if (pending.current === controller) {
          pending.current = null
        }
      }
    },
    [cancel]
  )

  const revealRow = useCallback(
    (rowId: number, signal: AbortSignal): Promise<string | null> =>
      openAnchoredPage({ rowId }, page => page.messages.find(message => message.rowId === rowId), signal),
    [openAnchoredPage]
  )

  /**
   * Reveal a stored message that the caller only knows by id (a search hit).
   * Assistant rows carry no scroll anchor of their own, so the transcript lands
   * on the prompt whose turn produced the message.
   */
  const revealMessage = useCallback(
    (messageId: number, signal: AbortSignal): Promise<string | null> =>
      openAnchoredPage(
        { messageId },
        page =>
          (page.anchorRowId === null
            ? undefined
            : page.messages.find(message => message.rowId === page.anchorRowId)) ??
          page.messages.find(message => message.rowId === messageId),
        signal
      ),
    [openAnchoredPage]
  )

  /**
   * Prepend the page before this window's first prompt. The anchor's
   * predecessor comes from the same prompt index the rail draws, so the
   * transcript's entry point and the rail page one range. `beforePrepend` is
   * spent in the same commit as the prepend, exactly like a live-page grow.
   */
  const revealOlder = useCallback(
    async (beforePrepend?: () => void): Promise<boolean> => {
      const captured = latest.current
      const current = captured.page

      // No older rows before this page's first row, or nothing to anchor on yet.
      if (!current?.olderAvailable || !captured.storedId || !captured.isCurrent()) {
        return false
      }

      const anchor = current.messages.find(message => message.role === 'user' && message.rowId !== undefined)?.rowId

      cancel()
      const controller = new AbortController()
      pending.current = controller

      try {
        const rowId = await previousPromptRowId(captured.storedId, captured.scope, anchor)

        if (rowId === null || controller.signal.aborted) {
          // A complete index that lists no prompt before this window means the
          // backend's older rows can never be paged to: retire the offer so the
          // button and the top-edge auto-page stop promising a page that never
          // arrives. An incomplete index still leaves the page untouched for a retry.
          if (
            rowId === null &&
            anchor !== undefined &&
            !controller.signal.aborted &&
            latest.current.page === current &&
            cachedTimelineIndex(timelineIndexKey(captured.storedId, captured.scope))?.complete
          ) {
            setSelection({ lifetime: captured.lifetime, page: { ...current, olderAvailable: false } })
          }

          return false
        }

        const next = await fetchHistoryWindow(captured.storedId, { rowId }, captured.scope, controller.signal)
        // The around route reads forward from a prompt, so a turn longer than the
        // page limit leaves rows between that page's end and this anchor. Never
        // paint that as one continuous transcript: show the older page on its
        // own instead, the way a rail jump to that mark would.
        const contiguous = next.offset + next.messages.length >= current.offset
        const messages = contiguous ? mergeOlderTranscriptPage(current.messages, next.messages) : next.messages

        // A window replaced while this one was in flight owns the display page.
        if (
          controller.signal.aborted ||
          messages === current.messages ||
          latest.current.lifetime !== captured.lifetime ||
          latest.current.page !== current
        ) {
          return false
        }

        if (contiguous) {
          beforePrepend?.()
        }

        setSelection({
          lifetime: captured.lifetime,
          page: contiguous ? { ...next, messages, newerAvailable: current.newerAvailable } : next
        })

        return true
      } catch {
        // Missing/older backend, unreadable page, and an index that cannot name
        // the predecessor all leave the page untouched; the caller reports
        // failure and can retry explicitly.
        return false
      } finally {
        if (pending.current === controller) {
          pending.current = null
        }
      }
    },
    [cancel]
  )

  return { page, revealRow, revealMessage, returnToLatest, revealOlder }
}
