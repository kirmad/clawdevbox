# Team Memory Usage Guide

How agents discover teams, understand service ownership, and implement
cross-service features using the clawdevbox team memory vault.

---

## 1. Vault Architecture

Clawdevbox uses a **vault chain** — an ordered list of git-backed
knowledge bases that agents search leaf→root (personal first, then team).

```
~/.clawdevbox/config.json
  └─ vaults: [
       { id: "personal", path: "~/.clawdevbox/personal-vault", kind: "personal" },
       { id: "team-vault", path: "C:\\git\\team-vault", kind: "team", remote: "git@..." }
     ]
```

Each vault is a standalone git repo with this structure:

```
<vault>/
├── vault.yaml                     # id, title, tier_label, description
├── README.md
├── memories/
│   ├── _general/                   # cross-project knowledge
│   │   ├── memories/               # atomic facts (*.md + .events/*.jsonl)
│   │   ├── lessons/                # confidence-scored heuristics
│   │   ├── sessions/               # session summaries
│   │   └── wiki/                   # curated docs / how-tos
│   ├── <project-slug>/             # project-specific partition
│   │   ├── memories/
│   │   ├── lessons/
│   │   ├── sessions/
│   │   └── wiki/
│   └── <another-project>/
├── recipes/                        # shared recipe templates
├── skills/                         # shared skills (plugin-loadable)
├── trigger-types/                  # shared trigger templates
└── .claude-plugin/plugin.json      # plugin manifest for auto-discovery
```

### Vault types

| Kind | Scope | Git remote | Typical path |
|------|-------|-----------|--------------|
| `personal` | One user's private knowledge | Optional (backup) | `~/.clawdevbox/personal-vault/` |
| `team` | Shared across team members | Required (sync) | `C:\git\team-vault/` or cloned from org repo |

### How agents find vaults

1. `loadVaultChain(config.vaults)` → ordered `VaultInfo[]`
2. Memory tools resolve by `scope` parameter:
   - `scope: "personal"` → first vault with `kind === "personal"`
   - `scope: "team"` → first vault with `kind === "team"`
   - `scope: "all"` → search all vaults
3. Explicit `vault_id` overrides scope resolution

---

## 2. Repo Structure for Team Knowledge

The team vault should be organized to help agents discover and navigate
the organization's services. Recommended structure:

```
team-vault/
├── vault.yaml
├── memories/
│   ├── _general/
│   │   ├── wiki/
│   │   │   ├── org-overview.md          # org structure, team list, contacts
│   │   │   ├── service-catalog.md       # all services with ownership
│   │   │   ├── architecture-overview.md # system architecture diagram
│   │   │   └── onboarding.md
│   │   └── memories/
│   │       ├── 2026-06-17-team-structure.md
│   │       └── 2026-06-17-deployment-process.md
│   │
│   ├── <service-name>/               # one partition per service
│   │   ├── wiki/
│   │   │   ├── README.md             # what is this service, who owns it
│   │   │   ├── architecture.md       # service architecture
│   │   │   ├── api-contracts.md      # API surface, schemas, endpoints
│   │   │   ├── dependencies.md       # upstream/downstream services
│   │   │   ├── deployment.md         # how to deploy, feature flags, ECS config
│   │   │   └── runbook.md            # on-call, incident response
│   │   ├── memories/                 # atomic facts about this service
│   │   ├── lessons/                  # heuristics learned from incidents/PRs
│   │   └── sessions/                 # summaries of past agent work on this service
│   │
│   ├── teams-scheduler/
│   │   ├── wiki/
│   │   │   ├── README.md
│   │   │   ├── architecture.md
│   │   │   ├── dependencies.md       # depends on: conversation-service, ECS, ...
│   │   │   └── ecs-config.md
│   │   └── memories/
│   │
│   ├── conversation-service/
│   │   ├── wiki/
│   │   └── memories/
│   │
│   └── meeting-service/
│       ├── wiki/
│       └── memories/
│
├── recipes/                         # team-shared recipes
│   └── implement-work-item.yaml
├── skills/                          # team-shared skills
│   └── triage-incident/SKILL.md
└── trigger-types/
    └── daily-standup/template.yaml
```

