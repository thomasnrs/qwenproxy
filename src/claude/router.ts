/*
 * Claude proxy - HTTP routes (OpenAI-compatible), mounted under /claude.
 */

import { Hono } from 'hono'
import { stream as honoStream } from 'hono/streaming'
import { v4 as uuidv4 } from 'uuid'
import { config } from '../core/config.ts'
import { OpenAIRequest } from '../utils/types.ts'
import { StreamingToolParser } from '../tools/parser.ts'
import { loadClaudeAccounts } from './accounts.ts'
import { initClaudeAccount, getPage } from './browser.ts'
import { streamClaude, ClaudeEvent } from './complete.ts'

const app = new Hono()

let roundRobin = 0

function isClaudeDebugEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.CLAUDE_DEBUG || '').toLowerCase())
}

const DEBUG = isClaudeDebugEnabled()

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
    if (Array.isArray(msg.content)) content = msg.content.map((part: any) => part.text || JSON.stringify(part)).join('\n')
    else if (typeof msg.content === 'object' && msg.content !== null) content = JSON.stringify(msg.content)
    else content = msg.content || ''

    if (msg.role === 'system') system += content + '\n\n'
    else if (msg.role === 'user') convo += `User: ${content}\n\n`
    else if (msg.role === 'assistant') {
      let assistant = content
      if (msg.tool_calls?.length) {
        for (const toolCall of msg.tool_calls) {
          let args: any = {}
          try { args = typeof toolCall.function?.arguments === 'string' ? JSON.parse(toolCall.function.arguments) : toolCall.function?.arguments || {} } catch {}
          assistant += `\n<tool_call>\n${JSON.stringify({ name: toolCall.function?.name, arguments: args })}\n</tool_call>`
        }
      }
      convo += `Assistant: ${assistant.trim()}\n\n`
    } else if (msg.role === 'tool' || msg.role === 'function') {
      convo += `Tool Response (${(msg as any).name || 'tool'}): ${content}\n\n`
    }
  }

  const bodyAny = body as any
  if (bodyAny.tools?.length) {
    const tools = bodyAny.tools.map((tool: any) => (
      tool.type === 'function'
        ? { name: tool.function.name, description: tool.function.description || '', parameters: tool.function.parameters }
        : tool
    ))
    system += `\n\n# TOOLS\nYou can call tools by emitting EXACTLY:\n<tool_call>\n{"name":"tool_name","arguments":{...}}\n</tool_call>\nAvailable tools:\n${JSON.stringify(tools, null, 2)}\n\n`
  }

  return system ? `${system}\n${convo}`.trim() : convo.trim()
}

interface OpenStream {
  gen: AsyncGenerator<ClaudeEvent>
  first: ClaudeEvent
  email: string
}

