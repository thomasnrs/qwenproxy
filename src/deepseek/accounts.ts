/*
 * DeepSeek proxy — account storage (separate from the Qwen accounts).
 *
 * DeepSeek accounts live in their own `deepseek_accounts` table. Sessions are
 * kept as persistent browser profiles under deepseek_profiles/<id>/, so the
 * stored password is only needed for the initial (manual) login.
 */

import crypto from 'crypto'
import { getDatabase } from '../core/database.ts'

export interface DeepSeekAccount {
  id: string
  email: string
  password: string
}

export function loadDeepSeekAccounts(): DeepSeekAccount[] {
  const db = getDatabase()
  return db.prepare('SELECT id, email, password FROM deepseek_accounts ORDER BY created_at ASC').all() as DeepSeekAccount[]
}

export function addDeepSeekAccount(email: string, password = '', id?: string): DeepSeekAccount {
  if (!email || typeof email !== 'string' || email.trim().length === 0) {
    throw new Error('Email is required')
  }
  const db = getDatabase()
  const existing = db.prepare('SELECT id FROM deepseek_accounts WHERE email = ?').get(email.trim())
  if (existing) throw new Error(`DeepSeek account with email ${email} already exists`)

  const account: DeepSeekAccount = { id: id || crypto.randomUUID(), email: email.trim(), password }
  db.prepare('INSERT INTO deepseek_accounts (id, email, password) VALUES (?, ?, ?)').run(account.id, account.email, account.password)
  return account
}

export function removeDeepSeekAccount(id: string): boolean {
  const db = getDatabase()
  return db.prepare('DELETE FROM deepseek_accounts WHERE id = ?').run(id).changes > 0
}

export function listDeepSeekAccounts(): DeepSeekAccount[] {
  return loadDeepSeekAccounts().map(a => ({ id: a.id, email: a.email, password: a.password ? '***' : '' }))
}

export function getDeepSeekAccount(id: string): DeepSeekAccount | undefined {
  const db = getDatabase()
  return db.prepare('SELECT id, email, password FROM deepseek_accounts WHERE id = ?').get(id) as DeepSeekAccount | undefined
}
