/*
 * Qwen parallel proxy — HTTP routes.
 *
 * A second OpenAI-compatible entrypoint for the Qwen accounts, mounted under
 * /qwen-parallel. Unlike the main /v1/chat/completions route it takes NO
 * per-account mutex and opens a fresh Qwen conversation per request, so a single
 * account can serve many concurrent streams (ideal for parallel multi-agent
 * orchestration). It reuses the existing account pool, the cached Playwright
 * headers, and the rate-limit cooldown system, but shares none of the main
 * route's code — so it cannot affect the behaviour that already works.
 *
 *   POST /qwen-parallel/v1/chat/completions   (stream + non-stream)
 *   GET  /qwen-parallel/v1/models
 *   GET  /qwen-parallel/v1/status             (account cooldowns)
 */

import { Hono } from 'hono'
import { stream as honoStream } from 'hono/streaming'
import { v4 as uuidv4 } from 'uuid'
import { config } from '../core/config.ts'
import { OpenAIRequest } from '../utils/types.ts'
import { StreamingToolParser } from '../tools/parser.ts'
import {
  getNextAccount,
  getNextAvailableAccount,
  markAccountRateLimited,
  getAccountCooldownInfo,
  getCooldownStatus,
} from '../core/account-manager.ts'
import { buildPrompt } from './prompt.ts'
import { createParallelStream, parseQwenError, QwenParallelError } from './stream.ts'
import { getIncrementalDelta } from './delta.ts'

const app = new Hono()

// Optional auth — same proxy API key as the rest of the server.
app.use('*', async (c, next) => {
  const apiKey = process.env.API_KEY
  if (apiKey) {
    const auth = c.req.header('Authorization')
    if (!auth?.startsWith('Bearer ') || auth.slice(7) !== apiKey) {
      return c.json({ error: { message: 'Missing or invalid Authorization header' } }, 401)
    }
  }
  await next()
})

type QwenEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'content'; text: string }
  | { type: 'usage'; prompt: number; completion: number }
  | { type: 'error'; err: NonNullable<ReturnType<typeof parseQwenError>> }

/**
 * Parse the raw Qwen SSE stream into a flat sequence of events. Handles the
 * cumulative-vs-incremental content quirk and the thinking_summary phase, and
 * surfaces a trailing non-SSE error body (e.g. the daily rate-limit) as an
 * 'error' event.
 */
async function* qwenEvents(stream: ReadableStream): AsyncGenerator<QwenEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastFullContent = ''
  let currentThoughtIndex = 0
  let targetResponseId: string | null = null

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const dataStr = trimmed.slice(6)
        if (dataStr === '[DONE]') continue

        try {
          const chunk = JSON.parse(dataStr)

          if (chunk['response.created']?.response_id && !targetResponseId) {
            targetResponseId = chunk['response.created'].response_id
          } else if (chunk.response_id && !targetResponseId) {
            targetResponseId = chunk.response_id
          }

          if (chunk.usage) {
            yield { type: 'usage', prompt: chunk.usage.input_tokens || 0, completion: chunk.usage.output_tokens || 0 }
          }

          const delta = chunk.choices?.[0]?.delta
          if (delta && (targetResponseId === null || chunk.response_id === targetResponseId)) {
            if (delta.phase === 'thinking_summary') {
              const thoughts = delta.extra?.summary_thought?.content
              if (Array.isArray(thoughts) && thoughts.length > currentThoughtIndex) {
                const text = thoughts.slice(currentThoughtIndex).join('\n')
                currentThoughtIndex = thoughts.length
                if (text) yield { type: 'reasoning', text }
              }
            } else if (delta.phase === 'answer' && delta.content !== undefined) {
              const res = getIncrementalDelta(lastFullContent, delta.content || '')
              if (res.delta) {
                lastFullContent = res.matchedContent
                if (res.delta !== 'FINISHED') yield { type: 'content', text: res.delta }
              }
            }
          }
        } catch {
          // partial / non-JSON chunk — ignore
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  const err = parseQwenError(buffer)
  if (err) yield { type: 'error', err }
}