### Key documents

#### `_general/wiki/service-catalog.md`

The master index. Every service the team owns:

```markdown
---
title: Service Catalog
scope: team
updated_at: 2026-06-17
---

# Service Catalog

## Services

### SampleScheduler
- **Repo:** https://myorg.visualstudio.com/myproject/_git/SampleService
- **Path in repo:** SampleService/Scheduler/SampleScheduler/
- **Owners:** @alice, @bob
- **ADO Area Path:** myproject\SampleService\Scheduler
- **Description:** Schedules Teams meetings, handles calendar sync, backfill, DLQ
- **Dependencies:** ChatService, ECS, Metrics, Cosmos
- **ECS namespace:** SampleScheduler
- **Deploy:** EV2 + feature flags via ECS

### ChatService
- **Repo:** https://myorg.visualstudio.com/myproject/_git/ChatService
- **Path in repo:** ChatService/
- **Owners:** @charlie, @dave
- **Dependencies:** Cosmos, ServiceBus, Redis
- ...
```

#### `<service>/wiki/dependencies.md`

Per-service dependency map:

```markdown
---
title: SampleScheduler Dependencies
service: teams-scheduler
---

# Dependencies

## Upstream (services that call us)
- **Teams Client** — schedules meetings via Graph API
- **Teams Admin** — bulk operations

## Downstream (services we call)
- **ChatService** — chat thread creation, roster management
- **ECS** — feature flags and configuration
- **Metrics** — telemetry and alerting
- **Cosmos** — persistent storage

## Shared infrastructure
- **ServiceBus** — async message processing (backfill, DLQ)
- **Redis** — caching
```

---

## 3. How Agents Discover Teams & Services

When an agent needs to understand the organization:

### Step 1: Search team memory

```
search_memory({ query: "service catalog", scope: "team" })
```

This returns the service-catalog wiki page if it exists.

### Step 2: Browse wiki index

```
get_wiki_index({ scope: "team" })
```

Returns the full wiki tree across all projects in the team vault.
The agent sees project partitions (`teams-scheduler/`, `conversation-service/`)
as top-level entries.

### Step 3: Read service details

```
get_memory({ path: "memories/teams-scheduler/wiki/README.md", scope: "team" })
get_memory({ path: "memories/teams-scheduler/wiki/dependencies.md", scope: "team" })
```

### Step 4: Search for specific knowledge

```
search_memory({ query: "backfill queue handler", scope: "team" })
search_memory({ query: "ECS configuration for scheduling", scope: "team" })
```

The QMD search engine indexes all vault content and returns ranked results.

---

## 4. Given a Feature Request → Find Involved Services

