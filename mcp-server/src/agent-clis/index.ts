import { copilotProvider } from './copilot.ts';
import { claudeProvider } from './claude.ts';
import { echoStubProvider } from './echo-stub.ts';
import type { AgentCliProvider } from './types.ts';
import type { Workspace } from '../workspace.ts';

export const BUILTIN_PROVIDERS: AgentCliProvider[] = [
  copilotProvider,
  claudeProvider,
  echoStubProvider,
];

/** Insert each built-in into the workspace's provider registry. Always runs
 *  first so plugin-provided providers can't shadow built-in ids. */
export function registerBuiltinProviders(ws: Workspace): void {
  for (const p of BUILTIN_PROVIDERS) {
    ws.agentCliProviders.set(p.id, p);
  }
}

export type {
  AgentCliProvider,
  AgentHandle,
  SpawnSessionOpts,
  ProviderCtx,
  DetectResult,
} from './types.ts';
