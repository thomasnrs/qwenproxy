/*
 * ChatGPT proxy — HTTP routes (OpenAI-compatible), mounted under /chatgpt.
 *
 *   POST /chatgpt/v1/chat/completions   (stream + non-stream)
 *   GET  /chatgpt/v1/models
 *   GET  /chatgpt/v1/accounts
 *
 * Drives chatgpt.com through Playwright. Serializes per account (one chat at a
 * time); concurrency comes from multiple accounts.
 */

import { Hono } from 'hono'
import { stream as honoStream } from 'hono/streaming'
import { v4 as uuidv4 } from 'uuid'
import { config } from '../core/config.ts'
import { OpenAIRequest } from '../utils/types.ts'
import { StreamingToolParser } from '../tools/parser.ts'
import { loadChatGPTAccounts } from './accounts.ts'
import { initChatGPTAccount, getPage } from './browser.ts'
import { streamChatGPT, CGEvent } from './complete.ts'

const app = new Hono()

let roundRobin = 0

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

function flattenPrompt(body: OpenAIRequest): string {
  const messages = body.messages || []
  let system = ''
  let convo = ''
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    let content = ''
    if (Array.isArray(msg.content)) content = msg.content.map((p: any) => p.text || JSON.stringify(p)).join('\n')
    else if (typeof msg.content === 'object' && msg.content !== null) content = JSON.stringify(msg.content)
    else content = msg.content || ''

    if (msg.role === 'system') system += content + '\n\n'
    else if (msg.role === 'user') convo += `User: ${content}\n\n`
    else if (msg.role === 'assistant') {
      let a = content
      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          let args: any = {}
          try { args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function?.arguments || {} } catch {}
          a += `\n<tool_call>\n${JSON.stringify({ name: tc.function?.name, arguments: args })}\n</tool_call>`
        }
      }
      convo += `Assistant: ${a.trim()}\n\n`
    } else if (msg.role === 'tool' || msg.role === 'function') {
      convo += `Tool Response (${(msg as any).name || 'tool'}): ${content}\n\n`
    }
  }

  const bodyAny = body as any
  if (bodyAny.tools?.length) {
    const tools = bodyAny.tools.map((t: any) => (t.type === 'function' ? { name: t.function.name, description: t.function.description || '', parameters: t.function.parameters } : t))
    system += `\n\n# TOOLS\nYou can call tools by emitting EXACTLY:\n<tool_call>\n{"name":"tool_name","arguments":{...}}\n</tool_call>\nAvailable tools:\n${JSON.stringify(tools, null, 2)}\n\n`
  }

  return system ? `${system}\n${convo}`.trim() : convo.trim()
}

interface OpenStream { gen: AsyncGenerator<CGEvent>; first: CGEvent; email: string }

async function openStream(prompt: string): Promise<OpenStream | { error: string }> {
  const accounts = loadChatGPTAccounts()
  if (accounts.length === 0) return { error: 'No ChatGPT accounts configured. Run `npm run chatgpt:login`.' }

  let lastError = 'All ChatGPT accounts failed'
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[(roundRobin + i) % accounts.length]
    try {
      if (!getPage(acc.id)) await initChatGPTAccount(acc, config.browser.headless)
    } catch (e: any) {
      lastError = `Failed to launch ChatGPT for ${acc.email}: ${e?.message}`
      continue
    }
    const gen = streamChatGPT(acc.id, prompt)
    const firstRes = await gen.next()
    if (firstRes.done) { lastError = `No response from ${acc.email}`; continue }
    const first = firstRes.value
    if (first.type === 'error') { lastError = first.message; await gen.return?.(undefined as any).catch(() => {}); continue }
    roundRobin = (roundRobin + i + 1) % accounts.length
    return { gen, first, email: acc.email }
  }
  return { error: lastError }
}

