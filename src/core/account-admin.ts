/*
 * Manual account enable/disable helpers, shared by the login CLI and the
 * running server's admin console. "Disable" is implemented as a cooldown (the
 * same mechanism the rate-limit handling uses), so a disabled account is simply
 * skipped by the round-robin until re-enabled or the cooldown expires.
 *
 * Cooldowns are persisted to SQLite, so a change made from the CLI is picked up
 * by a running server via its periodic reloadCooldownsFromDb() sync, and an
 * in-process change (console) takes effect immediately.
 */

import { loadAccounts, QwenAccount } from './accounts.ts'
import { markAccountRateLimited, clearAccountCooldown, getAccountCooldownInfo } from './account-manager.ts'

// "Indefinite" disable = a cooldown so far out it never expires on its own.
const INDEFINITE_MS = 100 * 365 * 24 * 60 * 60 * 1000
const INDEFINITE_THRESHOLD_MS = 10 * 365 * 24 * 60 * 60 * 1000

export interface AccountStatus {
  index: number
  id: string
  email: string
  disabled: boolean
  reason?: string
  remainingMs?: number
  indefinite: boolean
}

/** Resolve an account by 1-based index, id, or email (case-insensitive). */
export function resolveAccount(idOrEmailOrIndex: string): QwenAccount | undefined {
  const accounts = loadAccounts()
  const q = idOrEmailOrIndex.trim()
  if (/^\d+$/.test(q)) {
    const idx = parseInt(q, 10) - 1
    if (idx >= 0 && idx < accounts.length) return accounts[idx]
  }
  const ql = q.toLowerCase()
  return accounts.find(a => a.id.toLowerCase() === ql || a.email.toLowerCase() === ql)
}

export function disableAccount(target: string, hours?: number): { ok: boolean; message: string } {
  const acc = resolveAccount(target)
  if (!acc) return { ok: false, message: `Conta não encontrada: "${target}"` }
  const ms = hours && hours > 0 ? hours * 60 * 60 * 1000 : INDEFINITE_MS
  markAccountRateLimited(acc.id, ms, 'ManualDisable')
  const how = hours && hours > 0 ? `por ${hours}h` : '(indefinido — use "enable" para reativar)'
  return { ok: true, message: `Conta ${acc.email} desativada ${how}.` }
}

export function enableAccount(target: string): { ok: boolean; message: string } {
  const acc = resolveAccount(target)
  if (!acc) return { ok: false, message: `Conta não encontrada: "${target}"` }
  const had = getAccountCooldownInfo(acc.id)
  clearAccountCooldown(acc.id)
  return {
    ok: true,
    message: had ? `Conta ${acc.email} reativada (cooldown removido).` : `Conta ${acc.email} já estava ativa.`,
  }
}

export function listAccountStatus(): AccountStatus[] {
  return loadAccounts().map((a, i) => {
    const cd = getAccountCooldownInfo(a.id)
    if (!cd) {
      return { index: i + 1, id: a.id, email: a.email, disabled: false, indefinite: false }
    }
    return {
      index: i + 1,
      id: a.id,
      email: a.email,
      disabled: true,
      reason: cd.reason,
      remainingMs: cd.remainingMs,
      indefinite: cd.reason === 'ManualDisable' && cd.remainingMs > INDEFINITE_THRESHOLD_MS,
    }
  })
}

/** Human-friendly remaining-time label for a cooldown. */
export function formatRemaining(status: AccountStatus): string {
  if (!status.disabled) return 'ativa'
  if (status.indefinite) return 'DESATIVADA (manual)'
  const ms = status.remainingMs || 0
  const totalMin = Math.ceil(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  const time = h > 0 ? `${h}h${m.toString().padStart(2, '0')}m` : `${m}m`
  return `cooldown ${time} (${status.reason})`
}
