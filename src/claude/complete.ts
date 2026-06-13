/*
 * Claude proxy - completion via UI driving + stream/DOM tee.
 */

import { getPage, getMutex, isLoggedIn, CLAUDE_NEW_CHAT_URL } from './browser.ts'
import { registerSink, unregisterSink } from './tee.ts'

function isClaudeDebugEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.CLAUDE_DEBUG || '').toLowerCase())
}

const DEBUG = isClaudeDebugEnabled()
const RESPONSE_TIMEOUT_MS = 240000
const STALL_TIMEOUT_MS = 90000

export type ClaudeEvent =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'error'; message: string }

async function findInput(page: any): Promise<{ selector: string; handle: any } | null> {
  const selectors = [
    'div.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    'textarea',
  ]

  for (const selector of selectors) {
    const handles = await page.$$(selector)
    for (const handle of handles) {
      const visible = await handle.evaluate((el: Element) => {
        const rect = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        return rect.width > 20 && rect.height > 10 && style.visibility !== 'hidden' && style.display !== 'none'
      }).catch(() => false)
      if (visible) return { selector, handle }
    }
  }

  return null
}

async function submitPrompt(page: any, prompt: string): Promise<void> {
  await page.goto(CLAUDE_NEW_CHAT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(1000)

  const input = await findInput(page)
  if (!input) throw new Error('Claude input not found (tried ProseMirror/contenteditable/textarea)')

  await input.handle.click().catch(() => {})
  if (input.selector === 'textarea') {
    try {
      await input.handle.fill(prompt)
    } catch {
      await page.keyboard.insertText(prompt)
    }
  } else {
    await page.keyboard.insertText(prompt)
  }

  await page.waitForTimeout(300)

  for (const selector of [
    'button[aria-label*="Send" i]:not([disabled])',
    'button[data-testid*="send" i]:not([disabled])',
    'button[type="submit"]:not([disabled])',
  ]) {
    const button = await page.$(selector)
    if (button) {
      await button.click().catch(() => {})
      return
    }
  }

  await page.keyboard.press('Enter')
}

function buildDomObserverScript(accountId: string, prompt: string, debug: boolean): string {
  return `(() => {
    const w = window;
    try { if (w.__clObserverStop) w.__clObserverStop(); } catch (e) {}
    const send = (d) => { try { w.__clChunk(${JSON.stringify(accountId)}, d); } catch (e) {} };
    const debug = ${debug ? 'true' : 'false'};
    const dbg = (d) => { if (debug) send('__CLDBG__' + d); };
    const promptText = ${JSON.stringify(prompt.slice(0, 4000))};
    const norm = (txt) => String(txt || '').replace(/\\s+/g, ' ').trim();
    const promptNorm = norm(promptText);
    const assistantSelectors = [
      '[data-testid*="assistant" i]',
      '[data-message-author-role="assistant"]',
      '[data-is-streaming="true"]',
      '.font-claude-message',
      '[class*="font-claude-message"]'
    ];
    const fallbackSelectors = [
      '[data-testid*="message" i]',
      'article',
      'main div'
    ];
    const selectors = assistantSelectors.concat(fallbackSelectors);
    dbg('dom-observer-installed url=' + location.href + ' promptLen=' + promptText.length);
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 30 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const clean = (txt) => {
      let out = String(txt || '').replace(/\\u00a0/g, ' ').trim();
      if (!promptText) return out;
      if (out.startsWith(promptText)) out = out.slice(promptText.length).trim();
      else if (out.includes(promptText)) out = out.split(promptText).join('').trim();
      out = out.replace(/^\\s*(User|Human):\\s*/i, '').trim();
      return out;
    };
    const meta = (el) => ((el.getAttribute('data-testid') || '') + ' ' + (el.getAttribute('data-message-author-role') || '') + ' ' + (el.className || '') + ' ' + el.tagName).toLowerCase();
    const rejectReason = (el, raw, txt) => {
      const key = meta(el);
      const rawNorm = norm(raw);
      const txtNorm = norm(txt);
      if (el.closest('[contenteditable="true"], textarea, button')) return 'interactive';
      if (key.includes('user') || key.includes('human')) return 'user-like';
      if (!txtNorm) return 'empty-after-clean';
      if (promptNorm && (txtNorm === promptNorm || promptNorm.includes(txtNorm))) return 'prompt-only';
      if (promptNorm && rawNorm === promptNorm) return 'raw-prompt-only';
      return '';
    };
    const score = (el, raw, txt, selector, order) => {
      const key = ((el.getAttribute('data-testid') || '') + ' ' + (el.className || '') + ' ' + el.tagName).toLowerCase();
      let score = txt.length + order;
      if (key.includes('assistant')) score += 10000;
      if (key.includes('claude')) score += 5000;
      if (key.includes('stream')) score += 3000;
      if (key.includes('message')) score += 1000;
      if (assistantSelectors.includes(selector)) score += 2000;
      if (promptText && raw.includes(promptText)) score -= 2500;
      return score;
    };
    const summarize = (item) => ({
      selector: item.selector,
      score: item.score,
      rawLen: item.raw.length,
      cleanLen: item.txt.length,
      reject: item.reject || '',
      key: item.key.slice(0, 120),
      text: item.txt.slice(0, 180)
    });
    let lastDebugAt = 0;
    const contentText = () => {
      const seen = new Set();
      const candidates = [];
      let order = 0;
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          if (seen.has(el) || !visible(el)) continue;
          seen.add(el);
          order++;
          const raw = String(el.innerText || el.textContent || '').trim();
          const txt = clean(raw);
          const reject = rejectReason(el, raw, txt);
          const key = meta(el);
          candidates.push({ el, selector, raw, txt, key, reject, score: reject ? -100000 : score(el, raw, txt, selector, order) });
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      if (debug && Date.now() - lastDebugAt > 1500) {
        lastDebugAt = Date.now();
        dbg('dom-candidates ' + JSON.stringify(candidates.slice(0, 8).map(summarize)));
      }
      const accepted = candidates.filter((item) => !item.reject);
      return accepted[0] ? accepted[0].txt : '';
    };
    const isGenerating = () => !!document.querySelector('button[aria-label*="Stop" i], button[data-testid*="stop" i]');
    let lastText = '', stable = 0, started = false;
    let id = null, safety = null;
    const stop = () => { if (id) clearInterval(id); if (safety) clearTimeout(safety); w.__clObserverStop = null; };
    const tick = () => {
      const txt = contentText();
      if (txt && txt !== lastText) {
        dbg('dom-selected len=' + txt.length + ' deltaMode=' + (txt.length > lastText.length && txt.startsWith(lastText) ? 'delta' : 'cumulative') + ' text=' + JSON.stringify(txt.slice(0, 220)));
        if (txt.length > lastText.length && txt.startsWith(lastText)) send('__CLDOM__' + txt.slice(lastText.length));
        else send('__CLDOMCUM__' + txt);
        lastText = txt;
      }
      if (isGenerating()) { started = true; stable = 0; }
      else if (started || lastText) { stable++; }
      if (stable >= 10) { stop(); send('__CLCTRL__DONE'); }
    };
    id = setInterval(tick, 250);
    safety = setTimeout(() => { stop(); send('__CLCTRL__DONE'); }, 230000);
    w.__clObserverStop = stop;
  })();`
}

interface ParseState {
  lastCumulative: string
}

interface SseParseResult {
  events: ClaudeEvent[]
  buffer: string
}

function appendDelta(state: ParseState, value: string, cumulative = false): string {
  const text = String(value || '')
  if (!text) return ''
  if (!cumulative) return text
  if (!state.lastCumulative) {
    state.lastCumulative = text
    return text
  }
  if (text === state.lastCumulative) return ''
  if (text.startsWith(state.lastCumulative)) {
    const delta = text.slice(state.lastCumulative.length)
    state.lastCumulative = text
    return delta
  }
  state.lastCumulative = text
  return text
}

function textFromContent(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part: any) => {
    if (typeof part === 'string') return part
    if (typeof part?.text === 'string') return part.text
    if (typeof part?.content === 'string') return part.content
    return ''
  }).join('')
}

