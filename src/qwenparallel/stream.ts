/*
 * Qwen parallel proxy — stream creation.
 *
 * Posts directly to the Qwen chat API using the cached headers extracted by the
 * Playwright layer (cookie + bx-* anti-bot tokens). The crucial difference from
 * the main service is `chat_id: null`: every request opens a FRESH Qwen
 * conversation, so concurrent requests on the same account never collide with
 * "chat is in progress". Combined with the absence of a per-account mutex in the
 * router, this lets one account serve many parallel streams.
 *
 * The full conversation history is always re-sent in the prompt (the proxy is
 * stateless), so dropping server-side session continuity loses nothing.
 */

import { getQwenHeaders } from '../services/playwright.ts'
import { v4 as uuidv4 } from 'uuid'

const QWEN_BASE = process.env.QWEN_BASE_URL || 'https://chat.qwen.ai'
const REQUEST_TIMEOUT_MS = 120000

export class QwenParallelError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly retryHours?: number,
  ) {
    super(message)
    this.name = 'QwenParallelError'
  }
}

/** Parse a non-SSE Qwen error body (e.g. the daily rate-limit payload). */
export function parseQwenError(raw: string): { message: string; status: number; code: string; retryHours?: number } | null {
  const text = (raw || '').trim()
  if (!text || text.startsWith('data: ')) return null
  try {
    const payload = JSON.parse(text)
    if (payload && payload.success === false) {
      const code = payload.data?.code || payload.code || 'UpstreamError'
      const details = payload.data?.details || payload.message || 'Qwen returned an error'
      const retryHours = typeof payload.data?.num === 'number' ? payload.data.num : undefined
      const wait = retryHours !== undefined ? ` Wait about ${retryHours} hour(s) before trying again.` : ''
      const status = code === 'RateLimited' ? 429 : code === 'Not_Found' ? 404 : 502
      return { message: `Qwen upstream error: ${code}: ${details}.${wait}`, status, code, retryHours }
    }
  } catch {
    // not JSON — let the caller fall back to a generic error
  }
  return null
}

/**
 * Create a brand-new Qwen conversation and return its chat_id. Qwen requires a
 * valid chat_id (both as the ?chat_id= query param and in the body) — it rejects
 * null with a RequestValidationError. Giving each parallel request its own fresh
 * chat is what lets one account run many streams without "chat is in progress".
 */
async function createNewChat(headers: Record<string, string>, model: string): Promise<string> {
  const res = await fetch(`${QWEN_BASE}/api/v2/chats/new`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      cookie: headers['cookie'],
      origin: QWEN_BASE,
      referer: `${QWEN_BASE}/`,
      source: 'web',
      'user-agent': headers['user-agent'],
      'x-request-id': uuidv4(),
      'bx-ua': headers['bx-ua'],
      'bx-umidtoken': headers['bx-umidtoken'],
      'bx-v': headers['bx-v'],
    },
    body: JSON.stringify({
      title: 'New Chat',
      models: [model],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: Date.now(),
    }),
  })

  const text = await res.text()
  if (!res.ok) {
    const parsed = parseQwenError(text)
    if (parsed) throw new QwenParallelError(parsed.message, parsed.code, parsed.status, parsed.retryHours)
    const status = res.status >= 500 ? res.status : 502
    throw new QwenParallelError(`Failed to create Qwen chat: ${res.status} ${text.slice(0, 200)}`, 'UpstreamError', status)
  }

  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new QwenParallelError(`Qwen chats/new returned non-JSON: ${text.slice(0, 200)}`, 'UpstreamError', 502)
  }

  const chatId = json?.data?.id || json?.data?.chat_id || json?.id
  if (!chatId || typeof chatId !== 'string') {
    // Surface the raw shape so the request contract can be corrected if Qwen changes it.
    console.error('[QwenParallel] Unexpected chats/new response:', text.slice(0, 400))
    throw new QwenParallelError(`Qwen chats/new returned no chat id: ${text.slice(0, 300)}`, 'UpstreamError', 502)
  }
  return chatId
}

export async function createParallelStream(
  finalPrompt: string,
  enableThinking: boolean,
  modelId: string,
  accountId: string,
): Promise<{ stream: ReadableStream; controller: AbortController }> {
  // Cached headers — concurrent-safe: getQwenHeaders returns the cached value
  // without taking the UI mutex once a fresh extraction exists.
  const { headers } = await getQwenHeaders(false, accountId)

  const model = modelId.replace('-no-thinking', '')
  // A fresh conversation per request — the key to parallel streams per account.
  const chatId = await createNewChat(headers, model)
  const timestamp = Math.floor(Date.now() / 1000)
  const fid = uuidv4()

  const payload = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId,
    chat_mode: 'normal',
    model,
    parent_id: null,
    messages: [
      {
        fid,
        parentId: null,
        childrenIds: [],
        role: 'user',
        content: finalPrompt,
        user_action: 'chat',
        files: [],
        timestamp,
        models: [model],
        chat_type: 't2t',
        feature_config: {
          thinking_enabled: enableThinking,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: false,
          thinking_mode: 'Thinking',
          thinking_format: 'summary',
          auto_search: false,
        },
        extra: { meta: { subChatType: 't2t' } },
        sub_chat_type: 't2t',
        parent_id: null,
      },
    ],
    timestamp: timestamp + 1,
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  const response = await fetch(`${QWEN_BASE}/api/v2/chat/completions?chat_id=${chatId}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'accept-language': 'pt-BR,pt;q=0.9',
      'content-type': 'application/json',
      cookie: headers['cookie'],
      origin: QWEN_BASE,
      referer: `${QWEN_BASE}/c/${chatId}`,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      timezone: new Date().toString().split(' (')[0],
      'user-agent': headers['user-agent'],
      'x-accel-buffering': 'no',
      'x-request-id': uuidv4(),
      'bx-ua': headers['bx-ua'],
      'bx-umidtoken': headers['bx-umidtoken'],
      'bx-v': headers['bx-v'],
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  })
  // Headers received — stop the connection timeout so it never aborts the body.
  clearTimeout(timeoutId)

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '')
    const parsed = parseQwenError(errText)
    if (parsed) {
      throw new QwenParallelError(parsed.message, parsed.code, parsed.status, parsed.retryHours)
    }
    const status = response.status >= 500 ? response.status : 502
    throw new QwenParallelError(`Qwen request failed: ${response.status} ${response.statusText}`, 'UpstreamError', status)
  }

  return { stream: response.body, controller }
}
