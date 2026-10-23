import { afterEach, describe, expect, it } from 'vitest'

import { TIMELINE_REVEAL_EVENT, type TimelineRevealRequest } from '@/components/assistant-ui/thread/timeline-data'
import { $selectedStoredSessionId } from '@/store/session'

import { revealStoredMessage } from './reveal-message'

/** One chat surface: the shell element the app tags with its session, plus the
 *  scroll viewport the reveal is dispatched at. */
function mountSurface(anchor: string): { root: HTMLElement; viewport: HTMLElement } {
  const root = document.createElement('div')
  root.dataset.sessionAnchor = anchor

  const viewport = document.createElement('div')
  viewport.setAttribute('data-slot', 'aui_thread-viewport')
  root.append(viewport)
  document.body.append(root)

  return { root, viewport }
}

/** Stand in for the chat surface: answer every message-addressed reveal with one
 *  rendered prompt row, the way useTimelineReveal names the landed row. */
function answerReveals(viewport: HTMLElement, revealedId: string, seen: TimelineRevealRequest[]) {
  viewport.addEventListener(TIMELINE_REVEAL_EVENT, event => {
    const detail = (event as CustomEvent<TimelineRevealRequest>).detail
    seen.push(detail)

    const turn = document.createElement('div')
    turn.setAttribute('data-slot', 'aui_turn-pair')

    const node = document.createElement('div')
    node.setAttribute('data-message-id', revealedId)
    turn.append(node)
    viewport.append(turn)
    detail.complete(revealedId)
  })
}

afterEach(() => {
  document.body.innerHTML = ''
  $selectedStoredSessionId.set(null)
})

describe('revealing a stored message from outside the chat surface', () => {
  it('asks the surface that owns the session, and leaves a neighbor showing another session alone', async () => {
    $selectedStoredSessionId.set('mine')

    const neighborSeen: TimelineRevealRequest[] = []
    const neighbor = mountSurface('session-tile:other')
    answerReveals(neighbor.viewport, 'neighbor-prompt', neighborSeen)

    const seen: TimelineRevealRequest[] = []
    const primary = mountSurface('workspace')
    answerReveals(primary.viewport, 'prompt-40', seen)

    const revealed = await revealStoredMessage('mine', 41)

    expect(revealed).toBe(true)
    expect(neighborSeen).toHaveLength(0)
    expect(seen.map(detail => detail.messageId)).toEqual([41])
    // The turn the surface landed on is in the viewport, the one row a caller can
    // actually see the jump arrive at.
    expect(primary.viewport.querySelector('[data-message-id="prompt-40"]')).not.toBeNull()
  })

  it('reports failure when no surface owns the session instead of claiming a jump', async () => {
    $selectedStoredSessionId.set('someone-else')
    mountSurface('workspace')

    expect(await revealStoredMessage('mine', 41, { mountTimeoutMs: 10 })).toBe(false)
    expect(await revealStoredMessage('', 41)).toBe(false)
    expect(await revealStoredMessage('mine', 0)).toBe(false)
  })
})
