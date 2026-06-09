/*
 * OpenRouter proxy — HTTP routes.
 *
 * An OpenAI-compatible passthrough to https://openrouter.ai with multi-key
 * rotation. Mounted under /openrouter on the main server, so the public paths
 * are:
 *   GET  /openrouter/v1/models
 *   POST /openrouter/v1/chat/completions   (stream + non-stream)
 *   GET  /openrouter/v1/keys               (key/cooldown status, masked)
 *
 * Because OpenRouter is already OpenAI-compatible, the request body and the
 * (possibly streamed) response body are forwarded byte-for-byte. The only logic
 * we add is picking a non-cooled key and, on 429/402/401/403, putting that key
 * on cooldown and retrying the next one.
 */

import { Hono } from 'hono'
import { loadKeys, OpenRouterKey } from './keys.ts'
import {
  getNextKey,
  getNextAvailableKey,
  markKeyRateLimited,
  getCooldownStatus,
} from './key-manager.ts'

const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'
const REQUEST_TIMEOUT_MS = 120000

const app = new Hono()

// Optional auth — reuses the same proxy API key as the Qwen side. If API_KEY is
// unset, the proxy is open (same behaviour as the rest of the server).
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

/**
 * Derive a cooldown duration from rate-limit response headers. OpenRouter sends
 * X-RateLimit-Reset as a unix timestamp in milliseconds; some responses use the
 * standard Retry-After (seconds). Falls back to undefined (caller's default).
 */
function cooldownFromHeaders(res: Response): number | undefined {
  const reset = res.headers.get('x-ratelimit-reset')
  if (reset) {
    const resetMs = Number(reset)
    if (Number.isFinite(resetMs)) {
      const diff = resetMs - Date.now()
      if (diff > 0 && diff < 7 * 24 * 3600 * 1000) return diff
    }
  }
  const retryAfter = res.headers.get('retry-after')
  if (retryAfter) {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs) && secs > 0) return secs * 1000
  }
  return undefined
}

function authHeaders(key: OpenRouterKey): Record<string, string> {
  return { Authorization: `Bearer ${key.apiKey}`, ...rankingHeaders() }
}

app.get('/v1/models', async (c) => {
  const key = getNextKey() || loadKeys()[0]
  const res = await fetch(`${OPENROUTER_BASE}/models`, {
    headers: key ? { Authorization: `Bearer ${key.apiKey}` } : {},
  })
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' },
  })
})

app.post('/v1/chat/completions', async (c) => {
  const keys = loadKeys()
  if (keys.length === 0) {
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
  let key = getNextKey()
  let lastError: { status: number; body: string } | null = null

  while (key) {
    if (tried.has(key.id)) {
      key = getNextAvailableKey(key.id)
      continue
    }
    tried.add(key.id)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    let res: Response
    try {
      res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(key) },
        body: bodyText,
        signal: controller.signal,
      })
    } catch (err: any) {
      clearTimeout(timeout)
      console.warn(`[OpenRouter] Key ${key.id} fetch failed: ${err?.message}. Trying next key.`)
      lastError = { status: 502, body: JSON.stringify({ error: { message: `OpenRouter request failed: ${err?.message}` } }) }
      key = getNextAvailableKey(key.id)
      continue
    }
    // Headers are in — stop the connection timeout so it never aborts a long stream.
    clearTimeout(timeout)

    // Key-specific failures: cool this key down and rotate to the next one.
    if (res.status === 429 || res.status === 402 || res.status === 401 || res.status === 403) {
      const errBody = await res.text().catch(() => '')
      let cooldownMs = cooldownFromHeaders(res)
      let reason = 'RateLimited'
      if (res.status === 402) {
        cooldownMs = cooldownMs ?? 60 * 60 * 1000 // out of credits — back off an hour
        reason = 'NoCredits'
      } else if (res.status === 401 || res.status === 403) {
        cooldownMs = cooldownMs ?? 24 * 60 * 60 * 1000 // bad key — back off a day
        reason = 'InvalidKey'
      }
      markKeyRateLimited(key.id, cooldownMs, reason)
      console.warn(`[OpenRouter] Key ${key.id} ${reason} (HTTP ${res.status}). Trying next key.`)
      lastError = { status: res.status, body: errBody || JSON.stringify({ error: { message: reason } }) }
      key = getNextAvailableKey(key.id)
      continue
    }

    // Transient upstream errors: try another key, but remember the last response.
    if (res.status >= 500) {
      const errBody = await res.text().catch(() => '')
      console.warn(`[OpenRouter] Key ${key.id} upstream error HTTP ${res.status}. Trying next key.`)
      lastError = { status: res.status, body: errBody }
      key = getNextAvailableKey(key.id)
      continue
    }

    // Success (2xx) or a client error that is the caller's fault (e.g. 400 bad
    // model) — pass the response straight through without burning other keys.
    console.log(`[OpenRouter] Routed request to key ${key.id} (HTTP ${res.status}${isStream ? ', stream' : ''}).`)
    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') || (isStream ? 'text/event-stream' : 'application/json'),
        'Cache-Control': 'no-cache',
      },
    })
  }

  // Every key was tried and none worked.
  const cooldowns = getCooldownStatus()
  const soonestMs = Object.values(cooldowns).reduce((min, v) => Math.min(min, v.remainingMs), Infinity)
  const waitHint = Number.isFinite(soonestMs) ? ` Next key available in ~${Math.ceil(soonestMs / 1000)}s.` : ''
  const status = lastError?.status || 429
  const body =
    lastError?.body ||
    JSON.stringify({ error: { message: `All OpenRouter keys are currently rate-limited.${waitHint}` } })
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } })
})

// Masked key + cooldown status, for quick debugging.
app.get('/v1/keys', (c) => {
  const keys = loadKeys()
  const cd = getCooldownStatus()
  return c.json({
    object: 'list',
    data: keys.map(k => ({
      id: k.id,
      label: k.label,
      cooldown: cd[k.id]
        ? { remainingSec: Math.ceil(cd[k.id].remainingMs / 1000), reason: cd[k.id].reason }
        : null,
    })),
  })
})

export { app as openRouterApp }
