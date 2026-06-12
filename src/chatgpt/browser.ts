/*
 * ChatGPT proxy — browser lifecycle (Playwright).
 *
 * One persistent browser context per account (profile under chatgpt_profiles/).
 * ChatGPT is protected by Cloudflare + Arkose + a Sentinel proof-of-work, so we
 * never reverse-engineer those: the completion is driven through the real page
 * (type + send) and the page solves everything itself. The streamed
 * /backend-api/conversation response is teed back to Node via an in-page hook +
 * the exposed __cgChunk function (keyed by account id, stable across navigation).
 */

import { chromium, firefox, webkit, BrowserContext, Page } from 'playwright'
import path from 'path'
import { ChatGPTAccount } from './accounts.ts'
import { pushChunk } from './tee.ts'

export const CG_URL = 'https://chatgpt.com'

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

/**
 * Page-side hook (via addInitScript). ChatGPT streams the answer over a separate
 * conduit/WebSocket channel — NOT in the completion response body — so the actual
 * content is captured by scraping the rendered DOM (see complete.ts), not from
 * the network. This hook only logs requested URLs when CHATGPT_DEBUG is on, which
 * is handy for diagnosis. Control messages use a "__CGCTRL__" prefix.
 */
function buildHookScript(accountId: string, debug: boolean): string {
  if (!debug) return `(() => { window.__cgAccountId = ${JSON.stringify(accountId)}; })();`
  return `(() => {
    window.__cgAccountId = ${JSON.stringify(accountId)};
    const send = (d) => { try { window.__cgChunk(window.__cgAccountId, d); } catch (e) {} };
    if (!window.__cgHooked && typeof window.fetch === 'function') {
      window.__cgHooked = true;
      const orig = window.fetch.bind(window);
      window.fetch = function (...args) {
        try {
          const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
          const m = (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET';
          if (url) send('__CGCTRL__URL ' + m + ' ' + url);
        } catch (e) {}
        return orig(...args);
      };
    }
    if (!window.__cgXhrHooked && window.XMLHttpRequest) {
      window.__cgXhrHooked = true;
      const xo = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        try { if (url) send('__CGCTRL__URL [xhr] ' + method + ' ' + url); } catch (e) {}
        return xo.apply(this, arguments);
      };
    }
  })();`
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

export async function initChatGPTAccount(account: ChatGPTAccount, headless = true, browserType: BrowserType = 'chromium'): Promise<void> {
  if (pages.has(account.id)) return
  const profilePath = path.resolve('chatgpt_profiles', account.id)
  console.log(`[ChatGPT] Launching ${browserType} for account ${account.email}...`)
  const ctx = await launchContext(profilePath, headless, browserType)

  await ctx.exposeFunction('__cgChunk', (accountId: string, data: string) => pushChunk(accountId, data))
  await ctx.addInitScript(buildHookScript(account.id, process.env.CHATGPT_DEBUG === '1'))

  const page = ctx.pages()[0] || (await ctx.newPage())
  contexts.set(account.id, ctx)
  pages.set(account.id, page)
  await page.goto(`${CG_URL}/`, { waitUntil: 'domcontentloaded' }).catch(() => {})
}

export async function isLoggedIn(page: Page): Promise<boolean> {
  // /api/auth/session returns { user, accessToken, expires } when logged in, {}
  // otherwise. Most reliable signal (cookie-based session, not localStorage).
  try {
    return await page.evaluate(async () => {
      try {
        const r = await fetch('/api/auth/session', { credentials: 'include' })
        if (!r.ok) return false
        const j = await r.json()
        return !!(j && j.user)
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

export async function launchManualLogin(accountId: string, browserType: BrowserType = 'chromium'): Promise<{ context: BrowserContext; page: Page }> {
  const profilePath = path.resolve('chatgpt_profiles', accountId)
  const ctx = await launchContext(profilePath, false, browserType)
  const page = ctx.pages()[0] || (await ctx.newPage())
  await page.goto(`${CG_URL}/`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  return { context: ctx, page }
}

export async function closeChatGPTAccount(accountId: string): Promise<void> {
  const ctx = contexts.get(accountId)
  if (ctx) {
    await ctx.close().catch(() => {})
    contexts.delete(accountId)
    pages.delete(accountId)
  }
}

export async function closeAllChatGPT(): Promise<void> {
  for (const id of [...contexts.keys()]) {
    await closeChatGPTAccount(id)
  }
}
