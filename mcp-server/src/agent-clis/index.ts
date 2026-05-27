import { copilotProvider } from './copilot.ts';
import { claudeProvider } from './claude.ts';
import { echoStubProvider } from './echo-stub.ts';
import { e2eTestRunnerProvider } from './e2e-test-runner.ts';
import type { AgentCliProvider } from './types.ts';
import type { Workspace } from '../workspace.ts';

export const BUILTIN_PROVIDERS: AgentCliProvider[] = [
  copilotProvider,
  claudeProvider,
  echoStubProvider,
  e2eTestRunnerProvider,
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
  SyncPluginInventoryOpts,
  SyncReport,
  DiscoveredPlugin,
  MarketplaceRecord,
  PluginCliBinding,
  ProviderCapabilities,
  PromptQueueMode,
  PromptStrategy,
  WritePromptOpts,
  SessionMode,
} from './types.ts';

export { cliPluginSync, cliPluginDiscover, parsePluginListOutput, parseMarketplaceListOutput, stripAnsi } from './shared.ts';

export {
  SessionConductor,
  createSessionConductor,
  SessionDisposedError,
  SessionExitedError,
  SessionTimeoutError,
  UnsupportedProviderError,
} from './session-conductor.ts';
export type {
  ConductorOpts,
  ConductorState,
  DispatchOpts,
  DispatchResult,
  DoneSignal,
} from './session-conductor.ts';
