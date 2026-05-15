/**
 * recipe-instances-store.ts
 *
 * Storage for recipe-run instances (spec §6.1 — `recipe.run` / `recipe.done` /
 * `recipe.instance_info`). One file per instance under
 * `<workspace>/.clawdevbox/recipe-instances/<id>.json`.
 *
 * An instance is "an agent run started from a recipe". The Clawdevbox MCP
 * server writes the row at spawn time (recipe.run) and the agent inside the
 * spawned CLI session calls recipe.done to update it when it's finished. The
 * file is the durable record so a crashed sidecar can still find what was
 * running.
 *
 * IDs: `ri_<base36-ts>_<4hex>` — same shape as workspace ids for visual
 * consistency.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { emitChange } from './event-bus.ts';
import { writeFileAtomic } from './fs-util.ts';

// ============================================================================
// Types
// ============================================================================

export type RecipeInstanceStatus = 'running' | 'success' | 'failure' | 'cancelled';
export type RecipeStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'awaiting_user' | 'skipped';

/**
 * Per-step execution state. Optional — older recipes that don't write
 * step data still render fine (the SPA shows just the overall status).
 *
 * Authoring: today these are seeded by the demo + future
 * `recipe.step_update` MCP tool. The renderer treats this as the
 * source of truth for the stepper.
 */
export interface RecipeStep {
  /** Stable step id within the recipe (e.g. 'analyze-diffs', 'step-3'). */
  id: string;
  /** Display title. */
  title: string;
  status: RecipeStepStatus;
  started_at?: number;
  completed_at?: number;
  /** Short single-line status detail ("Generated 4 comments"). */
  message?: string;
  /** When status === 'awaiting_user', the prompt to show to the user. */
  awaiting_user_prompt?: string;
  /** Deep-link to a child recipe instance spawned by this step. */
  child_recipe_instance_id?: string;
  /** Deep-link to an artifact produced by this step. */
  artifact_id?: string;
}

export interface RecipeInstance {
  id: string;
  recipe_id: string;
  recipe_snapshot: string;
  workspace_id: string;
  workspace_path: string;
  prompt: string;
  params: Record<string, unknown>;
  agent_cli: string;
  pid: number | null;
  started_at: number;
  status: RecipeInstanceStatus;
  completed_at: number | null;
  result: unknown;
  message: string | null;
  /**
   * Stable agent-CLI session id. Used as `--session-id` for Claude and
   * `--resume <id>` for Copilot — keeps the conversation thread coherent
   * across CLI restarts and lets the UI offer a "Resume" action.
   * Always minted explicitly (never delegated to the CLI's auto-mint).
   */
  session_id?: string;
  /** When set, this instance was created by resuming `resume_of`'s session. */
  resume_of?: string | null;
  /** Per-step execution state. Optional; absence means the run never wrote step data. */
  steps?: RecipeStep[];
  /** Canonical parent link for nested runs. */
  parent_recipe_instance_id?: string | null;
}

// ============================================================================
// Id minting
// ============================================================================

export function mintRecipeInstanceId(now: number = Date.now()): string {
  const ts = now.toString(36);
  const rand = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return `ri_${ts}_${rand}`;
}

// ============================================================================
// Paths
// ============================================================================

export function recipeInstancesDir(workspacePath: string): string {
  return join(workspacePath, '.clawdevbox', 'recipe-instances');
}

export function recipeInstancePath(workspacePath: string, id: string): string {
  return join(recipeInstancesDir(workspacePath), `${id}.json`);
}

// ============================================================================
// Read / write
// ============================================================================

export function readRecipeInstance(
  workspacePath: string,
  id: string,
): RecipeInstance | null {
  const p = recipeInstancePath(workspacePath, id);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as RecipeInstance;
    return parsed;
  } catch {
    return null;
  }
}

export function writeRecipeInstance(workspacePath: string, instance: RecipeInstance): void {
  writeFileAtomic(
    recipeInstancePath(workspacePath, instance.id),
    JSON.stringify(instance, null, 2) + '\n',
  );
  // Every recipe-state transition (spawn, agent status change, done) ends
  // up here. Notifying once per write keeps the home page in sync without
  // duplicating emit calls at every call site.
  emitChange('recipes');
}

/**
 * List every recipe instance under a workspace path. Returns an empty list
 * if the workspace has no `.clawdevbox/recipe-instances/` directory yet.
 * Corrupt or unreadable files are silently skipped so a single bad row
 * doesn't break the listing.
 */
export function listRecipeInstancesInWorkspace(workspacePath: string): RecipeInstance[] {
  const dir = recipeInstancesDir(workspacePath);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: RecipeInstance[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as RecipeInstance;
      if (parsed && typeof parsed.id === 'string') out.push(parsed);
    } catch {
      /* corrupt entry — skip */
    }
  }
  return out;
}
