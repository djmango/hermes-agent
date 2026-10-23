// Scrolling a revealed row into place, shared by anything that lands a jump.
//
// A jump is not a reader asking for earlier turns, but the transcript pages older
// turns whenever the viewport sits at the top edge, and a rail-style jump lands
// exactly there: the revealed prompt is the page's first row, eight pixels down.
// So a caller holds its auto-page off while this move runs and releases it in
// `done`, which fires one frame after the final write (the scroll event the write
// causes is dispatched after it).

/** The scroll tween the timeline rail uses, so every jump feels the same. */
export const REVEAL_SCROLL_MS = 170
/** Space kept above the landed turn, as the rail keeps it. */
export const REVEAL_SCROLL_SLACK_PX = 8

/** Put the turn holding `node` at the top of the viewport. */
export function scrollTurnIntoView(
  viewport: HTMLElement,
  node: HTMLElement,
  done: () => void = () => {}
): void {
  const start = viewport.scrollTop
  const turn = node.closest<HTMLElement>('[data-slot="aui_turn-pair"]') ?? node
  const destination = Math.max(
    0,
    start + turn.getBoundingClientRect().top - viewport.getBoundingClientRect().top - REVEAL_SCROLL_SLACK_PX
  )
  const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : REVEAL_SCROLL_MS
  const began = performance.now()

  if (!duration) {
    viewport.scrollTop = destination
    requestAnimationFrame(() => requestAnimationFrame(done))

    return
  }

  const step = (now: number) => {
    const progress = Math.min(1, (now - began) / duration)
    viewport.scrollTop = start + (destination - start) * (1 - (1 - progress) ** 3)

    if (progress < 1) {
      requestAnimationFrame(step)
    } else {
      requestAnimationFrame(() => requestAnimationFrame(done))
    }
  }

  requestAnimationFrame(step)
}
