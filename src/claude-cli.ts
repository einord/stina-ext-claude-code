/**
 * Claude Code CLI Integration
 *
 * Spawns claude CLI process and yields parsed stream events.
 */

import type { StreamEvent } from '@stina/extension-api/runtime'
import type { ClaudeEvent } from './types.js'

export interface ClaudeCliOptions {
  claudePath: string
  prompt: string
  model: string
  maxTurns: number
  cwd?: string
  sessionId?: string
  mcpConfigPath?: string
  allowedTools?: string[]
}

/** Internal event from the CLI parser */
export type CliStreamEvent =
  | { type: 'content'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'done'; usage?: { inputTokens: number; outputTokens: number }; sessionId?: string }
  | { type: 'error'; message: string }
  | { type: 'session_init'; sessionId: string }

/**
 * Run Claude Code CLI and yield stream events
 */
export async function* runClaudeCode(options: ClaudeCliOptions): AsyncGenerator<CliStreamEvent, void, unknown> {
  // Dynamic import for Node.js modules (runs in Worker Thread)
  const { spawn } = await import('node:child_process')
  const { homedir } = await import('node:os')

  const args: string[] = [
    '-p', options.prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--model', options.model,
    '--max-turns', String(options.maxTurns),
    '--dangerously-skip-permissions',
  ]

  if (options.sessionId) {
    args.push('--resume', options.sessionId)
  }

  if (options.mcpConfigPath) {
    args.push('--mcp-config', options.mcpConfigPath)
  }

  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push('--allowedTools', ...options.allowedTools, 'mcp__stina-tools__*')
  }

  const cwd = options.cwd || homedir()

  // Remove CLAUDE_CODE_ENTRY_POINT to avoid blocking nested sessions
  const env = { ...process.env }
  delete env.CLAUDE_CODE_ENTRY_POINT

  const child = spawn(options.claudePath, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Close stdin immediately — we pass everything via -p
  child.stdin.end()

  let sessionId: string | undefined

  // Create a promise to track process completion
  const exitPromise = new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code))
    child.on('error', () => {
      resolve(null)
    })
  })

  // Read stdout as NDJSON
  const stdoutIterator = readLines(child.stdout)

  try {
    for await (const line of stdoutIterator) {
      if (!line.trim()) continue

      let event: ClaudeEvent
      try {
        event = JSON.parse(line) as ClaudeEvent
      } catch {
        // Skip non-JSON lines (e.g. stderr leak)
        continue
      }

      // Process different event types
      if (event.type === 'system' && event.subtype === 'init') {
        sessionId = event.session_id
        yield { type: 'session_init', sessionId: event.session_id }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'content', text: event.delta.text }
        } else if (event.delta.type === 'thinking_delta') {
          yield { type: 'thinking', text: event.delta.thinking }
        }
      } else if (event.type === 'assistant') {
        // Full assistant message — extract tool use info for display
        for (const block of event.message.content) {
          if (block.type === 'tool_use') {
            yield { type: 'content', text: `\n[Tool: ${block.name}]\n` }
          }
        }
      } else if (event.type === 'result') {
        yield {
          type: 'done',
          usage: event.usage ? {
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
          } : undefined,
          sessionId,
        }
        return // Stream complete
      }
    }

    // If we get here without a result event, wait for process to exit
    const exitCode = await exitPromise
    if (exitCode !== 0) {
      yield { type: 'error', message: `Claude Code process exited with code ${exitCode}` }
    }

  } catch (error) {
    yield {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Read lines from a readable stream
 */
async function* readLines(stream: NodeJS.ReadableStream): AsyncGenerator<string, void, unknown> {
  let buffer = ''

  for await (const chunk of stream) {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      yield line
    }
  }

  // Yield any remaining content
  if (buffer.trim()) {
    yield buffer
  }
}
