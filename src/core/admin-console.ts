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
import {
  getKeyStatuses,
  resolveKey,
  setRps,
  setRpsAll,
  disableKey,
  enableKey,
} from '../openrouterproxy/key-manager.ts'

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
[Console] Comandos — Qwen (contas):
  list                         Lista as contas e o status (ativa / cooldown / desativada)
  disable <email|id|#> [horas] Desativa a conta. Sem "horas" = indefinido até reativar.
  enable  <email|id|#>         Reativa a conta (remove cooldown/desativação).

[Console] Comandos — OpenRouter (keys, prefixo "or"):
  or list                      Lista as keys: RPS, status e próximo slot
  or rps <key|#|all> <n>       Define o limite de requisições/segundo da key
  or disable <key|#>           Desativa uma key (não é mais usada)
  or enable  <key|#>           Reativa uma key
  help                         Mostra esta ajuda.
`)
}

function printOpenRouterKeys(): void {
  const statuses = getKeyStatuses()
  if (statuses.length === 0) {
    console.log('[Console] Nenhuma key OpenRouter (defina OPENROUTER_KEYS no .env).')
    return
  }
  console.log('\n  #   Key                  RPS    Status        Próx. slot')
  console.log('  --- -------------------- ------ ------------- ----------')
  for (const s of statuses) {
    const status = s.disabled ? 'DESATIVADA' : 'ativa'
    const slot = s.nextSlotMs > 0 ? `${Math.ceil(s.nextSlotMs)}ms` : 'livre'
    console.log(`  ${String(s.index).padEnd(3)} ${s.label.padEnd(20)} ${String(s.rps).padEnd(6)} ${status.padEnd(13)} ${slot}`)
  }
  console.log('')
}

function handleOpenRouter(parts: string[]): void {
  const sub = (parts[0] || '').toLowerCase()
  switch (sub) {
    case 'list':
    case 'ls':
      printOpenRouterKeys()
      break

    case 'rps': {
      const target = parts[1]
      const value = Number(parts[2])
      if (!target || !Number.isFinite(value) || value <= 0) {
        console.log('[Console] Uso: or rps <key|#|all> <requisições por segundo>')
        break
      }
      if (target.toLowerCase() === 'all') {
        setRpsAll(value)
        console.log(`[Console] RPS de TODAS as keys = ${value}/s.`)
      } else {
        const k = resolveKey(target)
        if (!k) { console.log(`[Console] Key não encontrada: "${target}"`); break }
        setRps(k.id, value)
        console.log(`[Console] RPS de ${k.id} (${k.label}) = ${value}/s.`)
      }
      break
    }

    case 'disable':
    case 'off': {
      const k = resolveKey(parts[1] || '')
      if (!k) { console.log(`[Console] Key não encontrada: "${parts[1] || ''}"`); break }
      disableKey(k.id)
      console.log(`[Console] Key ${k.id} (${k.label}) desativada.`)
      break
    }

    case 'enable':
    case 'on': {
      const k = resolveKey(parts[1] || '')
      if (!k) { console.log(`[Console] Key não encontrada: "${parts[1] || ''}"`); break }
      enableKey(k.id)
      console.log(`[Console] Key ${k.id} (${k.label}) reativada.`)
      break
    }

    case 'help':
    case '?':
      printHelp()
      break

    default:
      console.log(`[Console] Subcomando OpenRouter desconhecido: "${sub}". Digite "help".`)
  }
}

function handleCommand(input: string): void {
  const parts = input.split(/\s+/)
  const cmd = (parts[0] || '').toLowerCase()
  const target = parts[1]

  if (cmd === 'or' || cmd === 'openrouter') {
    handleOpenRouter(parts.slice(1))
    return
  }

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
  console.log('[Console] Admin ativo. "help" para os comandos (Qwen: disable/enable/list | OpenRouter: or rps/list/disable).')

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
