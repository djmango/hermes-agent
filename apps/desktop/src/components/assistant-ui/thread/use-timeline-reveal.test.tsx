import { act, cleanup, render } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TIMELINE_REVEAL_EVENT } from './timeline-data'
import { TranscriptWindowProvider } from './transcript-window'
import { useTimelineReveal } from './use-timeline-reveal'

vi.mock('@/app/chat/session-view', () => ({ useSessionView: () => view }))
const view = { $messages: { get: () => [] } }

beforeEach(() => vi.stubGlobal('CSS', { escape: (id: string) => id }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Harness({ fetchPage, signal }: { fetchPage: () => Promise<string | null>; signal: AbortSignal }) {
  const [id, setId] = useState('latest')

  return (
    <TranscriptWindowProvider
      value={{
        olderAvailable: true,
        expandWindow: vi.fn(),
        revealRow: async () => {
          const next = await fetchPage()

          if (next && !signal.aborted) {
            setId(next)
          }

          return next
        }
      }}
    >
      <List id={id} />
    </TranscriptWindowProvider>
  )
}

function List({ id }: { id: string }) {
  const viewport = useRef<HTMLDivElement>(null)
  useTimelineReveal({
    viewport,
    groups: [{ id, weight: 1 }],
    hiddenCount: 0,
    renderBudget: 600,
    olderAvailable: true,
    revealBudget: vi.fn(),
    expandWindow: vi.fn(),
    prepare: vi.fn(),
    sessionKey: 'session'
  })

  return (
    <div data-testid="viewport" ref={viewport}>
      <div data-message-id={id}>{id}</div>
    </div>
  )
}

describe('timeline direct reveal', () => {
  it('waits for a single bounded around-page commit and resolves the mounted id', async () => {
    const controller = new AbortController()
    const fetchPage = vi.fn(async () => 'old-target')
    const complete = vi.fn()
    const ui = render(<Harness fetchPage={fetchPage} signal={controller.signal} />)
    await act(async () => {
      ui.getByTestId('viewport').dispatchEvent(
        new CustomEvent(TIMELINE_REVEAL_EVENT, {
          detail: { id: 'history:42', rowId: 42, signal: controller.signal, complete }
        })
      )
    })
    expect(fetchPage).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledWith('old-target')
  })

  it('leaves existing content when a direct read fails', async () => {
    const controller = new AbortController()
    const complete = vi.fn()
    const ui = render(<Harness fetchPage={async () => null} signal={controller.signal} />)
    await act(async () => {
      ui.getByTestId('viewport').dispatchEvent(
        new CustomEvent(TIMELINE_REVEAL_EVENT, { detail: { id: 'history:42', signal: controller.signal, complete } })
      )
    })
    expect(complete).toHaveBeenCalledWith(false)
    expect(ui.getByText('latest')).toBeTruthy()
  })
})

function MessageJump({
  hold,
  land,
  revealed
}: {
  hold: () => () => void
  land: (id: string, release: () => void) => void
  revealed: string | null
}) {
  const [id, setId] = useState('latest')

  return (
    <TranscriptWindowProvider
      value={{
        olderAvailable: true,
        expandWindow: vi.fn(),
        revealMessage: async () => {
          if (revealed) {
            setId(revealed)
          }

          return revealed
        }
      }}
    >
      <JumpViewport id={id} hold={hold} land={land} />
    </TranscriptWindowProvider>
  )
}

function JumpViewport({
  id,
  hold,
  land
}: {
  id: string
  hold: () => () => void
  land: (id: string, release: () => void) => void
}) {
  const viewport = useRef<HTMLDivElement>(null)

  useTimelineReveal({
    viewport,
    groups: [{ id, weight: 1 }],
    hiddenCount: 0,
    renderBudget: 600,
    olderAvailable: true,
    revealBudget: vi.fn(),
    expandWindow: vi.fn(),
    prepare: vi.fn(),
    sessionKey: 'session',
    holdAutoPage: hold,
    landRevealed: land
  })

  return (
    <div data-testid="viewport" ref={viewport}>
      <div data-message-id={id}>{id}</div>
    </div>
  )
}

describe('a message-addressed jump', () => {
  it('holds the top-edge auto-page for the read, lands the prompt, and spends the hold', async () => {
    const controller = new AbortController()
    const complete = vi.fn()
    const release = vi.fn()
    const hold = vi.fn(() => release)
    const land = vi.fn((_id: string, done: () => void) => done())
    const ui = render(<MessageJump hold={hold} land={land} revealed="prompt-40" />)

    await act(async () => {
      ui.getByTestId('viewport').dispatchEvent(
        new CustomEvent(TIMELINE_REVEAL_EVENT, {
          detail: { id: '', messageId: 41, signal: controller.signal, complete }
        })
      )
    })

    expect(hold).toHaveBeenCalledOnce()
    expect(land).toHaveBeenCalledWith('prompt-40', release)
    expect(release).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledWith('prompt-40')
  })

  it('spends the hold when no prompt holds the message', async () => {
    const controller = new AbortController()
    const complete = vi.fn()
    const release = vi.fn()
    const hold = vi.fn(() => release)
    const land = vi.fn()
    const ui = render(<MessageJump hold={hold} land={land} revealed={null} />)

    await act(async () => {
      ui.getByTestId('viewport').dispatchEvent(
        new CustomEvent(TIMELINE_REVEAL_EVENT, {
          detail: { id: '', messageId: 41, signal: controller.signal, complete }
        })
      )
    })

    expect(hold).toHaveBeenCalledOnce()
    expect(land).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledWith(false)
  })
})
