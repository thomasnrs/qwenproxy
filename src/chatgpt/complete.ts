/*
 * ChatGPT proxy — completion via UI driving + stream tee.
 *
 * Per request (serialized per account): open a fresh chat, type the prompt, send.
 * The page handles Cloudflare/Arkose/Sentinel/PoW and fires
 * /backend-api/conversation; the hook (browser.ts) tees the SSE back here keyed
 * by account id, which we parse into typed events.
 *
 * The SSE PARSER is best-effort — ChatGPT's stream format varies (cumulative
 * `parts` vs `{o,p,v}` patch ops). Set CHATGPT_DEBUG=1 to log raw chunks + URLs
 * and lock the parser to the real format.
 */

import { getPage, getMutex, isLoggedIn, CG_URL } from './browser.ts'
import { registerSink, unregisterSink } from './tee.ts'

const DEBUG = process.env.CHATGPT_DEBUG === '1'
const RESPONSE_TIMEOUT_MS = 180000
const STALL_TIMEOUT_MS = 60000

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
  // Prefer the send button (multiline-safe); fall back to Enter.
  const btn = await page.$('[data-testid="send-button"], button[aria-label*="Send" i]')
  if (btn) await btn.click().catch(() => {})
  else await page.keyboard.press('Enter')
}

interface ParseState { lastContent: string; lastReasoning: string; lastPath: string }

function emitCumulative(full: string, isThought: boolean, state: ParseState, out: CGEvent[]): void {
  const prev = isThought ? state.lastReasoning : state.lastContent
  let delta = ''
  if (full.length >= prev.length && full.startsWith(prev)) delta = full.slice(prev.length)
  else if (full !== prev) delta = full // non-prefix change — emit whole
  if (delta) out.push({ type: isThought ? 'reasoning' : 'content', text: delta })
  if (isThought) state.lastReasoning = full
  else state.lastContent = full
}

// Best-effort parse of one ChatGPT SSE payload.
function parsePayload(jsonStr: string, state: ParseState): CGEvent[] {
  const out: CGEvent[] = []
  let obj: any
  try {
    obj = JSON.parse(jsonStr)
  } catch {
    return out
  }

  // Shape A: full message object { message: { author, content: { content_type, parts } } }
  const msg = obj?.message || obj?.v?.message
  if (msg?.content?.parts && Array.isArray(msg.content.parts)) {
    const parts = msg.content.parts.filter((p: any) => typeof p === 'string')
    if (parts.length) {
      const isThought = msg.content.content_type === 'thoughts' || msg.author?.role === 'tool'
      emitCumulative(parts.join(''), isThought, state, out)
      return out
    }
  }

  // Shape B: patch ops { o: 'append'|'patch'|'add', p: '/message/content/parts/0', v: '...' }
  if (obj && obj.v !== undefined) {
    const p: string = typeof obj.p === 'string' ? obj.p : state.lastPath
    if (typeof obj.p === 'string') state.lastPath = obj.p
    const v = obj.v
    if (typeof v === 'string') {
      const isThought = p.indexOf('thought') !== -1
      if (p.indexOf('parts') !== -1 || p === '' || p.indexOf('content') !== -1) {
        out.push({ type: isThought ? 'reasoning' : 'content', text: v })
      }
    } else if (Array.isArray(v)) {
      // batch of patch ops
      for (const op of v) {
        if (op && typeof op.v === 'string') {
          const pp = typeof op.p === 'string' ? op.p : state.lastPath
          const isThought = pp.indexOf('thought') !== -1
          if (pp.indexOf('parts') !== -1 || pp.indexOf('content') !== -1) out.push({ type: isThought ? 'reasoning' : 'content', text: op.v })
        }
      }
    }
  }

  return out
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
    } catch (e: any) {
      yield { type: 'error', message: `Failed to submit prompt to ChatGPT UI: ${e?.message}` }
      return
    }

    hardTimer = setTimeout(() => push(null), RESPONSE_TIMEOUT_MS)
    armStall()

    const state: ParseState = { lastContent: '', lastReasoning: '', lastPath: '' }
    let buffer = ''
    let sawAny = false
    while (true) {
      const raw = await nextRaw()
      if (raw === null) break
      armStall()
      if (raw.startsWith('__CGCTRL__ERR')) {
        yield { type: 'error', message: `ChatGPT stream error: ${raw.slice('__CGCTRL__ERR'.length)}` }
        break
      }
      sawAny = true
      if (DEBUG) console.log('[ChatGPT][raw]', JSON.stringify(raw))

      buffer += raw
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        for (const ev of parsePayload(payload, state)) yield ev
      }
    }

    if (!sawAny) {
      yield { type: 'error', message: 'No stream captured from ChatGPT. The page may have been blocked (Cloudflare) or did not send. Run with CHATGPT_DEBUG=1 to see the requested URLs.' }
    }
  } finally {
    if (stallTimer) clearTimeout(stallTimer)
    if (hardTimer) clearTimeout(hardTimer)
    unregisterSink(accountId)
    release()
  }
}
