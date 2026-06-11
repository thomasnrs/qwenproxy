/*
 * ChatGPT account manager CLI (manual login).
 *
 *   npm run chatgpt:login
 *
 * Opens a real browser at chatgpt.com. Log in by hand (you'll likely face a
 * Cloudflare check and OpenAI's login). Once a session is detected the account
 * is saved and the profile persists under chatgpt_profiles/<id>/.
 */

import { addChatGPTAccount, removeChatGPTAccount, listChatGPTAccounts } from './accounts.ts'
import { launchManualLogin, isLoggedIn, BrowserType } from './browser.ts'
import * as readline from 'readline'
import * as dotenv from 'dotenv'
import crypto from 'crypto'

dotenv.config()

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q: string): Promise<string> => new Promise(res => rl.question(q, a => res(a.trim())))
const clear = () => process.stdout.write('\x1Bc')

function browserType(): BrowserType {
  const arg = process.argv.find(a => a.startsWith('--browser='))
  if (arg) return arg.split('=')[1] as BrowserType
  if (process.env.BROWSER) return process.env.BROWSER as BrowserType
  return 'chromium'
}

async function manualLoginFlow(bt: BrowserType) {
  clear()
  console.log('=== Add ChatGPT Account (manual login) ===\n')
  console.log('A browser will open at chatgpt.com. Log in by hand.')
  console.log('(A Cloudflare check is likely — solve it. Then log into OpenAI.)\n')
  await ask('Press Enter to open the browser...')

  const accountId = crypto.randomUUID()
  const { context, page } = await launchManualLogin(accountId, bt)

  console.log('\nWaiting for login... (polls /api/auth/session until a user is found)')
  let ok = false
  for (let i = 0; i < 300 && !ok; i++) {
    await new Promise(r => setTimeout(r, 2000))
    ok = await isLoggedIn(page).catch(() => false)
  }
  if (!ok) {
    console.log('\nLogin not detected (timed out). Aborting.')
    await context.close().catch(() => {})
    await ask('Press Enter to continue...')
    return
  }

  console.log('\nLogin detected!')
  const email = await ask('Enter an email/label for this account: ')
  if (!email) {
    console.log('Email is required. Aborting (profile kept on disk).')
    await context.close().catch(() => {})
    await ask('Press Enter to continue...')
    return
  }
  try {
    const acc = addChatGPTAccount(email, '', accountId)
    console.log(`\nSaved: ${acc.email} (${acc.id})`)
  } catch (e: any) {
    console.log(`\nError: ${e.message}`)
  }
  await context.close().catch(() => {})
  await ask('Press Enter to continue...')
}

async function removeFlow() {
  const accounts = listChatGPTAccounts()
  if (accounts.length === 0) return
  clear()
  console.log('=== Remove ChatGPT Account ===\n')
  accounts.forEach((a, i) => console.log(`  [${i + 1}] ${a.email} (${a.id})`))
  const input = await ask('\nNumber to remove (0 to cancel): ')
  const idx = parseInt(input, 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= accounts.length) { console.log('Cancelled.'); await ask('Enter...'); return }
  removeChatGPTAccount(accounts[idx].id)
  console.log('Removed.')
  await ask('Press Enter to continue...')
}

async function menu() {
  const bt = browserType()
  while (true) {
    const accounts = listChatGPTAccounts()
    clear()
    console.log('=== ChatGPT Account Manager ===\n')
    if (accounts.length) {
      console.log(`Accounts (${accounts.length}):\n`)
      accounts.forEach((a, i) => console.log(`  [${i + 1}] ${a.email} (${a.id})`))
    } else {
      console.log('No ChatGPT accounts yet.\n')
    }
    console.log('\nOptions:')
    console.log('  [M] Add account (manual browser login)')
    if (accounts.length) console.log('  [R] Remove an account')
    console.log('  [Q] Quit\n')

    const choice = (await ask('Select: ')).toUpperCase()
    if (choice === 'Q') { rl.close(); process.exit(0) }
    if (choice === 'M') { await manualLoginFlow(bt); continue }
    if (choice === 'R' && accounts.length) { await removeFlow(); continue }
  }
}

menu().catch(err => { console.error(err); process.exit(1) })
