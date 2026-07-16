#!/usr/bin/env bash
# dev-buddy userPromptSubmitted hook — prepends a "search skills first" hint
# to the user's prompt via `modifiedPrompt`.
#
# IMPORTANT (Copilot CLI 1.0.62 quirk): userPromptSubmitted hooks return
# `additionalContext` correctly in events.jsonl but the model never sees it.
# We use `modifiedPrompt` instead, which literally rewrites the user.message
# content. We always include the original prompt verbatim after the hint so
# the user's intent is preserved.
#
# Skips empty / whitespace-only / very short prompts (likely "yes" / "ok").

set -euo pipefail

input="$(cat)"
prompt="$(printf '%s' "$input" | jq -r '.prompt // ""' 2>/dev/null || echo "")"

trimmed="$(printf '%s' "$prompt" | tr -d '[:space:]')"
if [ -z "$trimmed" ] || [ "${#trimmed}" -lt 12 ]; then
  echo '{}'
  exit 0
fi

reminder='

<system-reminder>[[AUTO-LEARN]]</system-reminder>'

modified="$prompt$reminder"
jq -nc --arg p "$modified" '{modifiedPrompt: $p}'
