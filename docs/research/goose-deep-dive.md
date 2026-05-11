# Goose Deep Dive — Recipe Model & Architecture

**Date:** 2026-05-08
**Author:** Research agent (Conductor planning)
**Repo investigated:** `aaif-goose/goose` (formerly `block/goose`; transferred to the
Linux Foundation's Agentic AI Foundation in early 2026).
**Default branch:** `main`. Stars: ~44.8k. Primary language: Rust (with an Electron
TypeScript desktop UI).

> Scope: Confirm/expand the working theory that Goose **recipes** are the closest
> precedent for Conductor's "scenario-as-config drop-folder" model. Decide
> whether to adopt verbatim, fork, or invent.

---

## 1. Recipe schema & lifecycle

### 1.1 Authoritative source

The recipe schema is **defined in Rust source**, not as a published JSON Schema.
The URL `https://block.github.io/goose/schemas/recipe.json` returns 404 — there
is no standalone JSON Schema artifact. The canonical definition lives at:

- `crates/goose/src/recipe/mod.rs` (struct definitions, ~28 KB)
- `crates/goose/src/recipe/validate_recipe.rs` (validation rules)
- `crates/goose/src/recipe/local_recipes.rs` (disk discovery)
- `crates/goose/src/recipe/template_recipe.rs` (parameter substitution)
- `crates/goose/src/recipe/recipe_extension_adapter.rs` (extension type tagged enum)

Recipes are deserialized via `serde_yaml` / `serde_json`; schema documentation
is generated at build time by `utoipa::ToSchema` and exposed in `ui/desktop/openapi.json`.

### 1.2 Top-level Recipe struct (verbatim, from `crates/goose/src/recipe/mod.rs`)

```rust
pub struct Recipe {
    #[serde(default = "default_version")]
    pub version: String,                    // defaults to "1.0.0"
    pub title: String,                      // REQUIRED
    pub description: String,                // REQUIRED
    pub instructions: Option<String>,       // system-prompt-ish, multi-line
    pub prompt: Option<String>,             // user kickoff message
    pub extensions: Option<Vec<ExtensionConfig>>,
    pub settings: Option<Settings>,         // model/provider/temp/max_turns
    pub activities: Option<Vec<String>>,    // UI-only "suggestion bubbles"
    pub author: Option<Author>,             // contact + free-form metadata
    pub parameters: Option<Vec<RecipeParameter>>,
    pub response: Option<Response>,         // structured-output JSON schema
    pub sub_recipes: Option<Vec<SubRecipe>>,
    pub retry: Option<RetryConfig>,
}
```

### 1.3 Sub-structs

- `Author { contact?, metadata? }` — both free-form strings.
- `Settings { goose_provider?, goose_model?, temperature?, max_turns? }` —
  per-recipe overrides on global config. Note: `max_turns` is `usize`; absent =
  inherit global.
- `Response { json_schema? }` — opaque `serde_json::Value`. Validated with the
  `jsonschema` crate at recipe load time and applied to the agent's final
  output. This is Goose's structured-output story.
- `RecipeParameter { key, input_type, requirement, description, default?, options? }`
  - `input_type ∈ { string, number, boolean, date, file, select }`
  - `requirement ∈ { required, optional, user_prompt }`
  - **Hard-coded rule (validate_recipe.rs):** `file` parameters cannot have
    defaults — *"to avoid importing sensitive user files."*
  - **Hard-coded rule:** `optional` parameters MUST have a default; `required`
    parameters MUST NOT have one.
- `SubRecipe { name, path, values?, sequential_when_repeated, description? }` —
  see §1.6.
- `ExtensionConfig` — tagged enum (§2.2) with six variants.

### 1.4 Disk discovery (verbatim from `local_recipes.rs`)

`local_recipe_dirs()` walks, in this order, with canonicalize + dedupe:

1. Current working directory (`.`)
2. Paths from `GOOSE_RECIPE_PATH` env var (`;` on Windows, `:` on Unix)
3. `~/.config/goose/recipes/` (global library)
4. `./.goose/recipes/` (project-local — the conventional drop folder)
5. Legacy: `./.agents/recipes/`, `~/.agents/recipes/`
6. GitHub repo via `GOOSE_RECIPE_GITHUB_REPO=org/repo` (resolved via `gh` CLI)

When loading by name (no extension): tries `.yaml`, then `.json`, returns
first hit. If the input contains a path separator or extension, it is loaded
directly with no search.

### 1.5 Parameter substitution

- Engine: **MiniJinja** (Rust's Jinja2 port), not Handlebars or Mustache.
- Syntax: `{{ var }}`, with full Jinja control flow available
  (`{% if %}`, `{% for %}`, `{% extends %}`, `{% raw %}`).
- `UndefinedBehavior::Strict` — any reference to an undeclared parameter aborts
  rendering with `"Failed to render the recipe"`. No silent empty substitutions.
- Built-in: `{{ recipe_dir }}` — absolute path of the recipe file's directory.
  This is how recipes locate co-located scripts (the release_risk_check recipe
  in §5 uses `{{recipe_dir}}/release_risk_report.py`).
- Pre-pass: invalid identifier names get auto-wrapped in `{% raw %}` blocks to
  survive parsing. This is a footgun — see §7.2.

### 1.6 Composition (sub-recipes)

Sub-recipes are **first-class but limited**:

- A sub-recipe is invoked as a **tool** synthesized into the parent agent's
  toolset. The parent decides when to call it via tool-use; the sub-recipe is
  not a hard-coded step.
- Sub-recipes run in **fully isolated sessions** — fresh context, no shared
  conversation history, no memory passing.
- **Two parameter channels:**
  - `values: { key: val }` in the parent — fixed, highest priority.
  - Anything else — the parent agent extracts from conversation context and
    passes via tool args.
- **Sub-recipes cannot define their own sub_recipes** (one-level only).
- Parallel execution of multiple instances of the same sub-recipe is supported
  (`sequential_when_repeated: false` is default; set `true` to serialize).
- No `extends` / inheritance at the recipe level (Jinja `{% extends %}` is
  template-level only — for sharing prompt fragments, not full recipe shape).

### 1.7 Validation (`validate_recipe.rs`)

`validate_recipe_template_from_content()` checks, in order:

1. **Optional parameters** — must have defaults; `file` params can't.
2. **Template variables match parameters** — every `{{ var }}` in any rendered
   string must be either a declared parameter or `recipe_dir`. Any extras error
   out (no over-specification either).
3. **At least one of `instructions` / `prompt`** is non-empty.
   Error: *"Recipe must specify at least one of `instructions` or `prompt`."*
4. **Retry config** — `retry_config.validate()` (e.g. `max_retries > 0`).
5. **Response JSON schema** — `jsonschema::is_valid` on the schema document.

Validation is purely structural — it does not catch logical issues (e.g.
referencing an extension that isn't installed, or a `path` to a missing
sub-recipe; those fail at run time).

---

## 2. Recipe execution model

### 2.1 What `goose run --recipe foo.yaml` actually does

1. Resolve the recipe file via `local_recipe_dirs()` order.
2. Read, run MiniJinja template render against CLI-supplied params (`--params k=v`).
3. Deserialize into `Recipe`, run validators.
4. Build an agent session: load extensions from `recipe.extensions`, set
   provider/model/temperature/max_turns from `recipe.settings`, install
   sub-recipes as synthesized tools.
5. Seed the session with `instructions` (system prompt) and optionally fire
   the `prompt` as the first user message.
6. Stream the agent loop until: agent emits stop, `max_turns` reached, or
   user/cancel-token aborts. Output goes to stdout (CLI) or via SSE
   `MessageEvent` stream (server / desktop).
7. If `response.json_schema` is set, the final assistant turn is parsed and
   re-validated against the schema; non-conforming output triggers retry or error.
8. If `retry` is configured, after the agent stops, `checks: [{type: shell, command}]`
   are run; failure triggers another agent loop up to `max_retries`,
   optionally running `on_failure` shell command between attempts.

### 2.2 Extension specification (per-recipe tool allowlist)

`ExtensionConfig` is a tagged enum (`type:` discriminator). Six variants:

| `type:`           | Purpose                                                  | Key fields                                          |
| ----------------- | -------------------------------------------------------- | --------------------------------------------------- |
| `stdio`           | Spawn an MCP server as a child process                   | `cmd`, `args`, `env_keys`, `timeout`                |
| `builtin`         | Built-in MCP server bundled in `goose-mcp` crate         | `name`, `display_name?`, `timeout?`                 |
| `platform`        | In-process platform extension (developer, computer)      | `name`                                              |
| `streamable_http` | MCP over Streamable HTTP                                 | `uri`, `headers?`, `timeout?`                       |
| `frontend`        | Tools implemented by the calling client (desktop)        | `tools`, `instructions`                             |
| `inline_python`   | Embedded Python via `uvx`                                | `code`, `dependencies?`, `timeout?`                 |

All variants share `name`, `description?`, `bundled?`, `available_tools?`. The
last is the **per-recipe tool allowlist** — if set, only those tool names are
exposed to the model regardless of what the MCP server advertises.

If `extensions` is omitted from the recipe entirely, the agent inherits the
user's global enabled-extensions set. If `extensions: []` (empty array), the
desktop client strips it via `stripEmptyExtensions()` so it is treated as
"omitted" rather than "no extensions" — a backward-compat concession.

### 2.3 Multi-turn / stop conditions

- Hard cap: `settings.max_turns` (recipe override) or global default.
- Soft cap: agent emits a stop reason (`Finish` event with reason field).
- External: `cancellation_token` from the runner; `kill_running_job` for
  scheduled runs.
- No declarative DAG / no `steps:` array. A recipe is **one agent session**;
  multi-step orchestration happens inside the model via tool calls and
  sub-recipe invocations. (See §7.4 on why this bites.)

### 2.4 Outputs

Goose has **no first-class artifact directory**. Outputs are:
- The streamed `MessageEvent` log (consumed by CLI/desktop in real time).
- Whatever files/side-effects the agent produced through tools.
- The final structured response if `response.json_schema` is set (printed to
  stdout in CLI; available in the SSE `Finish` event for clients).
- Session transcripts persist in SQLite at `~/.local/share/goose/sessions.db`.

There is **no `outputs:` field** on the recipe — it is the caller's
responsibility to look at the working directory.

---

## 3. Recipe sharing & discovery

### 3.1 Channels

- **Files** — `.yaml` / `.json`, drop into any of the directories in §1.4.
- **Deeplinks** — `goose://recipe?config=<base64-compressed-yaml>`.
  Generated by `goose recipe deeplink <FILE> --param key=val` (CLI) or the
  desktop "Share" button. Decoded by `parseDeeplink()` in
  `ui/desktop/src/recipe/index.ts`. The desktop app registers the `goose://`
  URL scheme on install.
- **GitHub repo** — `GOOSE_RECIPE_GITHUB_REPO=org/repo` adds an org's repo as a
  search location. Resolved through `gh` CLI; the GitHub repo is just a tree
  of `.yaml` files, no special manifest.
- **Recipe Cookbook** — `documentation/src/pages/recipe-generator.tsx` is a
  static-site page that hosts a curated list of recipes and renders deeplinks.
  This is the closest thing to a "marketplace" but it is curated docs,
  **not a registry, not searchable, and not versioned**.

### 3.2 Versioning

The `version` field on the recipe is a free-form string; it is **not enforced
or compared**. There is no recipe API/contract version, no migration story.
Recipes from old releases just keep working because the schema has only ever
added fields.

### 3.3 Secrets

Recipes never embed secrets. The pattern is `env_keys: ["GITHUB_TOKEN"]` on
a `stdio` extension; the CLI prompts the user (or reads from env) at recipe
load time and forwards the value to the spawned MCP server's environment.
Deeplinks don't carry secrets — the recipient supplies their own at run time.

This is a clean design and worth copying as-is.

---

## 4. Scheduling, daemon mode, and "tasks"

### 4.1 Scheduler

Source: `crates/goose/src/scheduler.rs`, `scheduler_trait.rs`.
HTTP routes: `crates/goose-server/src/routes/schedule.rs`.

`Scheduler` exposes:

- `add_scheduled_job` / `remove_scheduled_job` / `list_scheduled_jobs`
- `update_schedule` (change cron)
- `run_now`, `pause_schedule`, `unpause_schedule`, `kill_running_job`
- `sessions(id)` — historical run records
- `get_running_job_info`

`ScheduledJob` (verbatim):

```rust
pub struct ScheduledJob {
    pub id: String,
    pub source: String,                          // recipe file path
    pub cron: String,
    pub last_run: Option<DateTime<Utc>>,
    pub currently_running: bool,
    pub paused: bool,
    pub current_session_id: Option<String>,
    pub process_start_time: Option<DateTime<Utc>>,
}
```

Cron format accepts both 5-field (`m h d M w`) and 6-field
(`s m h d M w`); 5-field is auto-promoted. Local timezone. Persisted as JSON
to a configurable path; loaded on startup; mutations sync back to disk.

**Endpoints (REST):** `/schedule/create`, `/schedule/list`, `/schedule/{id}`,
`/schedule/{id}/{pause|unpause|run_now|kill|inspect|sessions}`.

### 4.2 No "task queue" / "inbox" abstraction

There is **no Goose Hub, no inbox, no task queue, no event-driven trigger
system**. Cron is the only built-in trigger. "Do X when Y happens" is
expected to be wired up externally (e.g. webhook → `goose run --recipe`).
Schedule is implemented as an in-process tokio loop in `goose-server`.

### 4.3 MCP-server self-exposure

Goose does have an MCP exposure of its own state — via `mcp_app_proxy.rs` and
`mcp_ui_proxy.rs` server routes — but this is for routing tool calls between
nested agents/extensions, not for an external orchestrator querying Goose.
There is no documented "Goose-as-MCP-server" daemon mode that an external
agent could connect to as if it were a tool. It is theoretically possible
(any subset of state can be exposed via MCP), but not blessed.

---

## 5. Concrete recipe examples

### 5.1 Simple, single-extension (parameters omitted)

From `documentation/blog/2025-05-06-recipe-for-success/index.md`:

```yaml
version: 1.0.0
title: "404Portfolio"
description: "Create personalized, creative 404 pages using public profile data"

instructions: |
  Create an engaging 404 error page that tells a creative story using a user's
  recent public content from one of: GitHub, Dev.to, or Bluesky.
  ...
  Ask the user:
    1. Which platform to use
    2. Their username on that platform
  Then generate the complete code in a folder called 404-story.

activities:
  - "Build error page from GitHub repos"
  - "Generate error page from dev.to blog posts"
  - "Create a 404 page featuring Bluesky bio"

extensions:
  - type: builtin
    name: developer
  - type: builtin
    name: computercontroller
```

What the fields do: `instructions` becomes the agent's system message;
`activities` are the clickable suggestion bubbles in desktop UI;
`extensions` enables the bundled `developer` (file/shell) and
`computercontroller` (mouse/keyboard) MCP servers. No parameters — the
recipe asks the user inline. No `prompt` — the agent waits for first user msg.

### 5.2 Parameterized, multi-step, with embedded script

From `workflow_recipes/release_risk_check/recipe.yaml`:

```yaml
version: 1.0.0
title: "Release Change Risk Check"
description: "Create a report to access the change in an upcoming release"

instructions: |
  ## Step 1: Generate the heuristic report
  Run the script to collect PR data and do initial risk scoring:
  {{recipe_dir}}/release_risk_report.py --version {{version}} -o /tmp/release_report.md

  ## Step 2: AI review of MEDIUM and HIGH risk PRs
  Take the MEDIUM and HIGH risk PRs from the Step 1 report and feed them to an LLM
  with the following prompt:
  ---
  You are a release risk assessor for Goose, an open-source AI-powered CLI coding agent
  built in Rust with a React/Electron desktop UI.
  ### Architecture (most sensitive areas first)
  CRITICAL — changes here can bypass security or cause data loss:
    - Permission system (crates/goose/src/permission/) ...
    - Tool execution pipeline (crates/goose/src/agents/tool_execution.rs, agent.rs) ...
  HIGH — ...
  MEDIUM — ...
  ### Risk levels — assign ONE per PR: HIGH / MEDIUM / LOW
  ### Task
  For each PR below: 1. Assess risk, 2. Testing confidence, 3. Suggest testing steps
  Respond in this format: | PR | Heuristic | AI Risk | Reasoning | Concern | Testing |
  ---

  ## Step 3: Generate the final report
  Combine the outputs from Step 1 and Step 2 into a final report.

prompt: follow the instructions to generate the final report

parameters:
  - key: "version"
    input_type: string
    requirement: required
    description: "release version"

extensions:
  - type: platform
    name: developer
```

**Annotations.** `{{recipe_dir}}` is a built-in template var pointing at the
recipe's directory — that is how the YAML co-ships with `release_risk_report.py`.
`{{version}}` is the user-supplied parameter. Note that "Step 1/2/3" is *prose*,
not a DAG — the agent decides ordering. `prompt:` is a one-liner that just
kicks the agent. This is the canonical "long-form prompt with parameters and
co-located helper script" pattern.

### 5.3 Retry with shell checks (synthesized from docs + recipe-reference)

```yaml
version: 1.0.0
title: "Service Health Verifier"
description: "Verify a deployed service is healthy; retry up to 3x"
instructions: |
  Curl http://localhost:8080/health and report status. If unreachable,
  inspect docker logs to diagnose.
extensions:
  - type: builtin
    name: developer
retry:
  max_retries: 3
  timeout_seconds: 30
  checks:
    - type: shell
      command: "curl -f http://localhost:8080/health"
  on_failure: "docker compose restart api"
```

`checks` are run AFTER the agent loop completes; ALL checks must exit 0 to
declare success. `on_failure` is a single shell command run between retries.
There is no `on_success` hook.

### 5.4 Structured-output recipe (response.json_schema)

```yaml
version: 1.0.0
title: "PR Triage"
description: "Classify a PR as ready/blocked/needs-info"
instructions: |
  Read the PR description and diff, decide whether it is ready to merge.
parameters:
  - key: pr_url
    input_type: string
    requirement: required
    description: "URL of the PR to review"
prompt: "Triage {{pr_url}}"
extensions:
  - type: stdio
    name: github
    cmd: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env_keys: ["GITHUB_TOKEN"]
response:
  json_schema:
    type: object
    required: [verdict, reason]
    properties:
      verdict:
        type: string
        enum: [ready, blocked, needs_info]
      reason:
        type: string
      blocking_issues:
        type: array
        items: { type: string }
```

The agent's final turn is parsed and validated against `json_schema`; if it
doesn't conform, the orchestrator re-prompts. Combined with `retry`, this
gives a poor-man's "force the agent to a contract" loop.

### 5.5 Sub-recipe (composed pipeline, sequential)

```yaml
version: 1.0.0
title: "Code Review Pipeline"
description: "Security scan then quality check"
instructions: "Run security_scan, then quality_check on the same repo."
parameters:
  - key: repository_path
    input_type: string
    requirement: required
    description: "Path to the repo"
extensions:
  - type: builtin
    name: developer
sub_recipes:
  - name: security_scan
    path: ./recipes/security.yaml
    values:
      repository_path: "{{repository_path}}"
    sequential_when_repeated: true
  - name: quality_check
    path: ./recipes/quality.yaml
    values:
      repository_path: "{{repository_path}}"
```

Each sub-recipe becomes a tool call (`security_scan`, `quality_check`) on the
parent agent. The parent agent decides ordering and what to pass — Goose does
not enforce "security before quality." The `values:` block fixes
`repository_path` so the parent can't accidentally pass a different one.

---

## 6. CLI vs Desktop split

This is the most directly relevant architectural insight for Conductor.

### 6.1 The split

- `crates/goose-server` — Rust HTTP daemon built on **Axum**. Owns the agent
  loop, scheduler, recipe runtime, MCP extension manager, session DB.
- `crates/goose-cli` — Rust CLI. Used in two modes:
  - **Direct**: imports the `goose` crate, runs the agent in-process for
    one-shot `goose run` invocations. No server.
  - **Client**: speaks to a running `goose-server` over HTTP/SSE.
- `ui/desktop` — Electron + React. **Always a client** of `goose-server`.
  On launch it spawns `goose-server` as a child sidecar and connects.

### 6.2 IPC

- **Protocol: HTTP + Server-Sent Events (SSE)**, not WebSocket.
- The agent reply stream is `POST /reply` returning `text/event-stream` with
  JSON-encoded `MessageEvent`s (`Message`, `Error`, `Finish`, `Notification`,
  `UpdateConversation`, `ActiveRequests`, `Ping` heartbeat every 500ms).
  Source: `crates/goose-server/src/routes/reply.rs`.
- All other operations are plain JSON REST: `/recipes/list`, `/recipes/save`,
  `/recipes/encode`, `/recipes/decode`, `/recipes/parse`, `/recipes/scan`,
  `/recipes/schedule`, `/recipes/slash-command`, `/schedule/*`, etc.
- The OpenAPI spec is auto-generated (`utoipa`) and exported to
  `ui/desktop/openapi.json`; the desktop TS client is **codegen'd** from it
  (`ui/desktop/src/api/types.gen.ts`) — the desktop never hand-writes types.
- TLS is optional, configured via `Settings::tls`. For local dev the desktop
  uses HTTP on a localhost port chosen at runtime by the spawned server.

### 6.3 Why this matters for Conductor

TaskDock is Tauri + Node sidecar over WebSocket on port 5200. Goose is
Electron + Rust sidecar over HTTP+SSE. The two designs converge on the same
shape: **single source of truth in the sidecar, codegen'd typed client,
streaming for agent output.** Goose's choice of SSE over WS is deliberate —
it is one-way (agent → client), avoids WS framing complexity, plays nicely
with HTTP load balancers, and re-uses the standard Axum middleware stack.
For TaskDock's existing WS rig there is no need to switch, but: codegenning
the renderer's RPC types from a single OpenAPI/JSONSchema source (as Goose
does) is a worthwhile pattern to copy.

---

## 7. Honest assessment

### 7.1 Adopt verbatim, fork, or invent?

**Recommendation: fork the schema as a starting point; rename and extend.**

**Pros of forking Goose's schema:**

- It has been beaten on by 44k+ stars of users for ~18 months. The shape
  (`title`, `description`, `instructions`/`prompt`, `parameters`, `extensions`,
  `settings`, `sub_recipes`, `retry`, `response`) is the right minimum.
- The parameter typing (`required` / `optional` / `user_prompt`,
  `string|number|boolean|date|file|select`) covers Conductor's UI needs.
- The `env_keys` secrets pattern is correct and would take Conductor a week
  to re-derive.
- MiniJinja-style templating with strict-undefined is well-trodden.
- `response.json_schema` for structured output is exactly what we want for
  scenarios like "PR review verdict" or "incident severity classification."
- The deeplink pattern (`goose://recipe?config=<encoded>`) maps cleanly to a
  hypothetical `taskdock://scenario?config=` for sharing.

**Cons of adopting verbatim:**

- The name `recipe` is too generic. Conductor's noun should be `scenario`
  (matches existing terminology) or `playbook`. **This is a meaningful rename
  because schema-level fields like `goose_provider` and `goose_model` would
  carry the wrong brand.** Strip `goose_` prefixes; rename to
  `provider`/`model`.
- Goose conflates **recipe = single agent session**. Conductor's SDLC
  scenarios (epic decomposition, multi-PR review, incident triage) often
  legitimately need multi-stage state machines, not "one agent loop with
  sub-recipe tools." Adopting verbatim locks us in (see §7.4).
- The `activities` field is a UX-specific affordance for Goose desktop
  bubbles. Conductor's UI is different; this should be replaced with our
  own `suggestions` or dropped.
- **No formal versioning.** Goose's `version` field is documentation only.
  Conductor should commit to semver from day one and validate it.
- Sub-recipes have no shared memory. For SDLC where "incident triage"
  produces context that "incident remediation" needs, this is a real
  limitation that requires either parent-recipe-orchestration or a Conductor-
  specific state-passing mechanism.

**Recommendation specifics:**

- Take the field set 1:1, rename `recipe` → `scenario`, `goose_provider` →
  `provider`, `goose_model` → `model`, `instructions` → `system_prompt`
  (clearer), keep everything else.
- Keep MiniJinja syntax. Even if we use a JS template engine
  (handlebars/nunjucks), use the same `{{ var }}` and `{% %}` syntax so
  Goose recipes can be **mechanically migrated**.
- Keep `parameters` model and validation rules verbatim — including the
  "file params can't have defaults" rule.
- Keep `response.json_schema` verbatim — JSON Schema draft 2020-12.
- Keep `retry { max_retries, checks: [{type: shell, command}], on_failure,
  timeout_seconds }` verbatim.
- **Add `kind: pr_review | incident | epic | ...`** field at the top so
  Conductor can dispatch to scenario-type-specific UI / artifact sinks. Goose
  has no such field because it is generic.
- **Add `outputs:`** declarative section — Conductor knows scenarios produce
  artifacts (review markdown, incident postmortem) and the runtime should
  collect them. Goose has nothing here.
- **Add `state_machine:`** optional section for multi-stage scenarios; falls
  back to single-agent-session if absent. (This is the bend point — see §7.4.)

### 7.2 Goose footguns to avoid

1. **Schema defined only in Rust source.** No published JSON Schema means
   editor tooling and external validators can't catch errors. Conductor
   should publish a JSON Schema as the source of truth and codegen Rust/TS
   structs from it. Same OpenAPI codegen pattern Goose uses for its REST API,
   applied to the recipe shape itself.
2. **`stripEmptyExtensions()` backward-compat hack.** Because Goose blurred
   "extensions field omitted" with "extensions: []", a desktop client now
   has a hard-coded function to strip empty arrays. Decide on one semantic
   from day one: explicit empty array means **no extensions**, omitted means
   **inherit user defaults** — and validate it.
3. **`max_turns` confusion.** Recipe-level `max_turns` overrides global, but
   only if non-null. Combined with sub-recipes that inherit the *parent*
   context's max_turns rather than their own, this leads to surprising
   "agent stopped early" behavior. Conductor should make max-turns explicit
   per scenario kind, not a free knob.
4. **Single-agent-session-as-recipe** (see §7.4). Encoded deep into the
   runtime; multi-step scenarios fight the model.
5. **Free-form `version` string.** Drift problem: a recipe written against
   v1.0 of the schema and one written against v2.0 are indistinguishable.
6. **No artifact directory convention.** Users complain (e.g. issue #2560)
   that Goose can't tell them "where the output went." Conductor should
   carve out `<workspace>/.taskdock/runs/<run_id>/{logs, artifacts, output.json}`
   and have the runtime write there by default.
7. **MiniJinja's "auto-wrap invalid identifiers in `{% raw %}`" pre-pass** —
   this is silent fallback; an intended-as-template-but-malformed expression
   becomes a literal string with no warning. Conductor should reject such
   inputs explicitly.
8. **No central registry.** "Recipe Cookbook" is a curated docs page, not a
   versioned, signed package registry. Conductor likely doesn't need one
   in slices 1-15, but acknowledge the gap; a flat folder of `*.yaml` works
   until it doesn't.
9. **Structured output is best-effort.** `response.json_schema` validation
   happens after the fact — if the model produces non-conforming output,
   Goose reprompts but there's no contract guarantee. Combined with no
   `outputs:` channel, the calling automation has to parse the SSE stream.
10. **Sub-recipes parallel-by-default with `sequential_when_repeated: false`**
    — easy to get parallel API thrashing. Conductor should default to
    sequential and require explicit opt-in to parallel.

### 7.3 Goose architecture pieces worth borrowing (beyond recipes)

| Piece                                          | Borrow? | Notes                                                                                                                                                                  |
| ---------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAPI-codegen'd typed client                 | Yes     | Single source of truth for sidecar contract; auto-generated TS types in renderer. TaskDock's `src/shared/*-types.ts` is hand-written and drifts.                       |
| SSE for agent stream + JSON REST for everything else | Maybe   | TaskDock already has WS; SSE is technically a better fit for one-way streaming but switching cost likely not worth it now. Consider for a v2 rewrite.                  |
| ExtensionConfig tagged enum (6 variants)        | Yes     | Good model for "MCP server lifecycle" (stdio/http/builtin/inline-python/etc). Map directly onto TaskDock's plugin types.                                              |
| `available_tools` per-extension allowlist       | Yes     | Per-scenario tool restriction is a legit security boundary.                                                                                                            |
| Scheduler trait + cron + persisted JSON jobs    | Partial | Cron is fine but Conductor probably also wants event-triggers (PR opened, incident filed). Borrow the persistence model and `ScheduledJob` shape, extend with triggers.|
| Deeplink (`goose://recipe?config=...`)         | Yes     | Clean sharing primitive. `taskdock://scenario?config=` works the same.                                                                                                |
| Provider-abstraction layer (`crates/goose/src/providers`) | Maybe   | Goose supports 15+ providers; TaskDock is currently Anthropic+Copilot. The pattern (provider trait, per-provider adapters, cost/token tracking) is sound but heavy. |
| Sidecar-as-child-process model                 | Yes     | Already TaskDock's pattern. Confirms it.                                                                                                                              |
| Session SQLite DB                              | Yes     | Already TaskDock's pattern. Confirms it.                                                                                                                              |
| `recipe-scanner` security pre-flight           | Maybe   | Goose has a `/recipes/scan` route that flags dangerous shell commands and prompt-injection patterns in untrusted recipes. Worth borrowing if Conductor accepts user-uploaded scenarios. |

### 7.4 Where Goose's recipe model bends or breaks for Conductor's SDLC scenarios

**The fundamental gap:** Goose recipes are a *prompt-and-config bundle for a
single agent session*. Conductor's scenarios are *multi-stage workflows with
deterministic transitions and human checkpoints*.

Concrete failure modes if Conductor adopts Goose's model verbatim:

- **PR review.** Multiple stages: fetch diff → triage size → static analysis
  → AI review per file → aggregate verdict → post comments. Several stages
  are deterministic (fetch, post). Goose would model this as one big agent
  session with `instructions` describing all stages — works but the model
  has to "remember" which stage it is in, costs tokens, can skip steps.
  **Bend:** add a `state_machine:` section with optional explicit stages;
  use sub-recipes for each stage.
- **Incident triage.** Has hard human checkpoints ("ack severity?", "page
  owner?"). Goose has no checkpoint primitive. The agent would have to
  produce a structured response and the calling code halts. Workable but
  gappy. **Bend:** add a `checkpoint` activity type that pauses the runtime
  and surfaces a UI prompt.
- **Epic decomposition.** Naturally fan-out: one epic → N work items, each
  with N sub-tasks. Goose's sub-recipes-as-tools pattern works for fan-out
  but the parent context fills with sub-recipe results, blowing the context
  window. **Bend:** add a `fan_out:` directive that runs sub-recipes in
  parallel and only returns aggregated summaries to the parent, not full
  transcripts.
- **Long-running scenarios across days/sessions.** Goose's session is
  process-lifetime; recovering across a sidecar restart relies on session DB
  replay. For "epic in progress for 2 weeks" Conductor needs durable state
  separate from session transcripts. Goose has no equivalent.
- **Cross-scenario dependencies.** "PR review scenario triggers an
  incident-triage scenario when it spots a security issue." Goose has no
  inter-recipe communication — no event bus, no inbox, no triggers from
  scenarios to scenarios. Schedule-based cron is the only outbound
  mechanism. **Bend:** add a Conductor event bus the runtime emits to and
  scenarios can subscribe to.
- **Approval gates / dry-run mode.** Goose's permission system is per-tool
  ("ask before running shell"); Conductor likely wants per-stage ("preview
  the diff comments before posting"). Different abstraction level.

The summary: **Goose recipes are a 70% match for Conductor scenarios** —
adopting the schema, parameter model, extension model, and deeplink as a base
saves weeks. The remaining 30% (state machines, checkpoints, fan-out, cross-
scenario events, durable workflow state, approval gates) are Conductor-
specific and need to be layered on. They should be optional fields on the
schema so a "trivial" scenario stays as small as a Goose recipe and the
complex SDLC ones can opt in.

---

## Sources

Primary code (all under `https://github.com/aaif-goose/goose/blob/main/`):

- `crates/goose/src/recipe/mod.rs` — Recipe struct, sub-structs, enums.
- `crates/goose/src/recipe/validate_recipe.rs` — load-time validation.
- `crates/goose/src/recipe/local_recipes.rs` — disk discovery order.
- `crates/goose/src/recipe/template_recipe.rs` — MiniJinja substitution.
- `crates/goose/src/recipe/recipe_extension_adapter.rs` — extension tagged enum.
- `crates/goose/src/scheduler.rs`, `scheduler_trait.rs` — scheduler.
- `crates/goose-server/src/routes/recipe.rs` — recipe HTTP API.
- `crates/goose-server/src/routes/reply.rs` — SSE agent stream.
- `crates/goose-server/src/routes/schedule.rs` — schedule HTTP API.
- `crates/goose-server/src/commands/agent.rs` — server bind / TLS / port.
- `crates/goose-cli/src/commands/recipe.rs` — recipe CLI subcommands.
- `ui/desktop/src/recipe/index.ts` — deeplink encode/decode.
- `ui/desktop/src/api/types.gen.ts` — codegen'd client types.
- `ui/desktop/openapi.json` — generated REST contract.

Concrete recipe YAMLs:

- `https://github.com/aaif-goose/goose/blob/main/workflow_recipes/release_risk_check/recipe.yaml`
- `https://github.com/aaif-goose/goose/blob/main/documentation/blog/2025-05-06-recipe-for-success/index.md`
- `https://github.com/aaif-goose/goose/blob/main/recipe-scanner/base_recipe.yaml`
  (security-scanner recipe, not pasted — content is a meta-prompt so out of
  scope for this audit)

Documentation:

- `https://block.github.io/goose/docs/guides/recipes/recipe-reference/`
- `documentation/docs/guides/recipes/index.mdx`
- `documentation/docs/guides/recipes/storing-recipes.md`
- `documentation/docs/guides/recipes/subrecipes.md`
- `documentation/docs/guides/recipes/session-recipes.md`
- `documentation/docs/tutorials/headless-goose.md`

Items I could not authoritatively verify:

- The exact default port `goose-server` binds to in dev. The bind is
  `Settings::socket_addr()`, which reads from a config layer not surfaced in
  `commands/agent.rs`. Empirically reported as a runtime-chosen port the
  Electron host hands to the renderer, but I did not confirm with source.
- Whether `response.json_schema` triggers a hard agent retry on validation
  failure vs. a soft warning. Code path crosses `validate_recipe.rs` (load
  time) and the agent loop's structured-output enforcement, which I did not
  fully trace.
- Recipe Cookbook URL stability and whether it has a backing JSON index that
  Conductor could mirror.
