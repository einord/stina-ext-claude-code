/**
 * Claude Code AI Provider
 *
 * Implementation of the AIProvider interface for Claude Code CLI.
 */

import type {
  ExtensionContext,
  AIProvider,
  ModelInfo,
  ChatMessage,
  ChatOptions,
  GetModelsOptions,
  StreamEvent,
} from '@stina/extension-api/runtime'
import { PROVIDER_ID, PROVIDER_NAME, MODELS, DEFAULT_CLAUDE_PATH, DEFAULT_MAX_TURNS } from './constants.js'
import { runClaudeCode } from './claude-cli.js'
import { startToolRelay, createMcpConfigFile, type ToolRelayServer } from './mcp-bridge.js'

// Session ID mapping: Stina conversation ID -> Claude Code session ID
const sessionMap = new Map<string, string>()

/**
 * Creates the Claude Code AI provider
 */
export function createClaudeCodeProvider(context: ExtensionContext): AIProvider {
  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,

    getModels: (_options?: GetModelsOptions) => getModels(context),
    chat: (messages: ChatMessage[], options: ChatOptions) => streamChat(context, messages, options),
  }
}

/**
 * Returns hardcoded model list. Optionally verifies CLI availability.
 */
async function getModels(context: ExtensionContext): Promise<ModelInfo[]> {
  context.log.debug('Returning Claude Code models')
  return MODELS
}

/**
 * Build the prompt for Claude Code from the message history.
 *
 * Claude Code takes a single prompt string (not a message array), so we
 * combine system/instruction context with the user message.
 *
 * At conversation start, Stina sends only instruction messages (no user
 * message) to trigger a greeting — we handle that by using the last
 * instruction as the prompt.
 */
function buildPrompt(messages: ChatMessage[]): string {
  const systemParts: string[] = []
  let userPrompt = ''

  for (const msg of messages) {
    if (msg.role === 'user' && msg.content) {
      userPrompt = msg.content
    } else if (msg.role === 'system' && msg.content) {
      systemParts.push(msg.content)
    }
  }

  // If no user message, use the last system/instruction message as prompt
  // This handles the conversation-start greeting flow
  if (!userPrompt && systemParts.length > 0) {
    userPrompt = systemParts.pop()!
  }

  if (systemParts.length > 0) {
    return `${systemParts.join('\n\n')}\n\n---\n\n${userPrompt}`
  }

  return userPrompt
}

/**
 * Stream a chat response from Claude Code CLI
 */
async function* streamChat(
  context: ExtensionContext,
  messages: ChatMessage[],
  options: ChatOptions
): AsyncGenerator<StreamEvent, void, unknown> {
  const settings = options.settings || {}
  const claudePath = (settings.claudePath as string) || DEFAULT_CLAUDE_PATH
  const maxTurns = parseInt((settings.maxTurns as string) || String(DEFAULT_MAX_TURNS), 10)
  const enableStinaTools = (settings.enableStinaTools as string) !== 'off'
  const model = options.model || 'sonnet'
  const userId = (options.context?.userId as string) || undefined

  // Build prompt from messages
  const fullPrompt = buildPrompt(messages)
  if (!fullPrompt) {
    context.log.error('No prompt could be extracted from messages', {
      messageCount: messages.length,
      roles: messages.map((m) => m.role),
    })
    yield { type: 'error', message: 'No message content found' }
    return
  }

  // Derive a conversation key from settings for session tracking
  const conversationId = (settings.conversationId as string) || 'default'
  const existingSessionId = sessionMap.get(conversationId)

  context.log.info('Starting Claude Code chat', {
    model,
    maxTurns,
    enableStinaTools,
    hasSession: !!existingSessionId,
  })

  let relay: ToolRelayServer | undefined
  let mcpConfigPath: string | undefined
  let allowedTools: string[] | undefined

  try {
    // Set up MCP bridge for Stina tools if enabled
    if (enableStinaTools && context.tools) {
      try {
        const tools = await context.tools.list()
        if (tools.length > 0) {
          relay = await startToolRelay(context.tools, context.log, userId)
          mcpConfigPath = await createMcpConfigFile(tools, relay.port)
          // Allow all Claude Code built-in tools plus Stina tools
          allowedTools = [
            'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
            'WebFetch', 'WebSearch', 'NotebookEdit',
          ]
          context.log.info('MCP bridge started', { port: relay.port, toolCount: tools.length })
        }
      } catch (error) {
        context.log.warn('Failed to set up MCP bridge, continuing without Stina tools', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Run Claude Code CLI
    const stream = runClaudeCode({
      claudePath,
      prompt: fullPrompt,
      model,
      maxTurns,
      sessionId: existingSessionId,
      mcpConfigPath,
      allowedTools,
    })

    let eventCount = 0
    for await (const event of stream) {
      eventCount++
      context.log.debug('CLI stream event', { type: event.type, eventCount })

      switch (event.type) {
        case 'content':
          yield { type: 'content', text: event.text }
          break

        case 'thinking':
          yield { type: 'thinking', text: event.text }
          break

        case 'tool_start': {
          const MCP_PREFIX = 'mcp__stina-tools__'
          if (relay && event.name.startsWith(MCP_PREFIX)) {
            // Stina tool via MCP — strip prefix and await real result from relay
            const strippedName = event.name.slice(MCP_PREFIX.length)
            yield { type: 'tool_start', name: strippedName, input: event.input, toolCallId: event.toolCallId }
            try {
              const result = await relay.waitForResult()
              yield { type: 'tool_end', name: strippedName, output: result.data ?? result, toolCallId: event.toolCallId }
            } catch {
              yield { type: 'tool_end', name: strippedName, output: { status: 'completed' }, toolCallId: event.toolCallId }
            }
          } else {
            // Built-in Claude Code tool — no relay result available
            yield { type: 'tool_start', name: event.name, input: event.input, toolCallId: event.toolCallId }
            yield { type: 'tool_end', name: event.name, output: { status: 'completed' }, toolCallId: event.toolCallId }
          }
          break
        }

        case 'session_init':
          // Store session mapping for future resume
          sessionMap.set(conversationId, event.sessionId)
          context.log.info('Session initialized', { sessionId: event.sessionId })
          break

        case 'done':
          context.log.info('Claude Code stream done', { eventCount, usage: event.usage })
          yield { type: 'done', usage: event.usage }
          return

        case 'error':
          context.log.error('Claude Code stream error', { message: event.message })
          yield { type: 'error', message: event.message }
          return
      }
    }

    context.log.info('Claude Code stream ended without done event', { eventCount })
    // If stream ended without done event
    yield { type: 'done' }

  } catch (error) {
    context.log.error('Claude Code chat error', {
      error: error instanceof Error ? error.message : String(error),
    })
    yield {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    // Clean up
    if (relay) {
      relay.close()
    }
    if (mcpConfigPath) {
      try {
        const fs = await import('node:fs/promises')
        await fs.unlink(mcpConfigPath)
      } catch {
        // Best effort cleanup
      }
    }
  }
}
