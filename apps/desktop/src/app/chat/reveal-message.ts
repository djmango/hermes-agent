// Land the transcript on a stored message from outside the chat surface: the
// plugin SDK opens a session and then asks for one of its rows, and Session Find
// is the first caller. The chat surface already knows how to reveal a row (the
// timeline rail dispatches TIMELINE_REVEAL_EVENT at its own viewport, the history
// window fetches the bounded page, the list renders it and scrolls). This module
// is only the missing front door: find the surface that owns the session, dis-
// patch the same request, then scroll the turn it landed on.
//
// Kept out of the chat components so the SDK never imports React, and kept
// pointer-free: a caller with no mounted surface gets `false`, never a throw.
// Only a human prompt carries `data-message-id`, so a message the caller knows by
// id resolves to the prompt whose turn produced it, both server-side (the around
// route) and here.

import { TIMELINE_REVEAL_EVENT, type TimelineRevealRequest } from '@/components/assistant-ui/thread/timeline-data'
import { $selectedStoredSessionId } from '@/store/session'

const VIEWPORT_SELECTOR = '[data-slot="aui_thread-viewport"]'

/** How long the surface may take to mount after an open. A cold profile wake can
 *  spend seconds dialing, so this is generous; the read it guards is bounded and
 *  cancellable. */
export const REVEAL_MOUNT_TIMEOUT_MS = 15_000

/** The chat surface for `storedSessionId`: its tile if one is open, else the
 *  primary workspace while that is the selected session. A kept-alive neighbor
 *  showing another session is never a candidate. */
export function findSurfaceViewport(storedSessionId: string): HTMLElement | null {
  const id = (storedSessionId ?? '').trim()

  if (!id) {
    return null
  }

  const primaryIsShowing = $selectedStoredSessionId.get() === id
  const surfaces = document.querySelectorAll<HTMLElement>('[data-session-anchor]')
  let primary: HTMLElement | null = null

  for (const surface of surfaces) {
    const anchor = surface.dataset.sessionAnchor
    const owns = anchor === `session-tile:${id}` || (primaryIsShowing && anchor === 'workspace')

    if (!owns) {
      continue
    }

    const viewport = surface.querySelector<HTMLElement>(VIEWPORT_SELECTOR)

    if (!viewport) {
      continue
    }

    // A tile wins over the primary: it is the surface the caller (or the user)
    // most recently put this session in.
    if (anchor !== 'workspace') {
      return viewport
    }

    primary = viewport
  }

  return primary
}

/** Resolve when the owning surface mounts, or null at the deadline. A cold open
 *  answers this by mounting the surface, so the observer is the wait. */
function waitForViewport(
  storedSessionId: string,
  signal: AbortSignal,
  timeoutMs: number
): Promise<HTMLElement | null> {
  const immediate = findSurfaceViewport(storedSessionId)

  if (immediate) {
    return Promise.resolve(immediate)
  }

  return new Promise(resolve => {
    let settled = false

    const finish = (viewport: HTMLElement | null) => {
      if (settled) {
        return
      }

      settled = true
      window.clearTimeout(timer)
      observer.disconnect()
      signal.removeEventListener('abort', cancelled)
      resolve(viewport)
    }

    const probe = () => {
      const viewport = findSurfaceViewport(storedSessionId)

      if (viewport) {
        finish(viewport)
      }
    }

    const cancelled = () => finish(null)
    const timer = window.setTimeout(() => finish(null), Math.max(0, timeoutMs))
    const observer = new MutationObserver(probe)

    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-session-anchor']
    })
    signal.addEventListener('abort', cancelled, { once: true })
    // The surface can mount between the first probe and the observer above.
    probe()
  })
}

/**
 * Reveal `messageId` inside `storedSessionId` on whichever chat surface owns it.
 * The surface loads the bounded page, lands the prompt whose turn holds the
 * message, and scrolls it into place. Resolves true only when a rendered row was
 * actually revealed; a session with no mounted surface, no such prompt, or a
 * surface that never answered resolves false so the caller can keep its own
 * fallback.
 */
export async function revealStoredMessage(
  storedSessionId: string,
  messageId: number,
  options: { signal?: AbortSignal; mountTimeoutMs?: number } = {}
): Promise<boolean> {
  const id = (storedSessionId ?? '').trim()

  if (!id || !Number.isSafeInteger(messageId) || messageId <= 0 || options.signal?.aborted) {
    return false
  }

  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })

  try {
    const viewport = await waitForViewport(
      id,
      controller.signal,
      options.mountTimeoutMs ?? REVEAL_MOUNT_TIMEOUT_MS
    )

    if (!viewport || controller.signal.aborted) {
      return false
    }

    const revealed = await new Promise<string | false>(resolve => {
      let settled = false

      const finish = (value: string | false) => {
        if (settled) {
          return
        }

        settled = true
        resolve(value)
      }

      controller.signal.addEventListener('abort', () => finish(false), { once: true })

      // `id` stays empty: the surface names the row from the message, and an id
      // the caller cannot know would only make the list hunt for a row that is
      // not there yet.
      const detail: TimelineRevealRequest = {
        id: '',
        messageId,
        signal: controller.signal,
        complete: finish
      }

      viewport.dispatchEvent(new CustomEvent(TIMELINE_REVEAL_EVENT, { detail }))
    })

    if (!revealed) {
      return false
    }

    const node = viewport.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(revealed)}"]`)

    if (!node) {
      return false
    }

    return true
  } finally {
    options.signal?.removeEventListener('abort', abort)
  }
}