When the user describes a feature (e.g., "add support for co-organizer
in town halls"), the agent follows this discovery chain:

### 1. Parse the feature into domain concepts

Extract key terms: "co-organizer", "town hall", "meeting roles"

### 2. Search team memory for those concepts

```
search_memory({ query: "co-organizer town hall", scope: "team" })
search_memory({ query: "meeting roles", scope: "team" })
```

### 3. Read the service catalog

```
get_memory({ path: "memories/_general/wiki/service-catalog.md", scope: "team" })
```

Scan for services that handle the relevant domain.

### 4. Read dependency maps for candidate services

```
get_memory({ path: "memories/teams-scheduler/wiki/dependencies.md", scope: "team" })
get_memory({ path: "memories/conversation-service/wiki/dependencies.md", scope: "team" })
```

### 5. Check past work

```
search_memory({ query: "co-organizer", scope: "all" })
```

Look for personal memories from past sessions that touched this area.

### 6. Build the service impact map

Agent produces:
```
Feature: "Add co-organizer to town halls"
Services involved:
  1. SampleScheduler — meeting creation, role assignment (PRIMARY)
  2. ChatService — chat thread permissions for co-organizer
  3. ECS — feature flag for gradual rollout
  4. Meeting policies — MeetingPolicy.ExternalBotPolicy check
```

### 7. For each service → check repo structure

The agent reads the service's repo path from the catalog, then explores:

```bash
# Clone or navigate to the repo
cd C:\git\ts  # SampleScheduler repo

# Find relevant code
grep -r "CoOrganizer\|co.organizer" --include="*.cs" -l
grep -r "MeetingRole" --include="*.cs" -l
```

### 8. Create implementation plan

Using the service impact map and code exploration, the agent creates
a cross-service implementation plan with work items per service.

---

## 5. Keeping Team Memory Current

### Automated sync

The `memory-vault-sync` skill + `memory-sync` trigger runs daily:
- Commits local changes (agent reviews diff, writes meaningful message)
- Fetches from remote, audits incoming with 3-subagent consensus
- Pulls safe changes, blocks suspicious ones via inbox
- Pushes local commits to share with team

### Agent contributions

Agents automatically write to team memory when they:
- Discover a new architectural fact (`add_memory`, scope: team)
- Learn a heuristic from a PR review (`add_lesson`, scope: team)
- Complete a session with learnings (`add_session_summary`, scope: team)
- Build documentation (`add_wiki_page`, scope: team)

### Human contributions

Team members can:
- Edit markdown files directly in the vault repo
- Push via git (the sync trigger will pull for others)
- Add memories via the clawdevbox UI or agent chat

---

## 6. Bootstrapping a Team Vault

### For a new team

```bash
# 1. Create the repo
mkdir team-vault && cd team-vault
git init

# 2. Create vault.yaml
cat > vault.yaml << 'EOF'
id: team-vault
title: My Team Vault
description: Shared knowledge base for the team
tier_label: team
EOF

# 3. Create the directory structure
mkdir -p memories/_general/{memories,lessons,sessions,wiki}
mkdir -p memories/_general/wiki

# 4. Write the service catalog
# (use the template from Section 2 above)

# 5. Create per-service partitions
for svc in teams-scheduler conversation-service meeting-service; do
  mkdir -p memories/$svc/{memories,lessons,sessions,wiki}
done

# 6. Initial commit
git add -A && git commit -m "initial: team vault structure"

# 7. Push to remote
git remote add origin git@github.com:org/team-vault.git
git push -u origin main
```

### Register in clawdevbox config

Add to `~/.clawdevbox/config.json`:

```json
{
  "vaults": [
    { "id": "personal", "path": "~/.clawdevbox/personal-vault", "kind": "personal", "remote": null },
    { "id": "team-vault", "path": "C:\\git\\team-vault", "kind": "team", "remote": "git@github.com:org/team-vault.git" }
  ]
}
```

Or run `clawdevbox init` and follow the vault setup wizard.

### Populate with initial knowledge

Ask the agent:
> "Read through our repos and populate the team vault with service
> descriptions, architecture overviews, and dependency maps."

The agent will:
1. Read the service catalog (or ask you to list services)
2. For each service, explore the repo and write wiki pages
3. Commit to the team vault

---

## 7. MCP Tools Reference

| Tool | Purpose |
|------|---------|
| `add_memory` | Write an atomic fact (scope: personal/team) |
| `add_lesson` | Write a confidence-scored heuristic |
| `add_session_summary` | Summarize a work session |
| `add_wiki_page` | Write/update a curated wiki document |
| `update_wiki` | Patch an existing wiki page |
| `search_memory` | Full-text + semantic search across vaults |
| `get_memory` | Read a specific memory file by path |
| `get_wiki_index` | Browse the wiki tree structure |
| `get_lessons` | Get top lessons for a project |
| `vote_memory` | Upvote/downvote a memory |
| `memory_status` | Check vault git state + index health |
| `memory_sync` | Trigger manual vault sync |
