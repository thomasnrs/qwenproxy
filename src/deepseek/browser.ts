/*
 * DeepSeek proxy — browser lifecycle (Playwright).
 *
 * One persistent browser context per account (profile under deepseek_profiles/),
 * mirroring the Qwen approach. We do NOT reverse-engineer DeepSeek's per-request
 * proof-of-work: instead the completion is driven through the real page (type +
 * send), and the page computes the PoW itself. The streamed response is teed
 * back to Node via an in-page fetch hook + the exposed __dsChunk function.
 */

import { chromium, firefox, webkit, BrowserContext, Page } from 'playwright'
import path from 'path'
import { DeepSeekAccount } from './accounts.ts'
import { pushChunk } from './tee.ts'

export const DS_URL = 'https://chat.deepseek.com'

export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

const contexts = new Map<string, BrowserContext>()
const pages = new Map<string, Page>()

export class Mutex {
  private queue: (() => void)[] = []
  private locked = false
  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true
      return () => this.release()
    }
    return new Promise<() => void>(resolve => {
      this.queue.push(() => resolve(() => this.release()))
    })
  }
  private release(): void {
    const next = this.queue.shift()
    if (next) next()
    else this.locked = false
  }
}

const mutexes = new Map<string, Mutex>()
export function getMutex(accountId: string): Mutex {
  let m = mutexes.get(accountId)
  if (!m) {
    m = new Mutex()
    mutexes.set(accountId, m)
  }
  return m
}

function resolveEngine(browserType: BrowserType): { engine: any; channel?: string } {
  switch (browserType) {
    case 'firefox': return { engine: firefox }
    case 'webkit': return { engine: webkit }
    case 'chrome': return { engine: chromium, channel: 'chrome' }
    case 'edge': return { engine: chromium, channel: 'msedge' }
    default: return { engine: chromium }
  }
}

async function launchContext(profilePath: string, headless: boolean, browserType: BrowserType): Promise<BrowserContext> {
  const { engine, channel } = resolveEngine(browserType)
  const ctx = await engine.launchPersistentContext(profilePath, {
    headless,
    channel,
    userAgent: USER_AGENT,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })
  return ctx
}

export function getPage(accountId: string): Page | undefined {
  return pages.get(accountId)
}

/** Launch (or no-op if already up) a headless page for an account. */
export async function initDeepSeekAccount(account: DeepSeekAccount, headless = true, browserType: BrowserType = 'chromium'): Promise<void> {
  if (pages.has(account.id)) return
  const profilePath = path.resolve('deepseek_profiles', account.id)
  console.log(`[DeepSeek] Launching ${browserType} for account ${account.email}...`)
  const ctx = await launchContext(profilePath, headless, browserType)
  const page = ctx.pages()[0] || (await ctx.newPage())
  await page.exposeFunction('__dsChunk', (reqId: string, data: string) => pushChunk(reqId, data))
  contexts.set(account.id, ctx)
  pages.set(account.id, page)
  await page.goto(`${DS_URL}/`, { waitUntil: 'domcontentloaded' }).catch(() => {})
}

export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const token = await page.evaluate(() => {
      try { return window.localStorage.getItem('userToken') } catch { return null }
    })
    return !!token && !page.url().includes('sign_in') && !page.url().includes('/login')
  } catch {
    return false
  }
}

/** Open a headful window pointed at the DeepSeek login page for manual login. */
export async function launchManualLogin(accountId: string, browserType: BrowserType = 'chromium'): Promise<{ context: BrowserContext; page: Page }> {
  const profilePath = path.resolve('deepseek_profiles', accountId)
  const ctx = await launchContext(profilePath, false, browserType)
  const page = ctx.pages()[0] || (await ctx.newPage())
  await page.goto(`${DS_URL}/sign_in`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  return { context: ctx, page }
}

export async function closeDeepSeekAccount(accountId: string): Promise<void> {
  const ctx = contexts.get(accountId)
  if (ctx) {
    await ctx.close().catch(() => {})
    contexts.delete(accountId)
    pages.delete(accountId)
  }
}

export async function closeAllDeepSeek(): Promise<void> {
  for (const id of [...contexts.keys()]) {
    await closeDeepSeekAccount(id)
  }
}
