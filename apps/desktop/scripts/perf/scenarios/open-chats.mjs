// Open N chats and watch what accumulates. Each chat is a real session tile
// opened through the app's own store (`__HERMES_SESSION_TILES__.open`), given a
// known transcript depth through the real gateway write path (`hook.update`),
// and then ACTIVATED once — which is exactly what clicking through a stack of
// chats does. After every activation the scenario samples:
//
//   js_heap_mb       renderer JS heap after a forced GC (CDP HeapProfiler)
//   panes_mounted    mounted chat surfaces (`[data-slot=aui_thread-viewport]`)
//   hidden_layers    mounted-but-hidden pane layers (`[data-pane-hidden]`)
//   message_rows     mounted transcript rows (`[data-slot=aui_turn-pair]`)
//   tiles            session tiles the store holds (grows with chats opened)
//   states           session states `$sessionStates` holds, in full
//
// and, on the tail, the time to switch BACK to an already-open chat (the
// "switching is instant because it is cached" number this must not regress).
//
// Report tier: it measures accumulation, it is not a frame-pacing gate.
//
//   node scripts/perf/run.mjs open-chats --spawn --chat 24 --turns 12
//   node scripts/perf/run.mjs open-chats --chat 60 --turns 12          # attach

import { sleep } from '../lib/cdp.mjs'

/** Page-side: one chat's settled transcript, `turns` user/assistant pairs.
 *  A fenced code block and a table are included because they are the expensive
 *  markdown shapes to mount. The fence is built from char codes so this file
 *  needs no nested-backtick escaping. */
const stateFor = (sid, turns) => `
  (() => {
    const turnCount = ${turns}
    const fence = String.fromCharCode(96).repeat(3)
    const turn = i => {
      const user = { id: '${sid}-u' + i, role: 'user', timestamp: Date.now(),
        parts: [{ type: 'text', text: 'Question ' + i + ': how does module ' + i + ' handle back-pressure?' }] }
      const assistant = { id: '${sid}-a' + i, role: 'assistant', timestamp: Date.now(), pending: false,
        parts: [{ type: 'text', text: [
          '## Answer ' + i, '',
          'The widget buffers writes and applies a bounded queue. Key points:',
          '- It coalesces bursts into a single flush.',
          '- Back-pressure propagates through a promise that resolves on drain.',
          '',
          fence + 'ts',
          'function flush' + i + '(items: number[]) {',
          '  return items.reduce((a, b) => a + b, 0)',
          '}',
          fence, '',
          '| stage | cost |', '|---|---|', '| enqueue | O(1) |', '| flush | O(n) |', ''
        ].join('\\n') }] }
      return [user, assistant]
    }
    const messages = []
    for (let i = 0; i < turnCount; i++) messages.push(...turn(i))
    return {
      storedSessionId: '${sid}', messages, branch: '', cwd: '', model: '', provider: '',
      reasoningEffort: '', serviceTier: '', fast: false, yolo: false, personality: '',
      busy: false, awaitingResponse: false, streamId: null, sawAssistantPayload: true,
      pendingBranchGroup: null, interrupted: false, interimBoundaryPending: false,
      needsInput: false, turnStartedAt: null, usage: null
    }
  })()
`

/** Open + bind + seed + ACTIVATE one chat, then sample. Timed to next paint. */
const openOne = (sid, rid, turns) => `
  new Promise(resolve => {
    const hook = window.__HERMES_SESSION_TILES__
    hook.open(${JSON.stringify(sid)}, 'center')
    hook.patch(${JSON.stringify(sid)}, { runtimeId: ${JSON.stringify(rid)} })
    hook.update(${JSON.stringify(rid)}, () => (${stateFor(sid, turns)}))
    const t0 = performance.now()
    window.__HERMES_LAYOUT_TREE__.reveal(${JSON.stringify(`session-tile:${sid}`)})
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(performance.now() - t0))))
  })
`

/** Switch back to an already-open chat (the cached-switch number). */
const revealTimed = sid => `
  new Promise(resolve => {
    const t0 = performance.now()
    window.__HERMES_LAYOUT_TREE__.reveal(${JSON.stringify(`session-tile:${sid}`)})
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(performance.now() - t0))))
  })
`

