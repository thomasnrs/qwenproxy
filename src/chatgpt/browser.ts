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
 * Page-side hook (via addInitScript: runs before the site's scripts and on every
 * navigation). Tees the streamed completion to Node via __cgChunk. ChatGPT
 * streams /backend-api/conversation; we capture it from both fetch and XHR.
 * Control messages use a "__CGCTRL__" prefix real SSE data never starts with.
 */
function buildHookScript(accountId: string, debug: boolean): string {
  return `(() => {
    window.__cgAccountId = ${JSON.stringify(accountId)};
    window.__cgDebug = ${debug ? 'true' : 'false'};
    const send = (d) => { try { window.__cgChunk(window.__cgAccountId, d); } catch (e) {} };
    const isCompletion = (url, method) => {
      if (typeof url !== 'string') return false;
      if (url.indexOf('/conversation') === -1) return false;
      if (url.indexOf('gen_title') !== -1 || url.indexOf('/init') !== -1) return false;
      return (method || 'GET').toUpperCase() === 'POST';
    };

    if (!window.__cgHooked && typeof window.fetch === 'function') {
      window.__cgHooked = true;
      const orig = window.fetch.bind(window);
      window.fetch = async function (...args) {
        let url = '', method = 'GET';
        try { url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || ''; method = (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET'; } catch (e) {}
        if (window.__cgDebug && url) send('__CGCTRL__URL ' + method + ' ' + url);
        const res = await orig(...args);
        try {
          if (isCompletion(url, method) && res && res.body) {
            const clone = res.clone();
            (async () => {
              try {
                const reader = clone.body.getReader();
                const dec = new TextDecoder();
                for (;;) {
                  const r = await reader.read();
                  if (r.done) { send('__CGCTRL__DONE'); break; }
                  send(dec.decode(r.value, { stream: true }));
                }
              } catch (e) { send('__CGCTRL__ERR' + ((e && e.message) || e)); }
            })();
          }
        } catch (e) {}
        return res;
      };
    }

    if (!window.__cgXhrHooked && window.XMLHttpRequest) {
      window.__cgXhrHooked = true;
      const xo = XMLHttpRequest.prototype.open;
      const xs = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        try { this.__cgUrl = url; this.__cgMethod = method; } catch (e) {}
        if (window.__cgDebug && url) send('__CGCTRL__URL [xhr] ' + method + ' ' + url);
        return xo.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        try {
          if (isCompletion(this.__cgUrl || '', this.__cgMethod)) {
            let lastLen = 0, done = false;
            const pump = () => {
              try {
                if (this.responseType && this.responseType !== 'text') return;
                const txt = this.responseText || '';
                if (txt.length > lastLen) { send(txt.slice(lastLen)); lastLen = txt.length; }
              } catch (e) {}
            };
            const finish = () => { if (done) return; done = true; pump(); send('__CGCTRL__DONE'); };
            this.addEventListener('readystatechange', () => { if (this.readyState >= 3) pump(); });
            this.addEventListener('progress', pump);
            this.addEventListener('load', finish);
            this.addEventListener('loadend', finish);
            this.addEventListener('error', () => { if (!done) { done = true; send('__CGCTRL__ERR xhr error'); } });
            this.addEventListener('abort', finish);
          }
        } catch (e) {}
        return xs.apply(this, arguments);
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
