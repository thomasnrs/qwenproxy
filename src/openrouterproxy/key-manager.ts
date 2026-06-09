/*
 * OpenRouter proxy — per-key RPS scheduler (proactive throttle) + manual disable.
 *
 * OpenRouter's rate limit is not a fixed per-key cooldown — it's per model and,
 * crucially, a requests-per-second ceiling. So instead of reacting to 429s with
 * an automatic cooldown, this manages OpenRouter "full manual": each key has a
 * configurable RPS, and the router proactively reserves the next free slot on a
 * key (queuing/waiting when needed) to stay under that rate. Keys can also be
 * manually disabled. All state is in-memory (env provides the boot default).
 */

import { OpenRouterKey, loadKeys } from './keys.ts'

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const DEFAULT_RPS = envNumber('OPENROUTER_RPS', 1) // requests per second per key
const MAX_QUEUE_WAIT_MS = envNumber('OPENROUTER_MAX_WAIT_MS', 30000)

export const MAX_WAIT_MS = MAX_QUEUE_WAIT_MS

// nextFreeAt[key] = earliest timestamp the key may fire its next request.
// Reserving a slot advances it by (1000 / rps), enforcing the per-key rate.
const nextFreeAt = new Map<string, number>()
const keyRps = new Map<string, number>()
const disabledKeys = new Set<string>()

export function getRps(keyId: string): number {
  return keyRps.get(keyId) ?? DEFAULT_RPS
}

export function setRps(keyId: string, rps: number): boolean {
  if (!(rps > 0)) return false
  keyRps.set(keyId, rps)
  return true
}

export function setRpsAll(rps: number): boolean {
  if (!(rps > 0)) return false
  for (const k of loadKeys()) keyRps.set(k.id, rps)
  return true
}

export function disableKey(keyId: string): void { disabledKeys.add(keyId) }
export function enableKey(keyId: string): void { disabledKeys.delete(keyId) }
export function isDisabled(keyId: string): boolean { return disabledKeys.has(keyId) }

export function resolveKey(query: string): OpenRouterKey | undefined {
  const keys = loadKeys()
  const q = (query || '').trim()
  if (/^\d+$/.test(q)) {
    const idx = parseInt(q, 10) - 1
    if (idx >= 0 && idx < keys.length) return keys[idx]
  }
  const ql = q.toLowerCase()
  return keys.find(k => k.id.toLowerCase() === ql)
}

export interface Reservation { key: OpenRouterKey; waitMs: number }

/**
 * Reserve the soonest available RPS slot across enabled keys (excluding any in
 * `exclude`). Returns the chosen key and how long the caller must wait before
 * firing. Returns null when no key is available. The slot is reserved
 * synchronously so concurrent callers never grab the same instant.
 */
export function reserveSlot(exclude?: Set<string>): Reservation | null {
  const keys = loadKeys().filter(k => !disabledKeys.has(k.id) && !(exclude && exclude.has(k.id)))
  if (keys.length === 0) return null

  const now = Date.now()
  let best: OpenRouterKey | null = null
  let bestSlot = Infinity
  for (const k of keys) {
    const slot = Math.max(now, nextFreeAt.get(k.id) ?? 0)
    if (slot < bestSlot) {
      bestSlot = slot
      best = k
    }
  }
  if (!best) return null

  const interval = 1000 / getRps(best.id)
  nextFreeAt.set(best.id, bestSlot + interval)
  return { key: best, waitMs: bestSlot - now }
}

export interface KeyStatus {
  index: number
  id: string
  label: string
  rps: number
  disabled: boolean
  nextSlotMs: number
}

export function getKeyStatuses(): KeyStatus[] {
  const now = Date.now()
  return loadKeys().map((k, i) => ({
    index: i + 1,
    id: k.id,
    label: k.label,
    rps: getRps(k.id),
    disabled: disabledKeys.has(k.id),
    nextSlotMs: Math.max(0, (nextFreeAt.get(k.id) ?? 0) - now),
  }))
}