function applyCooldown(accountId: string, err: { code: string; status: number; retryHours?: number }): void {
  if (err.code === 'RateLimited' || err.status === 429) {
    const cooldownMs = err.retryHours !== undefined ? err.retryHours * 60 * 60 * 1000 : undefined
    markAccountRateLimited(accountId, cooldownMs, 'RateLimited')
    console.warn(`[QwenParallel] Account ${accountId} rate-limited (in-stream). Cooldown set${err.retryHours !== undefined ? ` for ~${err.retryHours}h` : ''}.`)
  }
}

app.post('/v1/chat/completions', async (c) => {
  let body: OpenAIRequest
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: { message: 'Invalid JSON body' } }, 400)
  }

  const isStream = body.stream ?? false
  const bodyAny = body as any
  const { finalPrompt, isThinkingModel } = buildPrompt(body)

  // Account selection with fallback — NO mutex, so concurrent requests proceed
  // in parallel. Each opens its own fresh Qwen conversation.
  const tried = new Set<string>()
  let account = getNextAccount()
  let lastError: any = null
  let streamResult: { stream: ReadableStream; controller: AbortController } | undefined
  let chosenAccountId = ''

  while (account) {
    if (tried.has(account.id)) {
      account = getNextAvailableAccount(account.id)
      continue
    }
    tried.add(account.id)

    if (getAccountCooldownInfo(account.id)) {
      account = getNextAvailableAccount(account.id)
      continue
    }

    try {
      streamResult = await createParallelStream(finalPrompt, isThinkingModel, body.model, account.id)
      chosenAccountId = account.id
      break
    } catch (err: any) {
      lastError = err
      if (err instanceof QwenParallelError && (err.code === 'RateLimited' || err.status === 429)) {
        const cooldownMs = err.retryHours !== undefined ? err.retryHours * 60 * 60 * 1000 : undefined
        markAccountRateLimited(account.id, cooldownMs, 'RateLimited')
        console.warn(`[QwenParallel] Account ${account.id} rate-limited (HTTP). Trying next account.`)
        account = getNextAvailableAccount(account.id)
        continue
      }
      if (err instanceof QwenParallelError && err.status >= 500) {
        account = getNextAvailableAccount(account.id)
        continue
      }
      break // non-retryable
    }
  }

  if (!streamResult) {
    const status = lastError instanceof QwenParallelError ? lastError.status : 429
    const message = lastError?.message || 'All Qwen accounts are rate-limited or unavailable.'
    return c.json({ error: { message } }, status as any)
  }

  const completionId = 'chatcmpl-' + uuidv4()
  const created = Math.floor(Date.now() / 1000)
  const promptTokensEst = Math.ceil(finalPrompt.length / 3.5)

  if (!isStream) {
    const toolParser = new StreamingToolParser(bodyAny.tools || [])
    const toolCallsOut: any[] = []
    let reasoning = ''
    let contentOut = ''
    let completionTokens = 0
    let promptTokens = promptTokensEst
    let upstreamError: QwenEvent | null = null

    for await (const ev of qwenEvents(streamResult.stream)) {
      if (ev.type === 'usage') { completionTokens = ev.completion || completionTokens; promptTokens = ev.prompt || promptTokens }
      else if (ev.type === 'reasoning') reasoning += ev.text
      else if (ev.type === 'content') {
        const { text, toolCalls } = toolParser.feed(ev.text)
        if (text) contentOut += text
        for (const tc of toolCalls) toolCallsOut.push({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })
      } else if (ev.type === 'error') { upstreamError = ev; break }
    }

    if (upstreamError && upstreamError.type === 'error') {
      applyCooldown(chosenAccountId, upstreamError.err)
      return c.json({ error: { message: upstreamError.err.message } }, upstreamError.err.status as any)
    }

    const { text: remainingText, toolCalls: remainingToolCalls } = toolParser.flush()
    if (remainingText) contentOut += remainingText
    for (const tc of remainingToolCalls) toolCallsOut.push({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })

    const message: any = { role: 'assistant', content: toolCallsOut.length ? null : contentOut }
    if (reasoning) message.reasoning_content = reasoning
    if (toolCallsOut.length) { toolCallsOut.forEach((tc, idx) => (tc.index = idx)); message.tool_calls = toolCallsOut }

    return c.json({
      id: completionId,
      object: 'chat.completion',
      created,
      model: body.model,
      choices: [{ index: 0, message, logprobs: null, finish_reason: toolCallsOut.length ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, prompt_tokens_details: { cached_tokens: 0 } },
    })
  }

  // Streaming (SSE) response.
  c.header('Content-Type', 'text/event-stream')
  c.header('Cache-Control', 'no-cache')
  c.header('Connection', 'keep-alive')

  return honoStream(c, async (sw: any) => {
    const toolParser = new StreamingToolParser(bodyAny.tools || [])
    let completionTokens = 0
    let promptTokens = promptTokensEst
    let heartbeat: any

    const writeEvent = (data: any) => sw.write(`data: ${JSON.stringify(data)}\n\n`)
    const chunk = (choices: any[]) => ({ id: completionId, object: 'chat.completion.chunk', created, model: body.model, choices })
    const choice = (delta: any, finish: string | null = null) => ({ index: 0, delta, logprobs: null, finish_reason: finish })

    try {
      await sw.write(': heartbeat\n\n')
      heartbeat = setInterval(() => { sw.write(': keep-alive\n\n').catch(() => clearInterval(heartbeat)) }, 15000)

      await writeEvent(chunk([choice({ role: 'assistant', content: '' })]))

      let upstreamError: QwenEvent | null = null
      for await (const ev of qwenEvents(streamResult!.stream)) {
        if (ev.type === 'usage') { completionTokens = ev.completion || completionTokens; promptTokens = ev.prompt || promptTokens }
        else if (ev.type === 'reasoning') {
          await writeEvent(chunk([choice({ reasoning_content: ev.text })]))
        } else if (ev.type === 'content') {
          const { text, toolCalls } = toolParser.feed(ev.text)
          if (text) await writeEvent(chunk([choice({ content: text })]))
          for (const tc of toolCalls) {
            await writeEvent(chunk([choice({ tool_calls: [{ index: toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc), id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] })]))
          }
        } else if (ev.type === 'error') { upstreamError = ev; break }
      }

      if (upstreamError && upstreamError.type === 'error') {
        applyCooldown(chosenAccountId, upstreamError.err)
        await writeEvent(chunk([choice({ content: upstreamError.err.message })]))
        await writeEvent(chunk([choice({}, 'stop')]))
        await sw.write('data: [DONE]\n\n')
        return
      }

      const { text: remainingText, toolCalls: remainingToolCalls } = toolParser.flush()
      if (remainingText) await writeEvent(chunk([choice({ content: remainingText })]))
      for (const tc of remainingToolCalls) {
        await writeEvent(chunk([choice({ tool_calls: [{ index: toolParser.getEmittedToolCallCount() - remainingToolCalls.length + remainingToolCalls.indexOf(tc), id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] })]))
      }

      const finish = toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop'
      const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, prompt_tokens_details: { cached_tokens: 0 } }
      await writeEvent({ ...chunk([choice({}, finish)]), ...(body.stream_options?.include_usage ? {} : { usage }) })
      if (body.stream_options?.include_usage) {
        await writeEvent({ ...chunk([]), usage })
      }
      await sw.write('data: [DONE]\n\n')
    } finally {
      clearInterval(heartbeat)
    }
  })
})

