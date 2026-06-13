/*
 * Claude proxy - account storage.
 *
 * Accounts live in `claude_accounts`. Sessions are kept as persistent browser
 * profiles under claude_profiles/<id>/, so the password field is only retained
 * for symmetry with the other provider account tables.
 */

import crypto from 'crypto'
import { getDatabase } from '../core/database.ts'

export interface ClaudeAccount {
  id: string
  email: string
  password: string
}

export function loadClaudeAccounts(): ClaudeAccount[] {
  const db = getDatabase()
  return db.prepare('SELECT id, email, password FROM claude_accounts ORDER BY created_at ASC').all() as ClaudeAccount[]
}

export function addClaudeAccount(email: string, password = '', id?: string): ClaudeAccount {
  if (!email || typeof email !== 'string' || email.trim().length === 0) {
    throw new Error('Email is required')
  }

  const db = getDatabase()
  const existing = db.prepare('SELECT id FROM claude_accounts WHERE email = ?').get(email.trim())
  if (existing) throw new Error(`Claude account with email ${email} already exists`)

  const account: ClaudeAccount = { id: id || crypto.randomUUID(), email: email.trim(), password }
  db.prepare('INSERT INTO claude_accounts (id, email, password) VALUES (?, ?, ?)').run(account.id, account.email, account.password)
  return account
}

export function removeClaudeAccount(id: string): boolean {
  const db = getDatabase()
  return db.prepare('DELETE FROM claude_accounts WHERE id = ?').run(id).changes > 0
}

export function listClaudeAccounts(): ClaudeAccount[] {
  return loadClaudeAccounts().map(a => ({ id: a.id, email: a.email, password: a.password ? '***' : '' }))
}

export function getClaudeAccount(id: string): ClaudeAccount | undefined {
  const db = getDatabase()
  return db.prepare('SELECT id, email, password FROM claude_accounts WHERE id = ?').get(id) as ClaudeAccount | undefined
}
