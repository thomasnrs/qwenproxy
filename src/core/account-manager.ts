import { QwenAccount, loadAccounts } from './accounts.ts'
import { getDatabase } from './database.ts'

let currentIndex = 0

interface CooldownEntry {
  until: number
  reason: string
}

const cooldowns = new Map<string, CooldownEntry>()

const DEFAULT_COOLDOWN_MS = 3 * 60 * 1000 // 3 minutes

// Cooldowns are persisted to SQLite so they survive server restarts — a daily
// rate-limit ("Wait about 13 hour(s)") must be respected across reboots.
let cooldownsLoaded = false

function ensureCooldownsLoaded(): void {
  if (cooldownsLoaded) return
  cooldownsLoaded = true
  try {
    const db = getDatabase()
    const rows = db.prepare('SELECT account_id, until, reason FROM account_cooldowns').all() as Array<{ account_id: string; until: number; reason: string }>
    const now = Date.now()
    let active = 0
    for (const row of rows) {
      if (row.until > now) {
        cooldowns.set(row.account_id, { until: row.until, reason: row.reason })
        active++
      } else {
        db.prepare('DELETE FROM account_cooldowns WHERE account_id = ?').run(row.account_id)
      }
    }
    if (active > 0) {
      console.log(`[AccountManager] Restored ${active} persisted cooldown(s) from database.`)
    }
  } catch (err: any) {
    console.error('[AccountManager] Failed to load persisted cooldowns:', err?.message)
  }
}

/**
 * Rebuild the in-memory cooldown map from SQLite. The DB is the single source of
 * truth (every mutation writes through), so a full reload stays consistent and
 * lets out-of-process changes — e.g. disabling an account from the login CLI —
 * propagate to a running server. Called periodically by the server.
 */
export function reloadCooldownsFromDb(): void {
  try {
    const db = getDatabase()
    const rows = db.prepare('SELECT account_id, until, reason FROM account_cooldowns').all() as Array<{ account_id: string; until: number; reason: string }>
    const now = Date.now()
    cooldowns.clear()
    for (const row of rows) {
      if (row.until > now) {
        cooldowns.set(row.account_id, { until: row.until, reason: row.reason })
      } else {
        db.prepare('DELETE FROM account_cooldowns WHERE account_id = ?').run(row.account_id)
      }
    }
    cooldownsLoaded = true
  } catch (err: any) {
    console.error('[AccountManager] Failed to reload cooldowns:', err?.message)
  }
}

function persistCooldown(accountId: string, until: number, reason: string): void {
  try {
    getDatabase().prepare(
      `INSERT INTO account_cooldowns (account_id, until, reason) VALUES (?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET until = excluded.until, reason = excluded.reason`,
    ).run(accountId, until, reason)
  } catch (err: any) {
    console.error(`[AccountManager] Failed to persist cooldown for ${accountId}:`, err?.message)
  }
}

function removePersistedCooldown(accountId: string): void {
  try {
    getDatabase().prepare('DELETE FROM account_cooldowns WHERE account_id = ?').run(accountId)
  } catch {}
}

export function markAccountRateLimited(accountId: string, cooldownMs?: number, reason?: string): void {
  ensureCooldownsLoaded()
  const until = Date.now() + (cooldownMs ?? DEFAULT_COOLDOWN_MS)
  const finalReason = reason ?? 'RateLimited'
  cooldowns.set(accountId, { until, reason: finalReason })
  persistCooldown(accountId, until, finalReason)
  console.log(`[AccountManager] Account ${accountId} marked as ${finalReason}. Cooldown until ${new Date(until).toISOString()}`)
}

export function clearAccountCooldown(accountId: string): void {
  cooldowns.delete(accountId)
  removePersistedCooldown(accountId)
}

export function getAccountCooldownInfo(accountId: string): { onCooldown: boolean; remainingMs: number; reason: string } | null {
  ensureCooldownsLoaded()
  const entry = cooldowns.get(accountId)
  if (!entry) return null
  const remaining = entry.until - Date.now()
  if (remaining <= 0) {
    cooldowns.delete(accountId)
    removePersistedCooldown(accountId)
    return null
  }
  return { onCooldown: true, remainingMs: remaining, reason: entry.reason }
}

function isAccountOnCooldown(accountId: string): boolean {
  return getAccountCooldownInfo(accountId) !== null
}

export function getNextAccount(): QwenAccount | null {
  const accounts = loadAccounts()
  if (accounts.length === 0) {
    return null
  }

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[currentIndex % accounts.length]
    currentIndex = (currentIndex + 1) % accounts.length
    if (!isAccountOnCooldown(account.id)) {
      return account
    }
  }

  // All accounts on cooldown — return the one with the shortest remaining cooldown
  let best: QwenAccount | null = null
  let bestRemaining = Infinity
  for (const account of accounts) {
    const info = getAccountCooldownInfo(account.id)
    if (info && info.remainingMs < bestRemaining) {
      bestRemaining = info.remainingMs
      best = account
    }
  }
  return best
}

export function getNextAvailableAccount(skipAccountId?: string): QwenAccount | null {
  const accounts = loadAccounts()
  if (accounts.length === 0) return null

  for (let i = 0; i < accounts.length; i++) {
    const idx = (currentIndex + i) % accounts.length
    const account = accounts[idx]
    if (skipAccountId && account.id === skipAccountId) continue
    if (!isAccountOnCooldown(account.id)) {
      currentIndex = (idx + 1) % accounts.length
      return account
    }
  }

  // All remaining accounts on cooldown — return the one with shortest cooldown
  let best: QwenAccount | null = null
  let bestRemaining = Infinity
  for (const account of accounts) {
    if (skipAccountId && account.id === skipAccountId) continue
    const info = getAccountCooldownInfo(account.id)
    if (info && info.remainingMs < bestRemaining) {
      bestRemaining = info.remainingMs
      best = account
    }
  }
  return best
}

export function getAccountCount(): number {
  return loadAccounts().length
}

export function getCooldownStatus(): Record<string, { remainingMs: number; reason: string }> {
  ensureCooldownsLoaded()
  const result: Record<string, { remainingMs: number; reason: string }> = {}
  for (const [id, info] of cooldowns.entries()) {
    const remaining = info.until - Date.now()
    if (remaining > 0) {
      result[id] = { remainingMs: remaining, reason: info.reason }
    }
  }
  return result
}
