# Claude Code AI Provider for Stina

Connect Stina to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI for AI assistance with tool capabilities.

## Features

- **Streaming responses** — real-time text and thinking output from Claude
- **All Claude models** — Opus, Sonnet, and Haiku
- **Session resumption** — conversations persist across messages via `--resume`
- **Stina tools via MCP bridge** — exposes Stina tools (calendar, work manager, etc.) to Claude Code through a local MCP server
- **Subscription & API key support** — Claude Code CLI supports both Max/Pro subscriptions and API keys

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Stina >= 0.5.0

### Verify installation

```bash
claude --version
claude "hello"   # Should respond without errors
```

## Installation

Install the extension from the Stina extension manager, or manually:

1. Download the latest release from [GitHub Releases](https://github.com/einord/stina-ext-claude-code/releases)
2. Place the zip in your Stina extensions directory
3. Restart Stina

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| **Claude CLI Path** | Path to the `claude` executable | `claude` |
| **Max Turns** | Maximum tool-use turns per request | 25 |
| **Stina Tools** | Enable Stina tools via MCP bridge | On |

## How It Works

### CLI Integration

The extension spawns `claude -p <prompt> --output-format stream-json` and parses the NDJSON stream. Claude Code runs with `--dangerously-skip-permissions` to avoid interactive prompts.

### MCP Bridge

When "Stina Tools" is enabled, the extension:

1. Lists all tools registered by other Stina extensions (via `tools.list`)
2. Starts a local TCP relay server on `127.0.0.1` (random port)
3. Generates an MCP bridge script that implements the MCP JSON-RPC 2.0 protocol
4. Passes the MCP config to Claude Code via `--mcp-config`

This allows Claude Code to call Stina tools (e.g., checking your calendar, managing tasks) alongside its own built-in tools (file editing, bash, web search).

### Session Management

Each Stina conversation is mapped to a Claude Code session ID. Subsequent messages in the same conversation use `--resume` for continuity.

## Docker

Claude Code CLI must be available inside the container. Since it's a platform-specific binary, you cannot mount it from the host — it must be installed inside the container.

### Authentication

Claude Code supports two authentication methods, both work in Docker:

**Option A: Subscription login (Max/Pro)** — mount credentials from the host

**Option B: API key** — set the `ANTHROPIC_API_KEY` environment variable

You can use both at the same time. Claude Code will prefer the subscription login if credentials are present.

#### macOS — Export Keychain credentials

On macOS, Claude Code stores OAuth tokens in the system Keychain — not in files. Docker cannot access the host Keychain, so you need to export the credentials first:

```bash
./scripts/sync-claude-auth.sh
```

This exports your Keychain credentials to `~/.claude/.credentials.json`, which is the file-based format Claude Code uses on Linux. Run this once after logging in (or after token refresh).

#### Linux

No extra steps needed. Claude Code already stores credentials in `~/.claude/.credentials.json`.

#### Windows (WSL)

Run Claude Code inside WSL and authenticate there. The `~/.claude/` directory in WSL will contain the credentials file.

### Development (docker-compose)

```yaml
services:
  api:
    command: >
      sh -c "npm install -g @anthropic-ai/claude-code --silent 2>/dev/null;
             node apps/api/dist/index.js"
    environment:
      # Option B: API key (optional, works alongside subscription login)
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
    volumes:
      # Option A: Mount host credentials for subscription login
      - ${HOME}/.claude:/root/.claude
```

### Production (Dockerfile)

Add to your API Dockerfile:

```dockerfile
RUN npm install -g @anthropic-ai/claude-code
```

Then mount `~/.claude` for subscription login, set `ANTHROPIC_API_KEY`, or both.

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Type check
pnpm typecheck

# Lint
pnpm lint

# Watch mode
pnpm dev
```

### Local development with Stina

Link to the local `@stina/extension-api` package:

```json
{
  "devDependencies": {
    "@stina/extension-api": "link:../stina/packages/extension-api"
  }
}
```

## License

MIT
