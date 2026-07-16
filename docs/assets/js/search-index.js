/* ClawDevbox docs — client-side search index.
   Each entry: t=title, u=url(+anchor), g=group, d=keywords/summary. */
window.SEARCH_INDEX = [
  // --- Pages ---
  { t: "Home", u: "index.html", g: "Introduction", d: "overview what is clawdevbox conductor agents developers" },
  { t: "Getting Started", u: "getting-started.html", g: "Introduction", d: "install init npm clawdevbox mcp start service demos quick start" },
  { t: "Architecture", u: "architecture.html", g: "Introduction", d: "kernel sqlite mcp server pty node-pty conpty sidecar the inversion" },
  { t: "Core Concepts", u: "concepts.html", g: "Introduction", d: "glossary recipe skill trigger plugin workspace artifact inbox thread approval scope session memory" },
  { t: "Recipes", u: "recipes.html", g: "Building Blocks", d: "yaml multi-step pipeline template instance steps validation gates lanes" },
  { t: "Triggers", u: "triggers.html", g: "Building Blocks", d: "cron webhook manual trigger type registered instance envelope daemon" },
  { t: "Skills", u: "skills.html", g: "Building Blocks", d: "markdown frontmatter procedural knowledge how feedback promotion" },
  { t: "Memory", u: "memory.html", g: "Building Blocks", d: "fact lesson wiki vault personal team recall record vote search_memory" },
  { t: "Artifacts & Renderers", u: "artifacts.html", g: "Building Blocks", d: "manifest markdown pr-review walkthrough renderer viewer view_url" },
  { t: "Inbox & Workflow", u: "inbox.html", g: "Building Blocks", d: "inbox item thread message approval notify ui question session" },
  { t: "Agent Sessions", u: "sessions.html", g: "Building Blocks", d: "pty terminal tmux copilot claude provider daemon session viewer" },
  { t: "Plugins", u: "plugins.html", g: "Extend & Integrate", d: "manifest install git marketplace hostable tools scope shadowing" },
  { t: "Extensibility", u: "extensibility.html", g: "Extend & Integrate", d: "hostable tools custom renderer cli provider trigger template extend" },
  { t: "MCP Tools Reference", u: "mcp-tools.html", g: "Extend & Integrate", d: "114 tools catalog namespaces list_tools learn_tool run_tool" },

  // --- Getting Started sections ---
  { t: "clawdevbox init", u: "getting-started.html#install-and-set-up", g: "Getting Started", d: "install scope global project config plugin" },
  { t: "Run modes: mcp / start / service", u: "getting-started.html#running-the-server", g: "Getting Started", d: "clawdevbox mcp start service status stop stdio http" },
  { t: "Background service (auto-start)", u: "getting-started.html#running-the-server", g: "Getting Started", d: "schtasks launchd systemd auto start login service.json" },
  { t: "Demos & verification", u: "getting-started.html#demos-you-can-run", g: "Getting Started", d: "demo-terminal-view demo-agency-interactive walkthrough pr-review e2e" },

  // --- Architecture ---
  { t: "The key inversion", u: "architecture.html#the-key-inversion", g: "Architecture", d: "sidecar does not run agent loop cli does" },
  { t: "The Kernel (SQLite)", u: "architecture.html#the-kernel", g: "Architecture", d: "single sqlite file six tables inbox threads messages triggers approvals artifacts" },
  { t: "The MCP surface", u: "architecture.html#the-mcp-surface", g: "Architecture", d: "streamable http bearer token verbs resources notifications" },
  { t: "Install modes", u: "architecture.html#install-modes", g: "Architecture", d: "global project config scope" },
  { t: "Security model", u: "architecture.html#security-model", g: "Architecture", d: "bearer secret scrub pii approval nonce timeout" },

  // --- Concepts (glossary terms) ---
  { t: "Recipe (concept)", u: "concepts.html#recipe", g: "Glossary", d: "what to do taskdock yaml starting point" },
  { t: "Skill (concept)", u: "concepts.html#skill", g: "Glossary", d: "how procedural markdown frontmatter" },
  { t: "Trigger type vs registered", u: "concepts.html#trigger", g: "Glossary", d: "capability instance cron" },
  { t: "Plugin (concept)", u: "concepts.html#plugin", g: "Glossary", d: "bundle recipes skills triggers tools renderers" },
  { t: "Workspace (concept)", u: "concepts.html#workspace", g: "Glossary", d: "isolated directory .clawdevbox artifacts" },
  { t: "Artifact (concept)", u: "concepts.html#artifact", g: "Glossary", d: "folder manifest renderer" },
  { t: "Hostable tool (concept)", u: "concepts.html#hostable-tool", g: "Glossary", d: "single file typescript mcp tool" },
  { t: "Scope & shadowing", u: "concepts.html#scope", g: "Glossary", d: "project plugin global shadow" },

  // --- Recipes ---
  { t: "Recipe body shape", u: "recipes.html#recipe-shape", g: "Recipes", d: "id name description kind default_client mcp_servers steps" },
  { t: "Recipe step shape", u: "recipes.html#step-shape", g: "Recipes", d: "id goal ai_instructions depends params artifacts triggers required" },
  { t: "Recipe validation gates", u: "recipes.html#validation-gates", g: "Recipes", d: "step status machine in_progress done failed skipped lanes" },
  { t: "recipe.template.upsert", u: "recipes.html#recipe-tools", g: "Recipes", d: "author recipe template" },
  { t: "recipe.instance.begin", u: "recipes.html#recipe-tools", g: "Recipes", d: "start a recipe run instance" },
  { t: "recipe.steps.update_status", u: "recipes.html#recipe-tools", g: "Recipes", d: "advance a recipe step status" },

  // --- Triggers ---
  { t: "Trigger envelope contract", u: "triggers.html#envelope", g: "Triggers", d: "stdin json state stdout output_dir dispatch_url spawn_url fire secret" },
  { t: "Firing modes", u: "triggers.html#firing-modes", g: "Triggers", d: "cron webhook manual test" },
  { t: "trigger.instance.register", u: "triggers.html#trigger-tools", g: "Triggers", d: "register a trigger instance params cron" },
  { t: "trigger.template.create", u: "triggers.html#authoring", g: "Triggers", d: "author a trigger type template" },
  { t: "authoring-triggers skill", u: "triggers.html#authoring", g: "Triggers", d: "prerequisite skill envelope contract" },

  // --- Skills ---
  { t: "Skill frontmatter", u: "skills.html#frontmatter", g: "Skills", d: "name description required yaml" },
  { t: "Skill feedback & promotion", u: "skills.html#feedback-promotion", g: "Skills", d: "score_30d uses_30d promote demote project global" },
  { t: "skill.upsert", u: "skills.html#skill-tools", g: "Skills", d: "author a skill" },

  // --- Memory ---
  { t: "Facts", u: "memory.html#facts", g: "Memory", d: "atomic citations reason add_fact get_fact vote_fact" },
  { t: "Lessons", u: "memory.html#lessons", g: "Memory", d: "confidence decay heuristic add_lesson get_lessons" },
  { t: "Wiki", u: "memory.html#wiki", g: "Memory", d: "curated docs upsert_wiki get_wiki_index" },
  { t: "Vaults (personal / team)", u: "memory.html#vaults", g: "Memory", d: "git sync scope personal team all" },
  { t: "Recall → record → vote", u: "memory.html#the-loop", g: "Memory", d: "search_memory before deriving" },

  // --- Artifacts ---
  { t: "markdown renderer", u: "artifacts.html#built-in-renderers", g: "Artifacts", d: "content.md mermaid highlight" },
  { t: "pr-review renderer", u: "artifacts.html#built-in-renderers", g: "Artifacts", d: "review.json diffs file tree comments" },
  { t: "walkthrough renderer", u: "artifacts.html#built-in-renderers", g: "Artifacts", d: "walkthrough.json code overlay steps" },
  { t: "Custom renderer (.mjs)", u: "artifacts.html#custom-renderers", g: "Artifacts", d: "renderer.write workspace plugin resolution chain" },
  { t: "artifact.add", u: "artifacts.html#artifact-tools", g: "Artifacts", d: "register artifact view_url share_url" },

  // --- Inbox ---
  { t: "inbox.upsert", u: "inbox.html#inbox-tools", g: "Inbox", d: "create update item question session id" },
  { t: "Ask the user a question", u: "inbox.html#asking-questions", g: "Inbox", d: "inbox.upsert questions session approval" },
  { t: "Approval round-trip", u: "inbox.html#approvals", g: "Inbox", d: "approval.request approval.resolve awaiting_user" },

  // --- Sessions ---
  { t: "Providers (copilot / claude)", u: "sessions.html#providers", g: "Sessions", d: "agent cli echo-stub agency extensibility spawnSession" },
  { t: "tmux CLI sessions", u: "sessions.html#tmux-sessions", g: "Sessions", d: "cdb tmux attach resume terminals panel" },
  { t: "session.* tools", u: "sessions.html#session-tools", g: "Sessions", d: "session.list session.read session.send session.kill" },
  { t: "daemon.* tools", u: "sessions.html#daemon-tools", g: "Sessions", d: "daemon.register start stop restart logs long-running" },

  // --- Plugins ---
  { t: "Plugin manifest", u: "plugins.html#manifest", g: "Plugins", d: ".claude-plugin plugin.json clawdevbox recipes tools renderers" },
  { t: "Install a plugin", u: "plugins.html#installing", g: "Plugins", d: "plugin.install git local marketplace" },
  { t: "Scope & shadowing", u: "plugins.html#scope-shadowing", g: "Plugins", d: "project plugin global read-only" },

  // --- Extensibility ---
  { t: "Author a hostable tool", u: "extensibility.html#hostable-tools", g: "Extensibility", d: "single file typescript id parameters execute zod" },
  { t: "Author a custom renderer", u: "extensibility.html#custom-renderers", g: "Extensibility", d: "mjs render artifact type" },
  { t: "Add a CLI provider", u: "extensibility.html#cli-providers", g: "Extensibility", d: "agent_clis spawnSession copilot claude cursor" },
  { t: "Author a trigger template", u: "extensibility.html#trigger-templates", g: "Extensibility", d: "trigger.template.create envelope" },
  { t: "Ways to extend", u: "extensibility.html#ways-to-extend", g: "Extensibility", d: "recipe skill trigger tool renderer provider plugin memory" },

  // --- MCP tools reference groups ---
  { t: "Meta-tools: list_tools / learn_tool / run_tool", u: "mcp-tools.html#meta-tools", g: "MCP Tools", d: "gateway discover schema execute" },
  { t: "recipe.* tools", u: "mcp-tools.html#recipe-tools", g: "MCP Tools", d: "template instance steps run" },
  { t: "trigger.* tools", u: "mcp-tools.html#trigger-tools", g: "MCP Tools", d: "type template instance register fire test" },
  { t: "memory tools", u: "mcp-tools.html#memory-tools", g: "MCP Tools", d: "fact lesson wiki search vote sync" },
  { t: "session.* & daemon.* tools", u: "mcp-tools.html#session-tools", g: "MCP Tools", d: "session daemon pty long-running" },
  { t: "ado.* plugin tools", u: "mcp-tools.html#plugin-tools", g: "MCP Tools", d: "azure devops pr work item comment" },
];
