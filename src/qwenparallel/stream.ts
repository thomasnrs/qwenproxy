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
  const timestamp = Math.floor(Date.now() / 1000)
  const fid = uuidv4()

  const payload = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: null,
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

  const response = await fetch(`${QWEN_BASE}/api/v2/chat/completions`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'accept-language': 'pt-BR,pt;q=0.9',
      'content-type': 'application/json',
      cookie: headers['cookie'],
      origin: QWEN_BASE,
      referer: `${QWEN_BASE}/`,
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
