/**
 * recipe-instances-store.ts
 *
 * Storage for recipe-run instances (spec §6.1 — `recipe.run` / `recipe.done` /
 * `recipe.instance_info`). One file per instance under
 * `<workspace>/.conductor/recipe-instances/<id>.json`.
 *
 * An instance is "an agent run started from a recipe". The Conductor MCP
 * server writes the row at spawn time (recipe.run) and the agent inside the
 * spawned CLI session calls recipe.done to update it when it's finished. The
 * file is the durable record so a crashed sidecar can still find what was
 * running.
 *
 * IDs: `ri_<base36-ts>_<4hex>` — same shape as workspace ids for visual
 * consistency.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fs-util.ts';

// ============================================================================
// Types
// ============================================================================

export type RecipeInstanceStatus = 'running' | 'success' | 'failure' | 'cancelled';

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
  return join(workspacePath, '.conductor', 'recipe-instances');
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
}
