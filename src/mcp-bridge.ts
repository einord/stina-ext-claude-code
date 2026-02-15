/**
 * MCP Bridge for Stina Tools
 *
 * Creates a TCP relay server and MCP bridge script that allows
 * Claude Code to access tools registered by other Stina extensions.
 */

import type { ToolDefinition, ToolResult } from '@stina/extension-api/runtime'

/** ToolsAPI interface - matches what context.tools provides */
export interface ToolsBridge {
  list(): Promise<ToolDefinition[]>
  execute(toolId: string, params: Record<string, unknown>): Promise<ToolResult>
}

export interface ToolRelayServer {
  port: number
  close: () => void
}

/**
 * Start a TCP relay server that bridges tool calls
 */
export async function startToolRelay(
  tools: ToolsBridge,
  log: { info: (msg: string, data?: Record<string, unknown>) => void; error: (msg: string, data?: Record<string, unknown>) => void }
): Promise<ToolRelayServer> {
  const net = await import('node:net')

  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buffer = ''

      socket.on('data', (data) => {
        buffer += data.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim()) continue
          handleRelayMessage(line, socket, tools, log)
        }
      })

      socket.on('error', (err) => {
        log.error('TCP relay socket error', { error: err.message })
      })
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'))
        return
      }

      log.info('TCP tool relay started', { port: addr.port })
      resolve({
        port: addr.port,
        close: () => server.close(),
      })
    })

    server.on('error', reject)
  })
}

async function handleRelayMessage(
  line: string,
  socket: import('node:net').Socket,
  tools: ToolsBridge,
  log: { error: (msg: string, data?: Record<string, unknown>) => void }
): Promise<void> {
  try {
    const msg = JSON.parse(line) as { id: string; method: string; toolId: string; params: Record<string, unknown> }

    if (msg.method === 'execute') {
      const result = await tools.execute(msg.toolId, msg.params)
      socket.write(JSON.stringify({ id: msg.id, result }) + '\n')
    }
  } catch (error) {
    log.error('Relay message handling error', { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Generate MCP bridge script that Claude Code will run as an MCP server.
 * This script implements MCP JSON-RPC 2.0 over stdin/stdout and
 * forwards tool calls to the TCP relay.
 */
export function generateMcpBridgeScript(tools: ToolDefinition[], tcpPort: number): string {
  // Convert tools to MCP format
  const mcpTools = tools.map((t) => ({
    name: t.id,
    description: typeof t.description === 'string' ? t.description : (t.description as Record<string, string>).en || Object.values(t.description)[0] || '',
    inputSchema: t.parameters ? {
      type: 'object',
      properties: (t.parameters as Record<string, unknown>).properties || {},
      required: (t.parameters as Record<string, unknown>).required || [],
    } : { type: 'object', properties: {} },
  }))

  const toolsJson = JSON.stringify(mcpTools)

  return `
const net = require('net');
const readline = require('readline');

const TOOLS = ${toolsJson};
const TCP_PORT = ${tcpPort};

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\\n');
}

function callRelay(toolId, params) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(TCP_PORT, '127.0.0.1', () => {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
      client.write(JSON.stringify({ id, method: 'execute', toolId, params }) + '\\n');

      let buf = '';
      client.on('data', (data) => {
        buf += data.toString();
        const lines = buf.split('\\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const resp = JSON.parse(line);
            if (resp.id === id) {
              client.end();
              resolve(resp.result);
            }
          } catch {}
        }
      });
    });
    client.on('error', (err) => reject(err));
    setTimeout(() => { client.destroy(); reject(new Error('timeout')); }, 30000);
  });
}

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'stina-tools', version: '1.0.0' }
    }});
  } else if (msg.method === 'notifications/initialized') {
    // No response needed
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === 'tools/call') {
    try {
      const result = await callRelay(msg.params.name, msg.params.arguments || {});
      const text = result && result.data ? JSON.stringify(result.data) : (result && result.error ? result.error : 'OK');
      send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text }],
        isError: result && !result.success
      }});
    } catch (err) {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: err.message || 'Unknown error' }],
        isError: true
      }});
    }
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});
`.trim()
}

/**
 * Create an MCP config file for Claude Code
 */
export async function createMcpConfigFile(tools: ToolDefinition[], tcpPort: number): Promise<string> {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')

  const script = generateMcpBridgeScript(tools, tcpPort)

  // If script is short enough, use node -e
  // Otherwise write to temp file
  let command: string
  let args: string[]

  if (script.length < 100000) {
    command = 'node'
    args = ['-e', script]
  } else {
    const tmpFile = path.join(os.tmpdir(), `stina-mcp-bridge-${Date.now()}.cjs`)
    await fs.writeFile(tmpFile, script, 'utf-8')
    command = 'node'
    args = [tmpFile]
  }

  const config = {
    mcpServers: {
      'stina-tools': {
        command,
        args,
      },
    },
  }

  const configPath = path.join(os.tmpdir(), `stina-mcp-config-${Date.now()}.json`)
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')

  return configPath
}
