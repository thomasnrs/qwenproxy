/*
 * ChatGPT proxy — account storage (separate from Qwen/DeepSeek).
 *
 * Accounts live in `chatgpt_accounts`. Sessions are kept as persistent browser
 * profiles under chatgpt_profiles/<id>/, so the stored password is only used for
 * the initial (manual) login.
 */

import crypto from 'crypto'
import { getDatabase } from '../core/database.ts'

export interface ChatGPTAccount {
  id: string
  email: string
  password: string
}

export function loadChatGPTAccounts(): ChatGPTAccount[] {
  const db = getDatabase()
  return db.prepare('SELECT id, email, password FROM chatgpt_accounts ORDER BY created_at ASC').all() as ChatGPTAccount[]
}

export function addChatGPTAccount(email: string, password = '', id?: string): ChatGPTAccount {
  if (!email || typeof email !== 'string' || email.trim().length === 0) {
    throw new Error('Email is required')
  }
  const db = getDatabase()
  const existing = db.prepare('SELECT id FROM chatgpt_accounts WHERE email = ?').get(email.trim())
  if (existing) throw new Error(`ChatGPT account with email ${email} already exists`)

  const account: ChatGPTAccount = { id: id || crypto.randomUUID(), email: email.trim(), password }
  db.prepare('INSERT INTO chatgpt_accounts (id, email, password) VALUES (?, ?, ?)').run(account.id, account.email, account.password)
  return account
}

export function removeChatGPTAccount(id: string): boolean {
  const db = getDatabase()
  return db.prepare('DELETE FROM chatgpt_accounts WHERE id = ?').run(id).changes > 0
}

export function listChatGPTAccounts(): ChatGPTAccount[] {
  return loadChatGPTAccounts().map(a => ({ id: a.id, email: a.email, password: a.password ? '***' : '' }))
}

export function getChatGPTAccount(id: string): ChatGPTAccount | undefined {
  const db = getDatabase()
  return db.prepare('SELECT id, email, password FROM chatgpt_accounts WHERE id = ?').get(id) as ChatGPTAccount | undefined
}
