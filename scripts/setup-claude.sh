#!/usr/bin/env bash
# One-time setup per machine and per clone, for Claude Code + graphify.
# Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Checking prerequisites"
command -v python3 >/dev/null || { echo "python3 (3.10+) is required"; exit 1; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' || { echo "python3 must be 3.10+"; exit 1; }
command -v claude >/dev/null || echo "WARN: Claude Code CLI not found on PATH (install it from the official docs)"

echo "==> Installing graphify (PyPI package: graphifyy, CLI: graphify)"
if ! command -v graphify >/dev/null; then
  if command -v uv >/dev/null; then uv tool install graphifyy
  elif command -v pipx >/dev/null; then pipx install graphifyy
  else python3 -m pip install --user graphifyy; echo "If 'graphify' isn't found, add ~/.local/bin to PATH"; fi
fi
graphify install                      # registers the /graphify skill with Claude Code

echo "==> Wiring graphify into this repo"
graphify claude install               # adds a CLAUDE.md section + Glob/Grep PreToolUse hook in .claude/settings.json
graphify hook install                 # git post-commit / post-checkout hooks rebuild the code graph

echo "==> Making project hooks executable"
chmod +x .claude/hooks/*.py

cat <<'MSG'

Done. Next:
  1. Review and commit the changes graphify made to CLAUDE.md and .claude/settings.json.
     Note: graphify writes the absolute path of its binary into the hook commands. If teammates
     install graphify elsewhere, change that path to plain `graphify` before committing.
  2. Open Claude Code in this folder and run:  /graphify .
     (docs in docs/ are sent to the Claude API for extraction; code stays local)
  3. Check graphify-out/GRAPH_REPORT.md exists, then start work.
MSG
