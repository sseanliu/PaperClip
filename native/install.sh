#!/bin/sh
# Registers the Claude Code chat host (claude_host.py) with Chrome, so the
# PaperClip reader can open a Claude Code session about the paper on screen.
# Re-run after moving the repo. Usage: native/install.sh [extension-id]
set -e

HOST_NAME="com.xiaoan.paperclip.claude"
EXT_ID="${1:-jgkoofflfpbgafapakleppdjkknkpkmp}"
DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="$DIR/claude_host.py"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

chmod +x "$HOST_PATH"
mkdir -p "$MANIFEST_DIR"
cat > "$MANIFEST_DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "PaperClip: Claude Code chat about the open paper",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
echo "Registered $HOST_NAME -> $HOST_PATH (extension $EXT_ID)"
