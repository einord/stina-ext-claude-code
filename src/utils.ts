import type { LocalizedString } from '@stina/extension-api'

/** Convert a LocalizedString to a plain string (English preferred) */
export function localizedStringToString(s: LocalizedString): string {
  if (typeof s === 'string') return s
  return s.en ?? Object.values(s)[0] ?? ''
}

/** Generate a random tool call ID */
export function generateToolCallId(): string {
  return `tc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}
