/**
 * Claude Code AI Provider Extension for Stina
 *
 * Connects Stina to Claude Code CLI for AI assistance with tool capabilities.
 *
 * @module stina-ext-claude-code
 */

import { initializeExtension, type ExtensionContext, type Disposable } from '@stina/extension-api/runtime'

import { createClaudeCodeProvider } from './provider.js'

/**
 * Extension activation
 */
function activate(context: ExtensionContext): Disposable {
  if (!context.providers) {
    throw new Error('Extension requires provider registration capability')
  }

  context.log.info('Activating Claude Code provider extension')

  const provider = createClaudeCodeProvider(context)
  const disposable = context.providers.register(provider)

  context.log.info('Claude Code provider registered successfully')

  return disposable
}

/**
 * Extension deactivation
 */
function deactivate(): void {
  // Cleanup is handled by the disposable returned from activate
}

// Initialize the extension runtime
initializeExtension({ activate, deactivate })