app.post('/v1/chat/completions', async (c) => {
  let body: OpenAIRequest
  try { body = await c.req.json() } catch { return c.json({ error: { message: 'Invalid JSON body' } }, 400) }

  const isStream = body.stream ?? false
  const bodyAny = body as any
  const prompt = flattenPrompt(body)

  const opened = await openStream(prompt)
  if ('error' in opened) return c.json({ error: { message: opened.error } }, 502)

  const { gen, first } = opened
  const completionId = 'chatcmpl-' + uuidv4()
  const created = Math.floor(Date.now() / 1000)

  async function* events(): AsyncGenerator<CGEvent> {
    yield first
    for await (const ev of gen) yield ev
  }

  if (!isStream) {
    const toolParser = new StreamingToolParser(bodyAny.tools || [])
    const toolCalls: any[] = []
    let content = ''
    let reasoning = ''
    let errored: string | null = null
    for await (const ev of events()) {
      if (ev.type === 'error') { errored = ev.message; break }
      if (ev.type === 'reasoning') reasoning += ev.text
      else if (ev.type === 'content') {
        const { text, toolCalls: tcs } = toolParser.feed(ev.text)
        if (text) content += text
        for (const tc of tcs) toolCalls.push({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })
      }
    }
    if (errored && !content && !toolCalls.length) return c.json({ error: { message: errored } }, 502)
    const flush = toolParser.flush()
    if (flush.text) content += flush.text
    for (const tc of flush.toolCalls) toolCalls.push({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })

    const message: any = { role: 'assistant', content: toolCalls.length ? null : content }
    if (reasoning) message.reasoning_content = reasoning
    if (toolCalls.length) { toolCalls.forEach((tc, i) => (tc.index = i)); message.tool_calls = toolCalls }
    return c.json({
      id: completionId,
      object: 'chat.completion',
      created,
      model: body.model,
      choices: [{ index: 0, message, logprobs: null, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  }

  c.header('Content-Type', 'text/event-stream')
  c.header('Cache-Control', 'no-cache')
  c.header('Connection', 'keep-alive')

  return honoStream(c, async (sw: any) => {
    const toolParser = new StreamingToolParser(bodyAny.tools || [])
    const writeEvent = (data: any) => sw.write(`data: ${JSON.stringify(data)}\n\n`)
    const chunk = (delta: any, finish: string | null = null) => ({ id: completionId, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] })
    let heartbeat: any
    try {
      await sw.write(': heartbeat\n\n')
      heartbeat = setInterval(() => { sw.write(': keep-alive\n\n').catch(() => clearInterval(heartbeat)) }, 15000)
      await writeEvent(chunk({ role: 'assistant', content: '' }))

      for await (const ev of events()) {
        if (ev.type === 'error') { await writeEvent(chunk({ content: `\n[ChatGPT error] ${ev.message}` })); break }
        if (ev.type === 'reasoning') { await writeEvent(chunk({ reasoning_content: ev.text })); continue }
        const { text, toolCalls } = toolParser.feed(ev.text)
        if (text) await writeEvent(chunk({ content: text }))
        for (const tc of toolCalls) {
          await writeEvent(chunk({ tool_calls: [{ index: toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc), id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] }))
        }
      }

      const flush = toolParser.flush()
      if (flush.text) await writeEvent(chunk({ content: flush.text }))
      for (const tc of flush.toolCalls) {
        await writeEvent(chunk({ tool_calls: [{ index: toolParser.getEmittedToolCallCount() - flush.toolCalls.length + flush.toolCalls.indexOf(tc), id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] }))
      }
      await writeEvent(chunk({}, toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop'))
      await sw.write('data: [DONE]\n\n')
    } finally {
      clearInterval(heartbeat)
    }
  })
})

app.get('/v1/models', async (c) => {
  const created = Math.floor(Date.now() / 1000)
  const fallback = {
    object: 'list',
    data: [
      { id: 'gpt-4o', object: 'model', created, owned_by: 'openai' },
      { id: 'gpt-4o-mini', object: 'model', created, owned_by: 'openai' },
      { id: 'o3-mini', object: 'model', created, owned_by: 'openai' },
    ],
  }

  try {
    const accounts = loadChatGPTAccounts()
    if (accounts.length === 0) return c.json(fallback)

    // Use a logged-in page to fetch the account's REAL model list.
    let acc = accounts.find(a => getPage(a.id)) || accounts[0]
    if (!getPage(acc.id)) await initChatGPTAccount(acc, config.browser.headless)
    const page = getPage(acc.id)
    if (!page) return c.json(fallback)

    const raw = await page.evaluate(async () => {
      try {
        const r = await fetch('/backend-api/models?iim=false&is_gizmo=false&supports_model_picker_upgrade_presets=true', { credentials: 'include' })
        if (!r.ok) return null
        const j = await r.json()
        return (j && j.models) || null
      } catch {
        return null
      }
    })

    if (!Array.isArray(raw) || raw.length === 0) return c.json(fallback)

    const seen = new Set<string>()
    const data: any[] = []
    for (const m of raw as any[]) {
      const id = m?.slug || m?.id
      if (!id || seen.has(id)) continue
      seen.add(id)
      data.push({ id, name: m?.title || id, object: 'model', created, owned_by: 'openai' })
    }
    console.log(`[ChatGPT] /v1/models -> ${data.length} models from ${acc.email}`)
    return c.json({ object: 'list', data: data.length ? data : fallback.data })
  } catch (e: any) {
    console.warn('[ChatGPT] /v1/models failed, using fallback:', e?.message)
    return c.json(fallback)
  }
})

app.get('/v1/accounts', (c) => {
  return c.json({
    object: 'list',
    data: loadChatGPTAccounts().map(a => ({ id: a.id, email: a.email, initialized: !!getPage(a.id) })),
  })
})

export { app as chatGPTApp }