async function openStream(prompt: string): Promise<OpenStream | { error: string }> {
  const accounts = loadClaudeAccounts()
  if (accounts.length === 0) return { error: 'No Claude accounts configured. Run `npm run claude:login`.' }

  let lastError = 'All Claude accounts failed'
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[(roundRobin + i) % accounts.length]
    try {
      if (!getPage(account.id)) await initClaudeAccount(account, config.browser.headless)
    } catch (e: any) {
      lastError = `Failed to launch Claude for ${account.email}: ${e?.message}`
      continue
    }

    const gen = streamClaude(account.id, prompt)
    const firstRes = await gen.next()
    if (firstRes.done) {
      lastError = `No response from ${account.email}`
      continue
    }

    const first = firstRes.value
    if (first.type === 'error') {
      lastError = first.message
      await gen.return?.(undefined as any).catch(() => {})
      continue
    }

    roundRobin = (roundRobin + i + 1) % accounts.length
    return { gen, first, email: account.email }
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

  async function* events(): AsyncGenerator<ClaudeEvent> {
    yield first
    for await (const event of gen) yield event
  }

  if (!isStream) {
    const toolParser = new StreamingToolParser(bodyAny.tools || [])
    const toolCalls: any[] = []
    let content = ''
    let reasoning = ''
    let errored: string | null = null

    for await (const event of events()) {
      if (event.type === 'error') {
        errored = event.message
        break
      }
      if (event.type === 'reasoning') reasoning += event.text
      else if (event.type === 'content') {
        const { text, toolCalls: parsedToolCalls } = toolParser.feed(event.text)
        if (text) {
          if (DEBUG) console.log('[Claude][out][non-stream][content]', JSON.stringify(text.slice(0, 300)))
          content += text
        }
        for (const toolCall of parsedToolCalls) {
          if (DEBUG) console.log('[Claude][out][non-stream][tool_call]', toolCall.name, JSON.stringify(toolCall.arguments).slice(0, 300))
          toolCalls.push({
            id: toolCall.id,
            type: 'function',
            function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
          })
        }
      }
    }

    if (errored && !content && !toolCalls.length) return c.json({ error: { message: errored } }, 502)

    const flush = toolParser.flush()
    if (flush.text) {
      if (DEBUG) console.log('[Claude][out][non-stream][flush-content]', JSON.stringify(flush.text.slice(0, 300)))
      content += flush.text
    }
    for (const toolCall of flush.toolCalls) {
      if (DEBUG) console.log('[Claude][out][non-stream][flush-tool_call]', toolCall.name, JSON.stringify(toolCall.arguments).slice(0, 300))
      toolCalls.push({
        id: toolCall.id,
        type: 'function',
        function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
      })
    }

    const message: any = { role: 'assistant', content: toolCalls.length ? null : content }
    if (reasoning) message.reasoning_content = reasoning
    if (toolCalls.length) {
      toolCalls.forEach((toolCall, index) => { toolCall.index = index })
      message.tool_calls = toolCalls
    }

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

  return honoStream(c, async (streamWriter: any) => {
    const toolParser = new StreamingToolParser(bodyAny.tools || [])
    const writeEvent = (data: any) => streamWriter.write(`data: ${JSON.stringify(data)}\n\n`)
    const chunk = (delta: any, finishReason: string | null = null) => ({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    })
    let heartbeat: any

    try {
      await streamWriter.write(': heartbeat\n\n')
      heartbeat = setInterval(() => {
        streamWriter.write(': keep-alive\n\n').catch(() => clearInterval(heartbeat))
      }, 15000)
      await writeEvent(chunk({ role: 'assistant', content: '' }))

      for await (const event of events()) {
        if (event.type === 'error') {
          await writeEvent(chunk({ content: `\n[Claude error] ${event.message}` }))
          break
        }
        if (event.type === 'reasoning') {
          await writeEvent(chunk({ reasoning_content: event.text }))
          continue
        }

        const { text, toolCalls } = toolParser.feed(event.text)
        if (text) {
          if (DEBUG) console.log('[Claude][out][stream][content]', JSON.stringify(text.slice(0, 300)))
          await writeEvent(chunk({ content: text }))
        }
        for (const toolCall of toolCalls) {
          if (DEBUG) console.log('[Claude][out][stream][tool_call]', toolCall.name, JSON.stringify(toolCall.arguments).slice(0, 300))
          await writeEvent(chunk({
            tool_calls: [{
              index: toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(toolCall),
              id: toolCall.id,
              type: 'function',
              function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
            }],
          }))
        }
      }

      const flush = toolParser.flush()
      if (flush.text) {
        if (DEBUG) console.log('[Claude][out][stream][flush-content]', JSON.stringify(flush.text.slice(0, 300)))
        await writeEvent(chunk({ content: flush.text }))
      }
      for (const toolCall of flush.toolCalls) {
        if (DEBUG) console.log('[Claude][out][stream][flush-tool_call]', toolCall.name, JSON.stringify(toolCall.arguments).slice(0, 300))
        await writeEvent(chunk({
          tool_calls: [{
            index: toolParser.getEmittedToolCallCount() - flush.toolCalls.length + flush.toolCalls.indexOf(toolCall),
            id: toolCall.id,
            type: 'function',
            function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
          }],
        }))
      }

      await writeEvent(chunk({}, toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop'))
      await streamWriter.write('data: [DONE]\n\n')
    } finally {
      clearInterval(heartbeat)
    }
  })
})

app.get('/v1/models', (c) => {
  const created = Math.floor(Date.now() / 1000)
  return c.json({
    object: 'list',
    data: [
      { id: 'claude-web', object: 'model', created, owned_by: 'anthropic' },
      { id: 'claude-sonnet', object: 'model', created, owned_by: 'anthropic' },
      { id: 'claude-opus', object: 'model', created, owned_by: 'anthropic' },
      { id: 'claude-haiku', object: 'model', created, owned_by: 'anthropic' },
    ],
  })
})

app.get('/v1/accounts', (c) => {
  return c.json({
    object: 'list',
    data: loadClaudeAccounts().map(account => ({ id: account.id, email: account.email, initialized: !!getPage(account.id) })),
  })
})

export { app as claudeApp }
