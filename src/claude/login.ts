/*
 * Claude account manager CLI (manual login).
 */

import { addClaudeAccount, removeClaudeAccount, listClaudeAccounts } from './accounts.ts'
import { launchManualLogin, isLoggedIn, BrowserType } from './browser.ts'
import * as readline from 'readline'
import * as dotenv from 'dotenv'
import crypto from 'crypto'

dotenv.config()

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q: string): Promise<string> => new Promise(resolve => rl.question(q, answer => resolve(answer.trim())))
const clear = () => process.stdout.write('\x1Bc')

function browserType(): BrowserType {
  const arg = process.argv.find(value => value.startsWith('--browser='))
  if (arg) return arg.split('=')[1] as BrowserType
  if (process.env.BROWSER) return process.env.BROWSER as BrowserType
  return 'chromium'
}

async function manualLoginFlow(browser: BrowserType) {
  clear()
  console.log('=== Add Claude Account (manual login) ===\n')
  console.log('A browser will open at claude.ai. Log in by hand.')
  console.log('When the chat is available, come back here.\n')
  await ask('Press Enter to open the browser...')

  const accountId = crypto.randomUUID()
  const { context, page } = await launchManualLogin(accountId, browser)

  console.log('\nWaiting for login... (this polls until a Claude session is detected)')
  let ok = false
  for (let i = 0; i < 300 && !ok; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000))
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
    const account = addClaudeAccount(email, '', accountId)
    console.log(`\nSaved: ${account.email} (${account.id})`)
  } catch (e: any) {
    console.log(`\nError: ${e.message}`)
  }

  await context.close().catch(() => {})
  await ask('Press Enter to continue...')
}

async function removeFlow() {
  const accounts = listClaudeAccounts()
  if (accounts.length === 0) return

  clear()
  console.log('=== Remove Claude Account ===\n')
  accounts.forEach((account, index) => console.log(`  [${index + 1}] ${account.email} (${account.id})`))
  const input = await ask('\nNumber to remove (0 to cancel): ')
  const index = parseInt(input, 10) - 1
  if (isNaN(index) || index < 0 || index >= accounts.length) {
    console.log('Cancelled.')
    await ask('Enter...')
    return
  }

  removeClaudeAccount(accounts[index].id)
  console.log('Removed.')
  await ask('Press Enter to continue...')
}

async function menu() {
  const browser = browserType()
  while (true) {
    const accounts = listClaudeAccounts()
    clear()
    console.log('=== Claude Account Manager ===\n')
    if (accounts.length) {
      console.log(`Accounts (${accounts.length}):\n`)
      accounts.forEach((account, index) => console.log(`  [${index + 1}] ${account.email} (${account.id})`))
    } else {
      console.log('No Claude accounts yet.\n')
    }

    console.log('\nOptions:')
    console.log('  [M] Add account (manual browser login)')
    if (accounts.length) console.log('  [R] Remove an account')
    console.log('  [Q] Quit\n')

    const choice = (await ask('Select: ')).toUpperCase()
    if (choice === 'Q') {
      rl.close()
      process.exit(0)
    }
    if (choice === 'M') {
      await manualLoginFlow(browser)
      continue
    }
    if (choice === 'R' && accounts.length) {
      await removeFlow()
    }
  }
}

menu().catch(error => {
  console.error(error)
  process.exit(1)
})
