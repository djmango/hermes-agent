/**
 * The composer's `/` palette over a REMOTE backend (./remote-helpers.ts: a real
 * `hermes serve` the Desktop did not spawn, reached by URL + token under its own
 * HOME).
 *
 * Reported: "typing narrows nothing and the highlight stays on the first item,
 * so Enter runs the wrong command". Narrowing is not a client filter — every
 * keystroke asks the session's own backend (`complete.slash`) — so these are the
 * user-visible facts on a live remote session: the row list shrinks, the command
 * being typed is IN it and leads it, and Enter never commits a neighbour.
 *
 * `/model` is `desktop="hidden"` (the model pill owns discovery) and is the only
 * such command today, which is what made it the visible failure: the popover
 * dropped it from its own name match and kept only fuzzy DESCRIPTION matches of
 * other commands, so `/moa` held the highlight and `/mo` + Enter ran it.
 */

import { expect, type Page, test } from '@playwright/test'

import {
  composer,
  coreAppEnv,
  createCoreSandbox,
  launchCoreApp,
  recordWebSockets,
  waitForInteractive,
  writeProviderHome
} from './harness'
import { startScriptedProvider } from './provider'
import { remoteEnv, startRemoteBackend } from './remote-helpers'

const drawer = (page: Page) =>
  page.locator('[data-slot="composer-completion-drawer"]').filter({ visible: true }).first()

/** Every rendered completion row, in visual order — one atomic DOM read so a
 *  re-ranked list cannot pull the rows out from under a per-row locator. */
async function rows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = [...document.querySelectorAll<HTMLElement>('[data-slot="composer-completion-drawer"]')].find(
      el => el.offsetParent !== null
    )

    if (!root) {
      return []
    }

    return [...root.querySelectorAll<HTMLElement>('button')].map(
      button => (button.innerText ?? '').split('\n')[0]!.trim()
    )
  })
}

/** The command on the highlighted row — what Enter would run right now. */
async function highlighted(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = [...document.querySelectorAll<HTMLElement>('[data-slot="composer-completion-drawer"]')].find(
      el => el.offsetParent !== null
    )

    const row = root?.querySelector<HTMLElement>('button[data-highlighted]')

    return ((row?.innerText ?? '').split('\n')[0] ?? '').trim()
  })
}

test('slash palette narrows and re-highlights over a remote backend', async () => {
  const provider = await startScriptedProvider()
  const backendBox = createCoreSandbox('slash-remote-backend')
  const clientBox = createCoreSandbox('slash-remote-client')
  writeProviderHome(backendBox.hermesHome, provider.url)
  const backend = await startRemoteBackend(backendBox)
  const { app, page } = await launchCoreApp(coreAppEnv(clientBox, remoteEnv(backend)))
  const ws = recordWebSockets(page)

  try {
    await waitForInteractive(app, page)

    await test.step('bare `/` lists the remote catalog', async () => {
      await composer(page).click()
      await page.keyboard.type('/', { delay: 40 })
      await expect(drawer(page)).toBeVisible()
      await expect.poll(async () => (await rows(page)).length, { timeout: 60_000 }).toBeGreaterThan(10)
      expect(new URL(ws.sockets[0]!.url).port, 'the socket dials the remote backend').toBe(String(backend.port))
    })

    const catalog = await rows(page)

    await test.step('a partial name narrows the list', async () => {
      await page.keyboard.type('mo', { delay: 40 })

      await expect
        .poll(async () => (await rows(page)).length, { timeout: 60_000 })
        .toBeLessThan(Math.ceil(catalog.length / 2))
      await expect(drawer(page)).toContainText(/memory/i)
      // The highlight is a row of THIS list, not a stale one from the catalog.
      expect(await rows(page)).toContain(await highlighted(page))
    })

    await test.step('the command typed in full leads the list and takes the highlight', async () => {
      await page.keyboard.type('del', { delay: 40 })

      await expect.poll(async () => (await highlighted(page)), { timeout: 60_000 }).toBe('/model')
      expect((await rows(page))[0], 'the typed command leads its own list').toBe('/model')
    })

    await test.step('Enter never commits a neighbour while a hidden name is being typed', async () => {
      const before = ws.sent.length

      await page.keyboard.press('Escape')
      await page.keyboard.press('Control+a')
      await page.keyboard.press('Backspace')
      await page.keyboard.type('/mo', { delay: 40 })
      await expect.poll(async () => (await rows(page)).length, { timeout: 60_000 }).toBeGreaterThan(0)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(1200)

      const dispatched = ws.sent.slice(before).map(frame => JSON.stringify(frame.params ?? ''))
      expect(dispatched.some(params => /"moa"/.test(params)), 'Enter ran /moa for a token aimed at /model').toBe(false)
    })
  } finally {
    await app.close()
    await backend.kill()
    backendBox.cleanup()
    clientBox.cleanup()
    await provider.close()
  }
})
