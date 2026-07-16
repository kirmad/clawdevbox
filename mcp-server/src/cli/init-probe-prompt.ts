/**
 * cli/init-probe-prompt.ts
 *
 * Phase 4 — Init prompt integration (spec §10.3).
 *
 * Renders the per-plugin opt-in card UI from `ProbedPlugin[]` and drives the
 * interactive loop: per-plugin `confirm(...)`, then a final summary card +
 * confirm. Returns the user's selection as `(provider, name)` tuples ready to
 * persist to `cfg.client_sync.discovered_plugins[]`.
 *
 * Pure rendering helpers (`renderPluginCard`, `renderFinalSummary`) are
 * exported separately for unit-testing. The interactive driver accepts an
 * injectable `confirmFn` so tests can drive it without a TTY.
 */

import { note, confirm, isCancel } from '@clack/prompts';
import type { ResolvedConfig } from '../config.ts';
import type { ProbedPlugin } from './probe-client-plugins.ts';

const CARD_WIDTH = 78;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

function bodyLine(content: string): string {
  // Card interior width is CARD_WIDTH - 2 borders - 1 left pad - 1 right pad.
  const interior = CARD_WIDTH - 4;
  const trimmed = clip(content, interior);
  const pad = ' '.repeat(Math.max(0, interior - trimmed.length));
  return `│ ${trimmed}${pad} │`;
}

function blankLine(): string {
  return bodyLine('');
}

function topBorder(title: string): string {
  // Title sits inside the top border: ┌─ <title> ───────────┐
  const interior = CARD_WIDTH - 4;
  const t = clip(title, interior);
  const rest = interior - t.length - 1;
  return `┌─ ${t} ${'─'.repeat(Math.max(0, rest))}┐`;
}

function bottomBorder(): string {
  return `└${'─'.repeat(CARD_WIDTH - 2)}┘`;
}

function providerLabel(providerId: string): string {
  if (providerId === 'claude') return 'Claude';
  if (providerId === 'copilot') return 'Copilot';
  if (providerId === 'agency') return 'Agency';
  return providerId;
}

function appendSection<T>(
  out: string[],
  header: string,
  entries: T[],
  renderEntry: (e: T) => string[],
): void {
  if (entries.length === 0) return;
  out.push(bodyLine(`${header} (${entries.length}):`));
  for (const e of entries) {
    for (const line of renderEntry(e)) out.push(bodyLine(`  ${line}`));
  }
  out.push(blankLine());
}

export function renderPluginCard(p: ProbedPlugin, idx: number, total: number): string {
  const title = `${p.pluginName} (${p.providerId})  ${idx} of ${total}`;
  const lines: string[] = [];
  lines.push(topBorder(title));
  lines.push(blankLine());
  lines.push(bodyLine('Components clawdevbox will register:'));
  lines.push(blankLine());

  appendSection(lines, 'Recipes', p.clawdevbox.recipes, (r) => {
    const out = [`• ${r.id}`];
    if (r.description) out.push(`  "${r.description}"`);
    return out;
  });

  appendSection(lines, 'Tools', p.clawdevbox.tools, (t) => {
    const out = [`• ${t.id} (${t.runtime})`];
    if (t.description) out.push(`  "${t.description}"`);
    return out;
  });

  appendSection(lines, 'Trigger types', p.clawdevbox.trigger_types, (t) => {
    const cron = t.default_cron ? ` (${t.default_cron})` : '';
    const out = [`• ${t.id}${cron}`];
    if (t.description) out.push(`  "${t.description}"`);
    return out;
  });

  appendSection(lines, 'Agent CLIs', p.clawdevbox.agent_clis, (a) => {
    const out = [`• ${a.id} — ${a.display_name}`];
    if (a.description) out.push(`  "${a.description}"`);
    return out;
  });

  appendSection(lines, 'Renderers', p.clawdevbox.renderers, (r) => {
    const out = [`• ${r.type}`];
    if (r.description) out.push(`  "${r.description}"`);
    return out;
  });

  const cs = p.clientSide;
  const hasClientSide =
    cs.skills.length > 0 ||
    cs.agents.length > 0 ||
    cs.commands.length > 0 ||
    cs.mcpServers.length > 0;
  if (hasClientSide) {
    const label = providerLabel(p.providerId);
    lines.push(bodyLine(`Components handled by ${label} (not registered by clawdevbox):`));
    for (const s of cs.skills) {
      lines.push(bodyLine(`  • skill: ${s.id}${s.description ? ` — "${s.description}"` : ''}`));
    }
    for (const a of cs.agents) {
      lines.push(bodyLine(`  • agent: ${a.id}${a.description ? ` — "${a.description}"` : ''}`));
    }
    for (const c of cs.commands) {
      lines.push(bodyLine(`  • command: ${c.id}${c.description ? ` — "${c.description}"` : ''}`));
    }
    for (const m of cs.mcpServers) {
      lines.push(bodyLine(`  • mcp: ${m.id}`));
    }
    lines.push(blankLine());
  }

  lines.push(bodyLine(`Source: ${p.pluginDir}`));
  lines.push(bottomBorder());
  return lines.join('\n');
}

