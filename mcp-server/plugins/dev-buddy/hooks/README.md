# dev-buddy hooks

Two Copilot CLI hooks that fire from the dev-buddy plugin:

| Hook | Event | Purpose |
|---|---|---|
| **Primer** | `sessionStart` | Injects the mandatory clawdevbox primer (`primer.md`) as `additionalContext` on every fresh session. |
| **Skill-search reminder** | `userPromptSubmitted` | Prepends a short directive to every user prompt (via `modifiedPrompt`) reminding the agent to search the skill catalog before answering. |

Both ship in the same `dev-buddy-primer.hook.json` config file — installing one installs both.

## Files

| File | Purpose |
|---|---|
| `primer.md`                        | Body of the sessionStart primer. Edit to change what gets injected at session start. |
| `inject-primer.sh` / `.ps1`        | Stdin → stdout filters for the `sessionStart` hook. Gate by `source` (skip resume/compact), wrap `primer.md` in MANDATORY framing, emit `{ additionalContext }`. |
| `inject-skill-hint.sh` / `.ps1`    | Stdin → stdout filters for the `userPromptSubmitted` hook. Read the user's prompt, prepend a skill-search hint, emit `{ modifiedPrompt }`. |
| `dev-buddy-primer.hook.json`       | The Copilot CLI hook config registering both scripts. |

## Important Copilot CLI quirks (v1.0.62)

1. **User-scope hooks load from `~/.copilot/hooks/*.json`** — *not* `~/.copilot/config/hooks/`. The bundled loader resolves `path.join(homedir(), ".copilot", "hooks")` regardless of what the source path looks like.
2. **`sessionStart` `source` is `"new"` for non-interactive `-p` sessions**, not `"startup"`. The scripts here gate by exclusion (`resume`, `compact`) so this is handled.
3. **`userPromptSubmitted` `additionalContext` is silently dropped** before reaching the model. Use `modifiedPrompt` instead and include the original prompt verbatim after a delimiter (this is what `inject-skill-hint.{sh,ps1}` does). Confirmed via shibboleth test: a unique token returned in `additionalContext` never reaches the model; the same token returned in `modifiedPrompt` literally becomes the user.message content.
4. **`sessionStart` `success` may show `False` due to a known Copilot CLI bug** where errors from other plugin hooks (e.g. `understand-anything`, `superpowers`) get attributed to the wrong `hookInvocationId`. The hook's `output` is still delivered; the false flag is cosmetic. Confirmed: a shibboleth in the primer was quoted by the agent despite `success=False`.

## Install (one-time, per machine)

Copilot CLI loads user-scope hooks from **`~/.copilot/hooks/*.json`**. Junction
this plugin's hook config into that directory so edits land live:

### Windows (PowerShell, Developer Mode enabled OR run as Administrator)

```powershell
$UserHooks = Join-Path $env:USERPROFILE '.copilot\hooks'
if (-not (Test-Path $UserHooks)) { New-Item -ItemType Directory -Path $UserHooks -Force | Out-Null }

$target = Join-Path $env:USERPROFILE '.clawdevbox\plugins\dev-buddy\hooks\dev-buddy-primer.hook.json'
$link   = Join-Path $UserHooks 'dev-buddy-primer.json'

if (Test-Path $link) { Remove-Item $link }
New-Item -ItemType SymbolicLink -Path $link -Target $target | Out-Null
```

### macOS / Linux

```bash
mkdir -p ~/.copilot/hooks
ln -sf ~/.clawdevbox/plugins/dev-buddy/hooks/dev-buddy-primer.hook.json \
       ~/.copilot/hooks/dev-buddy-primer.json
```

## Verify

```powershell
# Smoke-test each script standalone with a mock payload:
'{"source":"new","sessionId":"test","timestamp":1,"cwd":"."}' |
  powershell -NoProfile -File ~/.clawdevbox/plugins/dev-buddy/hooks/inject-primer.ps1 |
  ConvertFrom-Json | Select-Object -ExpandProperty additionalContext | Select-Object -First 3

'{"sessionId":"test","timestamp":1,"cwd":".","prompt":"Add a factorial function"}' |
  powershell -NoProfile -File ~/.clawdevbox/plugins/dev-buddy/hooks/inject-skill-hint.ps1 |
  ConvertFrom-Json | Select-Object -ExpandProperty modifiedPrompt | Select-Object -First 3

# End-to-end test: in a fresh copilot session, the agent should know
# clawdevbox tool conventions (list_tools, get_lessons, skill.list, recipe.list).
copilot -p "Without using any tools, list the EXACT tool name to call first for memory, skills, and recipes in clawdevbox" --allow-all-tools
```

## Uninstall

```powershell
Remove-Item (Join-Path $env:USERPROFILE '.copilot\hooks\dev-buddy-primer.json')
```

## Notes

- Both hooks fire from user scope (`~/.copilot/hooks/`) so they apply to **every** Copilot CLI session on this machine, not just sessions launched through clawdevbox. If you want to scope per-repo, move the JSON into `<repo>/.github/hooks/` instead.
- The skill-hint hook **rewrites the user prompt** with `modifiedPrompt`. The original prompt is always preserved verbatim after a `---USER PROMPT BELOW---` delimiter line, so the agent still sees what the user actually typed.
- Skipped on prompts < 12 non-whitespace characters (saves token cost on "yes" / "ok" / "continue").