function parsePayload(jsonStr: string, state: ParseState): ClaudeEvent[] {
  const out: ClaudeEvent[] = []
  let obj: any
  try {
    obj = JSON.parse(jsonStr)
  } catch {
    return out
  }

  if (typeof obj?.completion === 'string') {
    const text = appendDelta(state, obj.completion, false)
    if (text) out.push({ type: 'content', text })
    return out
  }

  const delta = obj?.delta || obj?.content_block?.delta || obj?.choices?.[0]?.delta
  if (delta) {
    if (typeof delta.text === 'string') out.push({ type: 'content', text: delta.text })
    if (typeof delta.content === 'string') out.push({ type: 'content', text: delta.content })
    if (typeof delta.reasoning_content === 'string') out.push({ type: 'reasoning', text: delta.reasoning_content })
    if (out.length) return out
  }

  const content = textFromContent(obj?.message?.content ?? obj?.content)
  if (content) {
    const text = appendDelta(state, content, true)
    if (text) out.push({ type: 'content', text })
  }

  if (!out.length && typeof obj?.text === 'string' && /delta|completion|content/i.test(String(obj?.type || ''))) {
    out.push({ type: 'content', text: obj.text })
  }

  return out
}

function parseSseBuffer(buffer: string, state: ParseState, flush = false): SseParseResult {
  const events: ClaudeEvent[] = []
  const normalized = buffer.replace(/\r\n/g, '\n')
  const blocks = normalized.split(/\n\n/)
  const pending = flush ? '' : (blocks.pop() || '')
  const completeBlocks = flush ? blocks.filter(Boolean).concat(blocks.length ? [] : [normalized]) : blocks

  for (const block of completeBlocks) {
    const dataLines = block
      .split('\n')
      .map(line => line.trimEnd())
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())

    if (dataLines.length === 0) continue
    const payload = dataLines.join('\n').trim()
    if (!payload || payload === '[DONE]') continue
    for (const event of parsePayload(payload, state)) events.push(event)
  }

  return { events, buffer: pending }
}