export function renderFinalSummary(selected: ProbedPlugin[], configPath: string): string {
  const lines: string[] = [];
  lines.push(`You selected ${selected.length} client plugin${selected.length === 1 ? '' : 's'} to register with clawdevbox:`);
  for (const p of selected) {
    lines.push(`  • ${p.pluginName}  (${p.providerId})`);
  }
  lines.push('');
  lines.push(`These selections are persisted to ${configPath} and respected on every boot.`);
  lines.push('You can change them later via `clawdevbox plugin sync` or by re-running `clawdevbox init`.');
  return lines.join('\n');
}

export type ConfirmFn = (opts: {
  message: string;
  initialValue?: boolean;
}) => Promise<boolean | symbol>;

export interface RunClientPluginProbePromptOptions {
  configPath: string;
  preselect?: Array<{ provider: string; name: string }>;
  confirmFn?: ConfirmFn;
  /** Test seam — defaults to `note` from `@clack/prompts`. */
  noteFn?: (message: string, title?: string) => void;
}

export async function runClientPluginProbePrompt(
  probed: ProbedPlugin[],
  _cfg: ResolvedConfig,
  options: RunClientPluginProbePromptOptions,
): Promise<Array<{ provider: string; name: string }>> {
  const confirmFn: ConfirmFn = options.confirmFn ?? (confirm as unknown as ConfirmFn);
  const noteFn = options.noteFn ?? ((msg, title) => note(msg, title));

  if (probed.length === 0) return [];

  const preselectedKeys = new Set((options.preselect ?? []).map((p) => `${p.provider}:${p.name}`));

  noteFn(
    `We found ${probed.length} plugin${probed.length === 1 ? '' : 's'} from your installed CLIs that ship clawdevbox extensions.`,
    'Client plugin discovery',
  );

  const selected: ProbedPlugin[] = [];
  for (let i = 0; i < probed.length; i++) {
    const p = probed[i];
    noteFn(renderPluginCard(p, i + 1, probed.length));
    const key = `${p.providerId}:${p.pluginName}`;
    const initial = preselectedKeys.has(key);
    const include = await confirmFn({
      message: `Enable clawdevbox capabilities from '${p.pluginName}'?`,
      initialValue: initial,
    });
    if (isCancel(include)) {
      // Treat as skip-all — return empty without persisting anything.
      return [];
    }
    if (include === true) selected.push(p);
  }

  if (selected.length === 0) {
    noteFn('No client plugins selected.');
    return [];
  }

  noteFn(renderFinalSummary(selected, options.configPath), 'Confirm');
  const final = await confirmFn({ message: 'Confirm and persist?', initialValue: true });
  if (isCancel(final) || final !== true) return [];

  return selected.map((p) => ({ provider: p.providerId, name: p.pluginName }));
}
