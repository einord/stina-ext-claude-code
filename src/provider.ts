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
 * Extract the last user message as prompt for Claude Code
 */
function extractPrompt(messages: ChatMessage[]): string {
  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const msgAny = msg as unknown as Record<string, unknown>
    const role = msg.role ?? msgAny['type']
    if (role === 'user' && msg.content) {
      return msg.content
    }
  }
  return ''
}

/**
 * Build system context from non-user messages for Claude Code
 */
function buildSystemContext(messages: ChatMessage[]): string {
  const parts: string[] = []

  for (const msg of messages) {
    const msgAny = msg as unknown as Record<string, unknown>
    const role = msg.role ?? msgAny['type']

    if ((role === 'system' || (role as string) === 'instruction') && msg.content) {
      parts.push(msg.content)
    }
  }

  return parts.join('\n\n')
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
  const cwd = (settings.workingDirectory as string) || undefined
  const maxTurns = parseInt((settings.maxTurns as string) || String(DEFAULT_MAX_TURNS), 10)
  const enableStinaTools = (settings.enableStinaTools as string) !== 'off'
  const model = options.model || 'sonnet'

  // Extract prompt from messages
  const userPrompt = extractPrompt(messages)
  if (!userPrompt) {
    yield { type: 'error', message: 'No user message found' }
    return
  }

  // Build system context
  const systemContext = buildSystemContext(messages)
  const fullPrompt = systemContext
    ? `${systemContext}\n\n---\n\n${userPrompt}`
    : userPrompt

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
          relay = await startToolRelay(context.tools, context.log)
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
      cwd,
      sessionId: existingSessionId,
      mcpConfigPath,
      allowedTools,
    })

    for await (const event of stream) {
      switch (event.type) {
        case 'content':
          yield { type: 'content', text: event.text }
          break

        case 'thinking':
          yield { type: 'thinking', text: event.text }
          break

        case 'session_init':
          // Store session mapping for future resume
          sessionMap.set(conversationId, event.sessionId)
          break

        case 'done':
          yield { type: 'done', usage: event.usage }
          return

        case 'error':
          yield { type: 'error', message: event.message }
          return
      }
    }

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
