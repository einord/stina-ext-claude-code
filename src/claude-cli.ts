/**
 * Claude Code CLI Integration
 *
 * Spawns claude CLI process and yields parsed stream events.
 */

import type { ClaudeEvent } from './types.js'

export interface ClaudeCliOptions {
  claudePath: string
  prompt: string
  model: string
  maxTurns: number
  sessionId?: string
  mcpConfigPath?: string
  allowedTools?: string[]
}

/** Internal event from the CLI parser */
export type CliStreamEvent =
  | { type: 'content'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; name: string; input: unknown; toolCallId: string }
  | { type: 'done'; usage?: { inputTokens: number; outputTokens: number }; sessionId?: string }
  | { type: 'error'; message: string }
  | { type: 'session_init'; sessionId: string }

/**
 * Run Claude Code CLI and yield stream events
 */
export async function* runClaudeCode(options: ClaudeCliOptions): AsyncGenerator<CliStreamEvent, void, unknown> {
  // Dynamic import for Node.js modules (runs in Worker Thread)
  const { spawn, execSync } = await import('node:child_process')
  const { existsSync } = await import('node:fs')

  // Quick diagnostic: verify child_process works in this Worker Thread
  let childProcessWorks = false
  try {
    execSync('echo __cp_test__', { encoding: 'utf-8' })
    childProcessWorks = true
  } catch {
    // child_process doesn't work
  }

  if (!childProcessWorks) {
    yield {
      type: 'error',
      message: 'child_process is not available in this Worker Thread. Claude Code CLI requires child_process.spawn() support.',
    }
    return
  }

  // Resolve the full path to the claude binary
  const claudePath = resolveClaudePath(options.claudePath, execSync, existsSync)

  const isRoot = process.getuid ? process.getuid() === 0 : false

  const args: string[] = [
    '-p', options.prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--model', options.model,
    '--max-turns', String(options.maxTurns),
  ]

  // --dangerously-skip-permissions cannot be used as root
  if (!isRoot) {
    args.push('--dangerously-skip-permissions')
  }

  if (options.sessionId) {
    args.push('--resume', options.sessionId)
  }

  if (options.mcpConfigPath) {
    args.push('--mcp-config', options.mcpConfigPath)
  }

  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push('--allowedTools', ...options.allowedTools, 'mcp__stina-tools__*')
  }

  // Use /tmp as working directory (safe default inside containers)
  const cwd = '/tmp'

  // Remove CLAUDE_CODE_ENTRY_POINT to avoid blocking nested sessions
  const env = { ...process.env }
  delete env.CLAUDE_CODE_ENTRY_POINT

  // Collect stderr for error reporting
  let stderrOutput = ''

  let child
  try {
    child = spawn(claudePath, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    yield {
      type: 'error',
      message: `Failed to spawn claude CLI at "${claudePath}": ${error instanceof Error ? error.message : String(error)}`,
    }
    return
  }

  // Close stdin immediately — we pass everything via -p
  child.stdin.end()

  // Capture stderr
  child.stderr.on('data', (chunk: Buffer) => {
    stderrOutput += chunk.toString()
  })

  let sessionId: string | undefined
  let spawnError: Error | undefined

  // Create a promise to track process completion
  const exitPromise = new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code))
    child.on('error', (err) => {
      spawnError = err
      resolve(null)
    })
  })

  // Read stdout as NDJSON
  const stdoutIterator = readLines(child.stdout)

  try {
    for await (const line of stdoutIterator) {
      if (!line.trim()) continue

      let event: ClaudeEvent
      let rawEvent: Record<string, unknown>
      try {
        rawEvent = JSON.parse(line) as Record<string, unknown>
        event = rawEvent as unknown as ClaudeEvent
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
        // Full assistant message — extract text and tool use
        for (const block of event.message.content) {
          if (block.type === 'text') {
            yield { type: 'content', text: block.text }
          } else if (block.type === 'tool_use') {
            yield { type: 'tool_start', name: block.name, input: block.input, toolCallId: block.id }
          }
        }
      } else if (event.type === 'result') {
        // Log the full result event for debugging
        // (visible via context.log.debug in the provider)
        const resultAny = rawEvent
        if (event.is_error || (event.subtype && event.subtype !== 'success')) {
          const errorDetail = (resultAny['result'] as string)
            || (resultAny['error'] as string)
            || JSON.stringify(resultAny).slice(0, 500)
          yield {
            type: 'error',
            message: `Claude Code: ${errorDetail}`,
          }
          return
        }

        // If usage shows 0 tokens, something went wrong silently
        if (event.usage && event.usage.input_tokens === 0 && event.usage.output_tokens === 0) {
          const resultStr = JSON.stringify(resultAny)
          yield {
            type: 'error',
            message: `Claude Code returned empty result (0 tokens). Result: ${resultStr}${stderrOutput.trim() ? ` — stderr: ${stderrOutput.trim()}` : ''}`,
          }
          return
        }

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
      // Build a helpful error message
      const parts: string[] = []

      if (spawnError) {
        if ((spawnError as NodeJS.ErrnoException).code === 'ENOENT') {
          parts.push(`Claude CLI not found at "${claudePath}". Is it installed? PATH=${process.env.PATH ?? '(not set)'}`)
        } else {
          parts.push(`Spawn error: ${spawnError.message}`)
        }
      } else {
        parts.push(`Claude Code exited with code ${exitCode}`)
      }

      if (stderrOutput.trim()) {
        parts.push(`stderr: ${stderrOutput.trim().slice(0, 500)}`)
      }

      yield { type: 'error', message: parts.join(' — ') }
    }

  } catch (error) {
    yield {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Resolve the full path to the claude CLI binary.
 *
 * Worker Threads may not resolve PATH the same way as the shell,
 * so we try multiple strategies to find the binary.
 */
function resolveClaudePath(
  configuredPath: string,
  execSync: typeof import('node:child_process').execSync,
  existsSync: typeof import('node:fs').existsSync
): string {
  // If it's already an absolute path, use it directly
  if (configuredPath.startsWith('/') || configuredPath.includes('\\')) {
    return configuredPath
  }

  // Strategy 1: Try `which` / `where` to resolve from PATH
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const resolved = execSync(`${cmd} ${configuredPath}`, { encoding: 'utf-8' }).trim().split('\n')[0]
    if (resolved) return resolved
  } catch {
    // which failed, try other strategies
  }

  // Strategy 2: Check common installation paths
  const commonPaths = [
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    '/root/.npm-global/bin/claude',
    '/home/node/.npm-global/bin/claude',
  ]

  for (const p of commonPaths) {
    if (existsSync(p)) {
      return p
    }
  }

  // Fall back to the configured path and let spawn handle the error
  return configuredPath
}

/**
 * Escape a string for safe use in a POSIX shell command.
 * Wraps in single quotes and escapes embedded single quotes.
 */
function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`
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
