#!/usr/bin/env bash
#
# Sync Claude Code credentials from macOS Keychain to ~/.claude/.credentials.json
#
# On macOS, Claude Code stores OAuth tokens in the system Keychain rather than
# in files. Docker containers cannot access the host Keychain, so this script
# exports the credentials to ~/.claude/.credentials.json — the file-based
# format that Claude Code uses on Linux.
#
# Usage:
#   ./scripts/sync-claude-auth.sh
#
# After running this script, mount ~/.claude into your Docker container:
#   volumes:
#     - ${HOME}/.claude:/root/.claude:ro

set -euo pipefail

CREDENTIALS_FILE="$HOME/.claude/.credentials.json"

# Only needed on macOS
if [[ "$(uname)" != "Darwin" ]]; then
  echo "Not macOS — credentials are already file-based in ~/.claude/"
  echo "No action needed."
  exit 0
fi

# Check if Keychain entry exists (search by service name only, account varies per user)
if ! security find-generic-password -s "Claude Code-credentials" &>/dev/null; then
  echo "Error: No Claude Code credentials found in Keychain."
  echo "Make sure you are logged in: run 'claude' and complete the setup."
  exit 1
fi

# Extract the credential JSON from Keychain (-s = service name, -w = password only)
CRED_JSON=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)

if [[ -z "$CRED_JSON" ]]; then
  echo "Error: Could not read credentials from Keychain."
  exit 1
fi

# Validate it looks like valid JSON
if ! echo "$CRED_JSON" | python3 -m json.tool &>/dev/null; then
  echo "Error: Keychain data is not valid JSON."
  exit 1
fi

# Ensure ~/.claude directory exists
mkdir -p "$HOME/.claude"

# Write credentials file
echo "$CRED_JSON" > "$CREDENTIALS_FILE"
chmod 600 "$CREDENTIALS_FILE"

echo "Credentials exported to $CREDENTIALS_FILE"
echo "You can now start Docker with ~/.claude mounted."
