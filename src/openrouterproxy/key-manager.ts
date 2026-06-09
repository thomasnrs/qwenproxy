/*
 * OpenRouter proxy — key rotation + cooldown.
 *
 * Round-robin selection across the configured keys, skipping any key currently
 * on cooldown. When a key hits a rate limit (429), runs out of credits (402),
 * or is rejected (401/403), the router marks it here so it is skipped until the
 * cooldown expires. Cooldowns are in-memory only (lost on restart) by design.
 */

import { OpenRouterKey, loadKeys } from './keys.ts'

let currentIndex = 0

interface CooldownEntry {
  until: number
  reason: string
}

const cooldowns = new Map<string, CooldownEntry>()

const DEFAULT_COOLDOWN_MS = 60 * 1000 // 1 minute fallback

export function markKeyRateLimited(keyId: string, cooldownMs?: number, reason = 'RateLimited'): void {
  const until = Date.now() + (cooldownMs ?? DEFAULT_COOLDOWN_MS)
  cooldowns.set(keyId, { until, reason })
  console.log(`[OpenRouter] Key ${keyId} marked ${reason}. Cooldown until ${new Date(until).toISOString()}`)
}

export function clearKeyCooldown(keyId: string): void {
  cooldowns.delete(keyId)
}

export function getKeyCooldownInfo(keyId: string): { remainingMs: number; reason: string } | null {
  const entry = cooldowns.get(keyId)
  if (!entry) return null
  const remaining = entry.until - Date.now()
  if (remaining <= 0) {
    cooldowns.delete(keyId)
    return null
  }
  return { remainingMs: remaining, reason: entry.reason }
}

function isOnCooldown(keyId: string): boolean {
  return getKeyCooldownInfo(keyId) !== null
}

/** Next available key in round-robin order, or null if all are on cooldown. */
export function getNextKey(): OpenRouterKey | null {
  const keys = loadKeys()
  if (keys.length === 0) return null

  for (let i = 0; i < keys.length; i++) {
    const key = keys[currentIndex % keys.length]
    currentIndex = (currentIndex + 1) % keys.length
    if (!isOnCooldown(key.id)) return key
  }
  return null
}

/** Next available key excluding skipId, or null if none are available. */
export function getNextAvailableKey(skipId?: string): OpenRouterKey | null {
  const keys = loadKeys()
  if (keys.length === 0) return null

  for (let i = 0; i < keys.length; i++) {
    const idx = (currentIndex + i) % keys.length
    const key = keys[idx]
    if (skipId && key.id === skipId) continue
    if (!isOnCooldown(key.id)) {
      currentIndex = (idx + 1) % keys.length
      return key
    }
  }
  return null
}

export function getCooldownStatus(): Record<string, { remainingMs: number; reason: string }> {
  const result: Record<string, { remainingMs: number; reason: string }> = {}
  for (const [id, entry] of cooldowns.entries()) {
    const remaining = entry.until - Date.now()
    if (remaining > 0) {
      result[id] = { remainingMs: remaining, reason: entry.reason }
    }
  }
  return result
}
