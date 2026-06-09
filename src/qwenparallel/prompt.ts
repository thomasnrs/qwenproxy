/*
 * Qwen parallel proxy — prompt builder.
 *
 * Flattens an OpenAI-style message array into the single prompt string the Qwen
 * web API expects. This mirrors the logic of the main /v1/chat/completions
 * route, but is kept self-contained here so the parallel service never depends
 * on (and can never break) the existing handler.
 */

import { OpenAIRequest } from '../utils/types.ts'
import { truncateMessages, estimateTokenCount } from '../utils/context-truncation.ts'
import { getModelContextWindow } from '../core/model-registry.ts'

export interface BuiltPrompt {
  finalPrompt: string
  isThinkingModel: boolean
}

export function buildPrompt(body: OpenAIRequest): BuiltPrompt {
  const messages = body.messages || []
  let prompt = ''
  let systemPrompt = ''

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    let contentStr = ''
    if (Array.isArray(msg.content)) {
      contentStr = msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n')
    } else if (typeof msg.content === 'object' && msg.content !== null) {
      contentStr = JSON.stringify(msg.content)
    } else {
      contentStr = msg.content || ''
    }

    if (msg.role === 'system') {
      systemPrompt += (contentStr || '') + '\n\n'
    } else if (msg.role === 'user') {
      prompt += `User: ${contentStr || ''}\n\n`
    } else if (msg.role === 'assistant') {
      let assistantContent = contentStr || ''
      const reasoning = (msg as any).reasoning_content
      if (reasoning) {
        assistantContent = `<think>\n${reasoning}\n</think>\n${assistantContent}`
      }
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const args = tc.function?.arguments
          let parsedArgs: any = {}
          if (typeof args === 'string') {
            try { parsedArgs = JSON.parse(args) } catch { parsedArgs = {} }
          } else if (args && typeof args === 'object') {
            parsedArgs = args
          }
          const payload = { name: tc.function?.name, arguments: parsedArgs }
          const toolCallStr = `\n<tool_call>\n${JSON.stringify(payload)}\n</tool_call>`
          assistantContent = assistantContent ? assistantContent + toolCallStr : toolCallStr.trim()
        }
      }
      prompt += `Assistant: ${assistantContent.trim()}\n\n`
    } else if (msg.role === 'tool' || msg.role === 'function') {
      let toolName = (msg as any).name
      if (!toolName && (msg as any).tool_call_id) {
        for (let j = i - 1; j >= 0; j--) {
          const prevMsg = messages[j]
          if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
            const call = prevMsg.tool_calls.find((tc: any) => tc.id === (msg as any).tool_call_id)
            if (call) { toolName = call.function?.name; break }
          }
        }
      }
      prompt += `Tool Response (${toolName || 'tool'}): ${contentStr || ''}\n\n`
    }
  }

  const bodyAny = body as any
  if (bodyAny.tools && Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0) {
    const formattedTools = bodyAny.tools.map((t: any) => {
      if (t.type === 'function') {
        return { name: t.function.name, description: t.function.description || '', parameters: t.function.parameters }
      }
      return t
    })
    const toolsJson = JSON.stringify(formattedTools, null, 2)

    systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\n# TOOL CALLING FORMAT (MANDATORY)\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nEXAMPLE OF MULTIPLE TOOL CALLS:\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file1.txt"}}\n</tool_call>\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file2.txt"}}\n</tool_call>\n\nCRITICAL RULES:\n1. ONLY use the tags above for tool calling. NEVER output raw JSON without tags.\n2. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n3. Do NOT output any other text (explanations, chat, etc.) after your <tool_call> blocks. Wait for the user to provide the tool response.\n4. The JSON inside the tags MUST be valid and include ALL required braces and the "arguments" field.\n5. If you need to use a tool, do it IMMEDIATELY without preamble.\n\n`

    if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
      const forcedTool = bodyAny.tool_choice.function.name
      systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`
    }
  }

  const modelId = body.model.replace('-no-thinking', '')
  const modelContextWindow = getModelContextWindow(modelId)
  const estimatedTokens = estimateTokenCount(systemPrompt + prompt)

  let finalPrompt: string
  if (estimatedTokens > modelContextWindow - 1000) {
    const truncated = truncateMessages(messages, modelContextWindow, systemPrompt)
    finalPrompt = truncated
      .map((m: any) => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role}: ${m.content}`)
      .join('\n\n')
  } else {
    finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt
  }

  return { finalPrompt, isThinkingModel: !body.model.includes('no-thinking') }
}