const SAMPLE = `
  JSON.stringify({
    tiles: window.__HERMES_SESSION_TILES__.tiles().length,
    states: Object.keys(window.__HERMES_SESSION_TILES__.states()).length,
    panes_mounted: document.querySelectorAll('[data-slot="aui_thread-viewport"]').length,
    hidden_layers: document.querySelectorAll('[data-pane-hidden]').length,
    message_rows: document.querySelectorAll('[data-slot="aui_turn-pair"]').length,
    tab_chips: document.querySelectorAll('[data-tree-tab]').length
  })
`

const CLEANUP = `
  (() => {
    const hook = window.__HERMES_SESSION_TILES__
    for (const { sid } of window.__OC__.ids) hook.close(sid)
    window.__OC__ = null
    return 'cleaned'
  })()
`

export default {
  name: 'open-chats',
  tier: 'report',
  description: 'Open N chats: JS heap, mounted panes, mounted rows, switch-back cost.',
  async run(cdp, opts = {}) {
    const chats = Number(opts.chat ?? 24)
    const turns = Number(opts.turns ?? 12)
    const warmStart = Number(opts.warm ?? 0)

    await cdp.send('Runtime.enable')
    await cdp.send('HeapProfiler.enable')

    const hookOk = await cdp.eval('!!(window.__HERMES_SESSION_TILES__ && window.__HERMES_LAYOUT_TREE__)')

    if (!hookOk) {
      throw new Error('open-chats needs the dev hooks (dev or VITE_PERF_PROBE renderer)')
    }

    // Sample the heap AFTER a forced GC so the number is live data, not the
    // previous sequence's garbage.
    const sample = async () => {
      await cdp.send('HeapProfiler.collectGarbage')
      const heap = await cdp.send('Runtime.getHeapUsage')
      const dom = JSON.parse(await cdp.eval(SAMPLE))

      return { ...dom, js_heap_mb: Math.round((heap.usedSize / 1048576) * 10) / 10 }
    }

    await cdp.eval(`window.__OC__ = { ids: [] }; 'ok'`)

    const rows = []

    for (let n = 1; n <= chats; n++) {
      const sid = `oc-chat-${n}`
      const rid = `oc-rt-${n}`

      await cdp.eval(`window.__OC__.ids.push({ sid: ${JSON.stringify(sid)}, rid: ${JSON.stringify(rid)} }); 'ok'`)

      const openMs = Number(await cdp.eval(openOne(sid, rid, turns)))

      // Let the mount + transcript settle so heap is steady-state, not mid-paint.
      await sleep(250)

      // A chat the user "keeps open" must stay open in the store.
      const s = await sample()

      rows.push({ n, open_ms: openMs, ...s })
    }

    // Cached switch-back: reactivate the FIRST chat, which has been parked
    // longest, and then the newest. Both are already-open chats.
    const switchTimes = []

    for (const sid of [`oc-chat-1`, `oc-chat-${chats}`, `oc-chat-${Math.max(1, Math.floor(chats / 2))}`]) {
      await sleep(150)

      const before = await cdp.send('Runtime.getHeapUsage')
      const ms = Number(await cdp.eval(revealTimed(sid)))

      switchTimes.push({ ms, sid })
      const after = await cdp.send('Runtime.getHeapUsage')

      if (after.usedSize > before.usedSize * 4) {
        switchTimes[switchTimes.length - 1].alloc_ratio =
          Math.round((after.usedSize / Math.max(1, before.usedSize)) * 100) / 100
      }
    }

    const final = await sample()
    await cdp.eval(CLEANUP)

    const first = rows.find(r => r.n === 1) ?? rows[0]
    const last = rows[rows.length - 1]

    return {
      metrics: {
        chats,
        heap_mb_first: first.js_heap_mb,
        heap_mb_last: last.js_heap_mb,
        heap_mb_per_chat: Math.round(((last.js_heap_mb - first.js_heap_mb) / Math.max(1, chats - 1)) * 100) / 100,
        panes_mounted_last: last.panes_mounted,
        hidden_layers_last: last.hidden_layers,
        message_rows_last: last.message_rows,
        tiles_last: last.tiles,
        switch_ms_max: Math.max(...switchTimes.map(s => s.ms))
      },
      detail: {
        chats,
        turns,
        warmStart,
        rows,
        switchTimes,
        final
      }
    }
  }
}
