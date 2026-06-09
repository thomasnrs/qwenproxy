/*
 * Interactive admin console for the running server. Reads simple commands from
 * stdin so you can disable/enable accounts live when you notice a rate-limit the
 * automatic detection missed. Changes take effect immediately (in-process) and
 * are persisted to SQLite.
 *
 * Only attaches when stdin is an interactive TTY, so it never interferes with
 * non-interactive runs (Docker, pipes, cron).
 */

import * as readline from 'readline'
import { disableAccount, enableAccount, listAccountStatus, formatRemaining } from './account-admin.ts'

let rl: readline.Interface | null = null

function printAccounts(): void {
  const accounts = listAccountStatus()
  if (accounts.length === 0) {
    console.log('[Console] Nenhuma conta configurada.')
    return
  }
  console.log('\n  #   Conta                                  Status')
  console.log('  --- -------------------------------------- ------------------------')
  for (const a of accounts) {
    console.log(`  ${String(a.index).padEnd(3)} ${a.email.padEnd(38)} ${formatRemaining(a)}`)
  }
  console.log('')
}

function printHelp(): void {
  console.log(`
[Console] Comandos:
  list                         Lista as contas e o status (ativa / cooldown / desativada)
  disable <email|id|#> [horas] Desativa a conta. Sem "horas" = indefinido até reativar.
  enable  <email|id|#>         Reativa a conta (remove cooldown/desativação).
  help                         Mostra esta ajuda.
`)
}

function handleCommand(input: string): void {
  const parts = input.split(/\s+/)
  const cmd = (parts[0] || '').toLowerCase()
  const target = parts[1]

  switch (cmd) {
    case 'list':
    case 'ls':
    case 'accounts':
      printAccounts()
      break

    case 'disable':
    case 'off': {
      if (!target) { console.log('[Console] Uso: disable <email|id|#> [horas]'); break }
      const hoursRaw = parts[2]
      const hours = hoursRaw !== undefined ? Number(hoursRaw) : undefined
      if (hoursRaw !== undefined && !Number.isFinite(hours)) { console.log('[Console] Horas inválidas.'); break }
      const r = disableAccount(target, hours)
      console.log(`[Console] ${r.message}`)
      break
    }

    case 'enable':
    case 'on': {
      if (!target) { console.log('[Console] Uso: enable <email|id|#>'); break }
      const r = enableAccount(target)
      console.log(`[Console] ${r.message}`)
      break
    }

    case 'help':
    case '?':
      printHelp()
      break

    default:
      console.log(`[Console] Comando desconhecido: "${cmd}". Digite "help".`)
  }
}

export function startAdminConsole(): void {
  if (rl) return
  if (!process.stdin.isTTY) return // non-interactive (Docker/pipe) — do not capture stdin

  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })
  console.log('[Console] Admin ativo. Digite "help" para os comandos (disable/enable/list).')

  rl.on('line', (line) => {
    const input = line.trim()
    if (input) {
      try {
        handleCommand(input)
      } catch (err: any) {
        console.error('[Console] Erro ao processar comando:', err?.message)
      }
    }
  })
}

export function stopAdminConsole(): void {
  if (rl) {
    rl.close()
    rl = null
  }
}
