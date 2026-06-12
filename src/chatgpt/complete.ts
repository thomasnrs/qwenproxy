/*
 * ChatGPT proxy — completion via UI driving + DOM scraping.
 *
 * ChatGPT streams the answer over a conduit/WebSocket channel (the completion
 * POST only returns a token), so intercepting the network body doesn't work.
 * Instead we type + send through the real page and read the rendered assistant
 * message from the DOM as it grows, emitting text deltas. This is transport-
 * agnostic — it sidesteps the conduit, the Sentinel PoW, and Cloudflare.
 *
 * Selectors are best-effort; CHATGPT_DEBUG=1 logs the requested URLs.
 */

import { getPage, getMutex, isLoggedIn, CG_URL } from './browser.ts'
import { registerSink, unregisterSink } from './tee.ts'

const DEBUG = process.env.CHATGPT_DEBUG === '1'
const RESPONSE_TIMEOUT_MS = 180000
const STALL_TIMEOUT_MS = 90000

export type CGEvent =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'error'; message: string }

async function submitPrompt(page: any, prompt: string): Promise<void> {
  const editorSel = '#prompt-textarea'
  const el = await page.$(editorSel)
  if (el) {
    await el.click().catch(() => {})
    try {
      await page.fill(editorSel, prompt)
    } catch {
      await page.evaluate((text: string) => {
        const e = document.querySelector('#prompt-textarea') as HTMLElement | null
        if (e) { e.innerText = text; e.dispatchEvent(new Event('input', { bubbles: true })) }
      }, prompt)
    }
  } else {
    const ce = await page.$('[contenteditable="true"], textarea')
    if (!ce) throw new Error('ChatGPT input not found (#prompt-textarea / contenteditable / textarea)')
    await ce.click().catch(() => {})
    try { await page.fill('[contenteditable="true"], textarea', prompt) } catch { await page.keyboard.insertText(prompt) }
  }

  await page.waitForTimeout(300)
  const btn = await page.$('[data-testid="send-button"], button[aria-label*="Send" i]')
  if (btn) await btn.click().catch(() => {})
  else await page.keyboard.press('Enter')
}

// Built as a STRING (not a function reference): tsx/esbuild rewrites named
// functions with a __name() helper that doesn't exist in the page, so a passed
// function throws "__name is not defined". A string is injected verbatim.
//
// Installed after sending: polls the last assistant message and tees text deltas
// (cumulative innerText -> delta), finishing when generation stops (no
// stop-button) and the text has been stable for a moment.
function buildObserverScript(accountId: string): string {
  return `(() => {
    const w = window;
    try { if (w.__cgObserverStop) w.__cgObserverStop(); } catch (e) {}
    const send = (d) => { try { w.__cgChunk(${JSON.stringify(accountId)}, d); } catch (e) {} };
    let lastText = '', stable = 0, started = false;
    const contentEl = () => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      const m = msgs[msgs.length - 1];
      if (!m) return null;
      return m.querySelector('.markdown') || m;
    };
    const isGenerating = () => !!document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop" i]');
    let id = null, safety = null;
    const stop = () => { if (id) clearInterval(id); if (safety) clearTimeout(safety); w.__cgObserverStop = null; };
    const tick = () => {
      const el = contentEl();
      const txt = el ? (el.innerText || '') : '';
      if (txt && txt !== lastText) {
        if (txt.length > lastText.length) send(txt.slice(lastText.length));
        lastText = txt;
      }
      if (isGenerating()) { started = true; stable = 0; }
      else if (started || lastText) { stable++; }
      if (stable >= 8) { stop(); send('__CGCTRL__DONE'); }
    };
    id = setInterval(tick, 200);
    safety = setTimeout(() => { stop(); send('__CGCTRL__DONE'); }, 175000);
    w.__cgObserverStop = stop;
  })();`
}

export async function* streamChatGPT(accountId: string, prompt: string): AsyncGenerator<CGEvent> {
  const page = getPage(accountId)
  if (!page) {
    yield { type: 'error', message: `ChatGPT account not initialized: ${accountId}` }
    return
  }

  const release = await getMutex(accountId).acquire()

  const pending: string[] = []
  let waiter: ((v: string | null) => void) | null = null
  let finished = false
  const push = (v: string | null) => {
    if (v === null) finished = true
    if (waiter) { const w = waiter; waiter = null; w(v) }
    else if (v !== null) pending.push(v)
  }
  const nextRaw = (): Promise<string | null> => {
    if (pending.length) return Promise.resolve(pending.shift()!)
    if (finished) return Promise.resolve(null)
    return new Promise(res => { waiter = res })
  }

  registerSink(accountId, (data: string) => {
    if (data === '__CGCTRL__DONE') { push(null); return }
    if (data.startsWith('__CGCTRL__ERR')) { push('__CGCTRL__ERR' + data.slice('__CGCTRL__ERR'.length)); return }
    if (data.startsWith('__CGCTRL__URL')) { if (DEBUG) console.log('[ChatGPT][url]', data.slice('__CGCTRL__URL'.length).trim()); return }
    push(data)
  })

  let stallTimer: NodeJS.Timeout | null = null
  let hardTimer: NodeJS.Timeout | null = null
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => push(null), STALL_TIMEOUT_MS)
  }

  try {
    await page.goto(`${CG_URL}/`, { waitUntil: 'domcontentloaded' }).catch(() => {})
    if (!(await isLoggedIn(page))) {
      yield { type: 'error', message: 'ChatGPT account is not logged in (or blocked by Cloudflare). Run `npm run chatgpt:login`.' }
      return
    }

    try {
      await submitPrompt(page, prompt)
      await page.evaluate(buildObserverScript(accountId))
    } catch (e: any) {
      yield { type: 'error', message: `Failed to drive ChatGPT UI: ${e?.message}` }
      return
    }

    hardTimer = setTimeout(() => push(null), RESPONSE_TIMEOUT_MS)
    armStall()

    let sawAny = false
    while (true) {
      const raw = await nextRaw()
      if (raw === null) break
      armStall()
      if (raw.startsWith('__CGCTRL__ERR')) {
        yield { type: 'error', message: `ChatGPT error: ${raw.slice('__CGCTRL__ERR'.length)}` }
        break
      }
      if (DEBUG) console.log('[ChatGPT][delta]', JSON.stringify(raw))
      sawAny = true
      yield { type: 'content', text: raw }
    }

    if (!sawAny) {
      yield { type: 'error', message: 'No response scraped from ChatGPT. Selectors may be off (assistant message / stop button), or the send did not fire. Run with CHATGPT_DEBUG=1.' }
    }
  } finally {
    if (stallTimer) clearTimeout(stallTimer)
    if (hardTimer) clearTimeout(hardTimer)
    try { await page.evaluate('(() => { try { if (window.__cgObserverStop) window.__cgObserverStop(); } catch (e) {} })()') } catch {}
    unregisterSink(accountId)
    release()
  }
}
