/** System init event from Claude Code CLI */
export interface ClaudeSystemInitEvent {
  type: 'system'
  subtype: 'init'
  session_id: string
  model: string
  tools: string[]
}

/** Assistant message event */
export interface ClaudeAssistantEvent {
  type: 'assistant'
  message: {
    id: string
    type: 'message'
    role: 'assistant'
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      | { type: 'thinking'; thinking: string }
    >
    model: string
    stop_reason: string | null
  }
}

/** Result event (final) */
export interface ClaudeResultEvent {
  type: 'result'
  subtype: 'success' | 'error_max_turns' | 'error_unauthorized'
  session_id: string
  cost_usd: number
  is_error: boolean
  duration_ms: number
  duration_api_ms: number
  num_turns: number
  usage: {
    input_tokens: number
    output_tokens: number
  }
}

/** Stream delta event */
export interface ClaudeStreamEvent {
  type: 'content_block_delta'
  index: number
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'thinking_delta'; thinking: string }
}

/** Union of all Claude Code CLI events */
export type ClaudeEvent =
  | ClaudeSystemInitEvent
  | ClaudeAssistantEvent
  | ClaudeResultEvent
  | ClaudeStreamEvent
