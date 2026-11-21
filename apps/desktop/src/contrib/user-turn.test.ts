import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { registry } from '@/contrib/registry'

import { dispatchUserTurn, USER_TURN_AREA, type UserTurn } from './user-turn'

const disposers: Array<() => void> = []

function addSink(id: string, handle: (turn: UserTurn) => void, order?: number) {
  disposers.push(registry.register({ id, area: USER_TURN_AREA, order, data: { handle } satisfies { handle: (turn: UserTurn) => void } }))
}

function turn(over: Partial<UserTurn> = {}): UserTurn {
  return {
    source: 'composer',
    messageId: 'user-1',
    sessionId: 'rt-1',
    storedSessionId: 'st-1',
    text: 'send all four',
    at: 1.5,
    ...over
  }
}

afterEach(() => {
  disposers.splice(0).forEach(d => d())
  vi.restoreAllMocks()
})

describe('dispatchUserTurn', () => {
  it('hands the accepted turn to every registered sink, unchanged', () => {
    const a = vi.fn()
    const b = vi.fn()

    addSink('a', a)
    addSink('b', b)

    const event = turn()

    dispatchUserTurn(event)

    expect(a).toHaveBeenCalledWith(event)
    expect(b).toHaveBeenCalledWith(event)
  })

  it('isolates a throwing sink so the send and the other sinks are unaffected', () => {
    const after = vi.fn()
    const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    addSink('boom', () => {
      throw new Error('broken plugin')
    })
    addSink('after', after)

    expect(() => dispatchUserTurn(turn())).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
    expect(logs).toHaveBeenCalled()
  })

  it('skips a contribution with no handle instead of calling it', () => {
    const good = vi.fn()

    disposers.push(registry.register({ id: 'empty', area: USER_TURN_AREA, data: {} }))
    addSink('good', good)

    dispatchUserTurn(turn())

    expect(good).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch a turn with no words', () => {
    const sink = vi.fn()

    addSink('sink', sink)

    dispatchUserTurn(turn({ text: '   ' }))

    expect(sink).not.toHaveBeenCalled()
  })

  it('stops after the disposer runs', () => {
    const sink = vi.fn()

    addSink('sink', sink)
    disposers.splice(0).forEach(d => d())

    dispatchUserTurn(turn())

    expect(sink).not.toHaveBeenCalled()
  })
})

describe('the writer', () => {
  // A second dispatch site would be a second writer of the person's word: some
  // surface other than the accepted composer submit could then hand a consumer
  // a "typed turn" the person never typed. Keep the call sites at one.
  function filesUnder(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = join(dir, entry.name)

      if (entry.isDirectory()) {
        return entry.name === 'node_modules' ? [] : filesUnder(full)
      }

      return /\.tsx?$/.test(entry.name) ? [full] : []
    })
  }

  it('is dispatched from the submit pipeline only', () => {
    // vitest runs from apps/desktop
    const src = join(process.cwd(), 'src')

    const callers = filesUnder(src)
      .filter(file => !/\.test\.tsx?$/.test(file) && !file.endsWith(join('contrib', 'user-turn.ts')))
      .filter(file => readFileSync(file, 'utf8').includes('dispatchUserTurn('))
      .map(file => relative(src, file))

    expect(callers).toEqual([join('app', 'session', 'hooks', 'use-prompt-actions', 'submit.ts')])
  })
})
