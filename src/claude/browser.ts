/*
 * Claude proxy - browser lifecycle (Playwright).
 */

import { chromium, firefox, webkit, BrowserContext, Page } from 'playwright'
import path from 'path'
import { ClaudeAccount } from './accounts.ts'
import { pushChunk } from './tee.ts'

export const CLAUDE_URL = 'https://claude.ai'
export const CLAUDE_NEW_CHAT_URL = `${CLAUDE_URL}/new`

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
  let mutex = mutexes.get(accountId)
  if (!mutex) {
    mutex = new Mutex()
    mutexes.set(accountId, mutex)
  }
  return mutex
}

function isClaudeDebugEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.CLAUDE_DEBUG || '').toLowerCase())
}

function buildHookScript(accountId: string, debug: boolean): string {
  return `(() => {
    window.__clAccountId = ${JSON.stringify(accountId)};
    window.__clDebug = ${debug ? 'true' : 'false'};
    const send = (d) => { try { window.__clChunk(window.__clAccountId, d); } catch (e) {} };
    if (window.__clDebug) send('__CLDBG__hook-installed ' + location.href);
    const isClaudeCompletion = (url, method) => {
      const u = String(url || '');
      const m = String(method || 'GET').toUpperCase();
      if (window.__clDebug && u) send('__CLCTRL__URL ' + m + ' ' + u);
      return m !== 'GET' && u.indexOf('/api/') !== -1 &&
        /(\\/completion\\d*|append_message|retry)/i.test(u);
    };

    if (!window.__clHooked && typeof window.fetch === 'function') {
      window.__clHooked = true;
      const orig = window.fetch.bind(window);
      window.fetch = async function (...args) {
        let url = '', method = 'GET';
        try {
          url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
          method = (args[1] && args[1].method) || (args[0] && args[0].method) || method;
        } catch (e) {}
        const res = await orig(...args);
        try {
          const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
          const shouldTee = isClaudeCompletion(url, method) || /text\\/event-stream|application\\/x-ndjson/i.test(ct);
          if (res && res.body && shouldTee) {
            if (window.__clDebug) send('__CLDBG__fetch-stream ' + method + ' ' + url + ' ct=' + ct);
            send('__CLCTRL__NETSTART ' + method + ' ' + url);
            const clone = res.clone();
            (async () => {
              try {
                const reader = clone.body.getReader();
                const dec = new TextDecoder();
                for (;;) {
                  const r = await reader.read();
                  if (r.done) { send('__CLCTRL__NETDONE'); break; }
                  send(dec.decode(r.value, { stream: true }));
                }
              } catch (e) { send('__CLCTRL__ERR' + ((e && e.message) || e)); }
            })();
          }
        } catch (e) {}
        return res;
      };
    }

    if (!window.__clXhrHooked && window.XMLHttpRequest) {
      window.__clXhrHooked = true;
      const xo = XMLHttpRequest.prototype.open;
      const xs = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        try { this.__clUrl = url; this.__clMethod = method; } catch (e) {}
        return xo.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        try {
          const url = this.__clUrl || '';
          const method = this.__clMethod || 'GET';
          if (isClaudeCompletion(url, method)) {
            if (window.__clDebug) send('__CLDBG__xhr-stream ' + method + ' ' + url);
            send('__CLCTRL__NETSTART ' + method + ' ' + url);
            let lastLen = 0;
            let done = false;
            const pump = () => {
              try {
                if (this.responseType && this.responseType !== 'text') return;
                const txt = this.responseText || '';
                if (txt.length > lastLen) { send(txt.slice(lastLen)); lastLen = txt.length; }
              } catch (e) {}
            };
            const finish = () => { if (done) return; done = true; pump(); send('__CLCTRL__NETDONE'); };
            this.addEventListener('readystatechange', () => { if (this.readyState >= 3) pump(); });
            this.addEventListener('progress', pump);
            this.addEventListener('load', finish);
            this.addEventListener('loadend', finish);
            this.addEventListener('error', () => { if (!done) { done = true; send('__CLCTRL__ERR xhr error'); } });
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

export async function initClaudeAccount(account: ClaudeAccount, headless = true, browserType: BrowserType = 'chromium'): Promise<void> {
  if (pages.has(account.id)) return

  const profilePath = path.resolve('claude_profiles', account.id)
  console.log(`[Claude] Launching ${browserType} for account ${account.email}...`)
  const ctx = await launchContext(profilePath, headless, browserType)

  await ctx.exposeFunction('__clChunk', (id: string, data: string) => pushChunk(id, data))
  await ctx.addInitScript(buildHookScript(account.id, isClaudeDebugEnabled()))

  const page = ctx.pages()[0] || (await ctx.newPage())
  contexts.set(account.id, ctx)
  pages.set(account.id, page)
  await page.goto(CLAUDE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
}

export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const ok = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/organizations', { credentials: 'include' })
        if (!r.ok) return false
        const j = await r.json()
        return Array.isArray(j) ? j.length > 0 : !!j
      } catch {
        return false
      }
    })
    if (ok) return true
  } catch {}

  try {
    if (/login|signin|sign-in|onboarding/i.test(page.url())) return false
    return !!(await page.$('textarea, [contenteditable="true"], div.ProseMirror'))
  } catch {
    return false
  }
}

export async function launchManualLogin(accountId: string, browserType: BrowserType = 'chromium'): Promise<{ context: BrowserContext; page: Page }> {
  const profilePath = path.resolve('claude_profiles', accountId)
  const ctx = await launchContext(profilePath, false, browserType)
  const page = ctx.pages()[0] || (await ctx.newPage())
  await page.goto(CLAUDE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
  return { context: ctx, page }
}

export async function closeClaudeAccount(accountId: string): Promise<void> {
  const ctx = contexts.get(accountId)
  if (ctx) {
    await ctx.close().catch(() => {})
    contexts.delete(accountId)
    pages.delete(accountId)
  }
}

export async function closeAllClaude(): Promise<void> {
  for (const id of [...contexts.keys()]) {
    await closeClaudeAccount(id)
  }
}
