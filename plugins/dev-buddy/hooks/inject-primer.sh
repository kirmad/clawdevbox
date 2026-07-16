#!/usr/bin/env bash
# dev-buddy sessionStart hook — injects the clawdevbox primer as additionalContext.
#
# Gated to fire only when the session source is "startup" (a brand-new session).
# Skipping on "resume", "clear", and "compact" avoids re-loading the same primer
# every time the session is rehydrated.

set -euo pipefail

input="$(cat)"
source_val="$(printf '%s' "$input" | jq -r '.source // ""' 2>/dev/null || echo "")"

# Inject on every fresh session and on /clear; skip on resume and compact (already in context).
case "$source_val" in
  resume|compact)
    echo '{}'
    exit 0
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
primer_path="${SCRIPT_DIR}/primer.md"
if [ ! -f "$primer_path" ]; then
  echo '{}'
  exit 0
fi

primer="$(cat "$primer_path")"
bar="============================================================"
framed=$'\n'"$bar"$'\n[!] MANDATORY clawdevbox primer - apply every rule on every turn.\n'"$bar"$'\n\n'"$primer"

jq -nc --arg c "$framed" '{additionalContext: $c}'