function dedupeAppend(emitted: string, text: string): { emitted: string; delta: string } {
  if (!text) return { emitted, delta: '' }
  if (!emitted) return { emitted: text, delta: text }
  if (emitted.endsWith(text)) return { emitted, delta: '' }
  if (text.length >= 16 && emitted.includes(text)) return { emitted, delta: '' }
  if (text.startsWith(emitted)) return { emitted: text, delta: text.slice(emitted.length) }

  const max = Math.min(emitted.length, text.length, 2000)
  for (let n = max; n > 0; n--) {
    if (emitted.endsWith(text.slice(0, n))) {
      const delta = text.slice(n)
      return { emitted: emitted + delta, delta }
    }
  }

  return { emitted: emitted + text, delta: text }
}

export async function* streamClaude(accountId: string, prompt: string): AsyncGenerator<ClaudeEvent> {
  const page = getPage(accountId)
  if (!page) {
    yield { type: 'error', message: `Claude account not initialized: ${accountId}` }
    return
  }

  const release = await getMutex(accountId).acquire()

  const pending: string[] = []
  let waiter: ((value: string | null) => void) | null = null
  let finished = false
  const push = (value: string | null) => {
    if (value === null) finished = true
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve(value)
    } else if (value !== null) {
      pending.push(value)
    }
  }
  const nextRaw = (): Promise<string | null> => {
    if (pending.length) return Promise.resolve(pending.shift()!)
    if (finished) return Promise.resolve(null)
    return new Promise(resolve => { waiter = resolve })
  }

  registerSink(accountId, (data: string) => {
    if (data === '__CLCTRL__DONE') { push(data); return }
    if (data.startsWith('__CLCTRL__NETSTART')) { push(data); return }
    if (data === '__CLCTRL__NETDONE') { push(data); return }
    if (data.startsWith('__CLCTRL__ERR')) { push('__CLCTRL__ERR' + data.slice('__CLCTRL__ERR'.length)); return }
    if (data.startsWith('__CLCTRL__URL')) { if (DEBUG) console.log('[Claude][url]', data.slice('__CLCTRL__URL'.length).trim()); return }
    if (data.startsWith('__CLDBG__')) { if (DEBUG) console.log('[Claude][debug]', data.slice('__CLDBG__'.length)); return }
    push(data)
  })

  let stallTimer: NodeJS.Timeout | null = null
  let hardTimer: NodeJS.Timeout | null = null
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => push(null), STALL_TIMEOUT_MS)
  }

  try {
    if (DEBUG) console.log(`[Claude] Starting request for account ${accountId}. promptLen=${prompt.length}`)
    await page.goto(CLAUDE_NEW_CHAT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
    if (!(await isLoggedIn(page))) {
      yield { type: 'error', message: 'Claude account is not logged in. Run `npm run claude:login` and complete the login.' }
      return
    }

    try {
      if (DEBUG) console.log('[Claude] Submitting prompt through claude.ai UI...')
      await submitPrompt(page, prompt)
      if (DEBUG) console.log('[Claude] Prompt submitted; installing DOM observer...')
      await page.evaluate(buildDomObserverScript(accountId, prompt, DEBUG))
    } catch (e: any) {
      yield { type: 'error', message: `Failed to drive Claude UI: ${e?.message}` }
      return
    }

    hardTimer = setTimeout(() => push(null), RESPONSE_TIMEOUT_MS)
    armStall()

    const state: ParseState = { lastCumulative: '' }
    let buffer = ''
    let emitted = ''
    let sawAny = false
    let sawNetwork = false
    let networkDone = false
    let domDone = false

    while (true) {
      const raw = await nextRaw()
      if (raw === null) break
      armStall()

      if (raw.startsWith('__CLCTRL__ERR')) {
        yield { type: 'error', message: `Claude stream error: ${raw.slice('__CLCTRL__ERR'.length)}` }
        break
      }

      if (DEBUG) console.log('[Claude][raw]', JSON.stringify(raw))

      if (raw.startsWith('__CLCTRL__NETSTART')) {
        sawNetwork = true
        networkDone = false
        if (DEBUG) console.log('[Claude][net]', raw.slice('__CLCTRL__NETSTART'.length).trim())
        continue
      }

      if (raw === '__CLCTRL__NETDONE') {
        networkDone = true
        const parsed = parseSseBuffer(buffer, state, true)
        buffer = parsed.buffer
        for (const event of parsed.events) {
          if (event.type !== 'content') {
            yield event
            continue
          }
          const result = dedupeAppend(emitted, event.text)
          emitted = result.emitted
          if (result.delta) {
            sawAny = true
            yield { type: 'content', text: result.delta }
          }
        }
        if (DEBUG) console.log('[Claude][net] done')
        break
      }

      if (raw === '__CLCTRL__DONE') {
        domDone = true
        if (!sawNetwork || networkDone) break
        if (DEBUG) console.log('[Claude][debug] DOM reported done; waiting for network stream to finish')
        continue
      }

      if (raw.startsWith('__CLDOM__')) {
        const result = dedupeAppend(emitted, raw.slice('__CLDOM__'.length))
        emitted = result.emitted
        if (result.delta) {
          sawAny = true
          yield { type: 'content', text: result.delta }
        }
        continue
      }

      if (raw.startsWith('__CLDOMCUM__')) {
        const result = dedupeAppend(emitted, raw.slice('__CLDOMCUM__'.length))
        emitted = result.emitted
        if (result.delta) {
          sawAny = true
          yield { type: 'content', text: result.delta }
        }
        continue
      }

      buffer += raw
      const parsed = parseSseBuffer(buffer, state)
      buffer = parsed.buffer
      for (const event of parsed.events) {
        if (event.type !== 'content') {
          yield event
          continue
        }

        const result = dedupeAppend(emitted, event.text)
        emitted = result.emitted
        if (result.delta) {
          sawAny = true
          yield { type: 'content', text: result.delta }
        }
      }
    }

    if (!sawAny) {
      yield { type: 'error', message: 'No response captured from Claude. Selectors or stream parsing may need live tuning; run with CLAUDE_DEBUG=1.' }
    }
  } finally {
    if (stallTimer) clearTimeout(stallTimer)
    if (hardTimer) clearTimeout(hardTimer)
    try { await page.evaluate('(() => { try { if (window.__clObserverStop) window.__clObserverStop(); } catch (e) {} })()') } catch {}
    unregisterSink(accountId)
    release()
  }
}