app.get('/v1/models', async (c) => {
  const account = getNextAccount()
  const { getBasicHeaders } = await import('../services/playwright.ts')
  const { cookie, userAgent, bxV } = await getBasicHeaders(account?.id)
  const res = await fetch(`${config.qwen.baseUrl}/api/models`, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      Referer: `${config.qwen.baseUrl}/`,
      'User-Agent': userAgent,
      'X-Request-Id': uuidv4(),
      source: 'web',
      'bx-v': bxV,
      Cookie: cookie,
    },
  })
  if (!res.ok) return c.json({ error: { message: `Failed to fetch models: ${res.status}` } }, 502)
  const data: any = await res.json()
  const models = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
  return c.json({
    object: 'list',
    data: [
      ...models.map((m: any) => ({ id: m.id, name: m.name, object: 'model', owned_by: m.owned_by, created: m.info?.created_at || Date.now() })),
      ...models.map((m: any) => ({ id: `${m.id}-no-thinking`, name: `${m.name} (No Thinking)`, object: 'model', owned_by: m.owned_by, created: m.info?.created_at || Date.now() })),
    ],
  })
})

app.get('/v1/status', (c) => {
  return c.json({ object: 'qwen-parallel.status', cooldowns: getCooldownStatus() })
})

export { app as qwenParallelApp }
