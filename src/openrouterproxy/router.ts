/*
 * OpenRouter proxy — HTTP routes.
 *
 * An OpenAI-compatible passthrough to https://openrouter.ai with per-key RPS
 * throttling. Mounted under /openrouter:
 *   GET  /openrouter/v1/models
 *   POST /openrouter/v1/chat/completions   (stream + non-stream)
 *   GET  /openrouter/v1/keys               (key/RPS status)
 *
 * Rate limiting is "full manual": there is NO automatic cooldown. Each request
 * reserves the soonest free RPS slot on a key (waiting/queuing if needed) so the
 * proxy stays under the configured requests-per-second. On a key-level failure
 * the request fails over to the next key, but the key is never auto-benched —
 * tune RPS or disable a key via the admin console.
 */

import { Hono } from 'hono'
import { config } from '../core/config.ts'
import { loadKeys } from './keys.ts'
import { reserveSlot, MAX_WAIT_MS, getKeyStatuses, isDisabled } from './key-manager.ts'

const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'
const REQUEST_TIMEOUT_MS = 120000

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const app = new Hono()

// Optional auth — same proxy API key as the rest of the server.
app.use('*', async (c, next) => {
  const apiKey = process.env.API_KEY
  if (apiKey) {
    const auth = c.req.header('Authorization')
    if (!auth?.startsWith('Bearer ') || auth.slice(7) !== apiKey) {
      return c.json({ error: { message: 'Missing or invalid Authorization header' } }, 401)
    }
  }
  await next()
})

function rankingHeaders(): Record<string, string> {
  const h: Record<string, string> = {}
  if (process.env.OPENROUTER_REFERER) h['HTTP-Referer'] = process.env.OPENROUTER_REFERER
  if (process.env.OPENROUTER_TITLE) h['X-Title'] = process.env.OPENROUTER_TITLE
  return h
}

// Statuses that mean "this key didn't serve the request" — fail over to another
// key, but never auto-cooldown (full manual mode).
const FAILOVER_STATUSES = new Set([401, 402, 403, 408, 429])

app.get('/v1/models', async (c) => {
  const key = loadKeys().find(k => !isDisabled(k.id)) || loadKeys()[0]
  const res = await fetch(`${OPENROUTER_BASE}/models`, {
    headers: key ? { Authorization: `Bearer ${key.apiKey}` } : {},
  })
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' },
  })
})

app.post('/v1/chat/completions', async (c) => {
  if (loadKeys().length === 0) {
    return c.json(
      { error: { message: 'No OpenRouter keys configured. Set OPENROUTER_KEYS in your .env (comma-separated).' } },
      503,
    )
  }

  // Forward the body verbatim — OpenRouter speaks the same OpenAI dialect.
  const bodyText = await c.req.text()
  let isStream = false
  try {
    isStream = !!JSON.parse(bodyText)?.stream
  } catch {
    return c.json({ error: { message: 'Invalid JSON body' } }, 400)
  }

  const tried = new Set<string>()
  let lastError: { status: number; body: string } | null = null

  while (true) {
    const reservation = reserveSlot(tried)
    if (!reservation) break // every (enabled) key has been tried
    const { key, waitMs } = reservation
    tried.add(key.id)

    if (waitMs > MAX_WAIT_MS) {
      // All keys saturated for longer than we're willing to queue.
      lastError = {
        status: 429,
        body: JSON.stringify({ error: { message: `Throttled locally: all keys at their RPS limit. Next slot in ~${Math.ceil(waitMs / 1000)}s. Raise OPENROUTER_RPS or add keys.` } }),
      }
      break
    }

    // Proactive throttle: wait for this key's reserved slot before firing.
    if (waitMs > 0) await sleep(waitMs)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.apiKey}`, ...rankingHeaders() },
        body: bodyText,
        signal: controller.signal,
      })
    } catch (err: any) {
      clearTimeout(timeout)
      console.warn(`[OpenRouter] Key ${key.id} fetch failed: ${err?.message}. Trying next key.`)
      lastError = { status: 502, body: JSON.stringify({ error: { message: `OpenRouter request failed: ${err?.message}` } }) }
      continue
    }
    clearTimeout(timeout)

    // Key-level failure or transient upstream error: fail over (NO cooldown).
    if (FAILOVER_STATUSES.has(res.status) || res.status >= 500) {
      const errBody = await res.text().catch(() => '')
      console.warn(`[OpenRouter] Key ${key.id} HTTP ${res.status}. Trying next key (manual mode — no auto-cooldown).`)
      lastError = { status: res.status, body: errBody }
      continue
    }

    // Success, or a client error that is the caller's fault (e.g. 400 bad model)
    // — pass straight through.
    console.log(`[OpenRouter] Routed request to key ${key.id} (HTTP ${res.status}${isStream ? ', stream' : ''}, waited ${Math.round(waitMs)}ms).`)
    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') || (isStream ? 'text/event-stream' : 'application/json'),
        'Cache-Control': 'no-cache',
      },
    })
  }

  const status = lastError?.status || 429
  const body = lastError?.body || JSON.stringify({ error: { message: 'No OpenRouter keys available.' } })
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } })
})

// Key + RPS status (for debugging / the admin console).
app.get('/v1/keys', (c) => {
  return c.json({
    object: 'list',
    data: getKeyStatuses().map(s => ({
      id: s.id,
      label: s.label,
      rps: s.rps,
      disabled: s.disabled,
      next_slot_ms: s.nextSlotMs,
    })),
  })
})

export { app as openRouterApp }
