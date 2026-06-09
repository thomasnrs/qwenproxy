/*
 * OpenRouter proxy — key loading.
 *
 * Loads the rotating pool of OpenRouter API keys from the OPENROUTER_KEYS env
 * var (comma-separated). Fully self-contained: it shares nothing with the Qwen
 * account system. Keys live only in the environment; cooldowns live only in
 * memory (see key-manager.ts).
 */

export interface OpenRouterKey {
  id: string
  apiKey: string
  label: string // masked — safe to log / expose
}

function mask(key: string): string {
  if (key.length <= 12) return '***'
  return `${key.slice(0, 8)}…${key.slice(-4)}`
}

/**
 * Parses OPENROUTER_KEYS on every call (the list is tiny and env does not change
 * at runtime). Blank entries are ignored so trailing commas are harmless.
 */
export function loadKeys(): OpenRouterKey[] {
  const raw = process.env.OPENROUTER_KEYS || ''
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map((apiKey, i) => ({ id: `or-key-${i + 1}`, apiKey, label: mask(apiKey) }))
}

export function getKeyById(id: string): OpenRouterKey | undefined {
  return loadKeys().find(k => k.id === id)
}
