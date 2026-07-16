/**
 * llm/copilot-sdk-provider.ts
 *
 * LLM provider backed by the real GitHub Copilot SDK (CopilotClient).
 * Spawns a Copilot CLI runtime, creates sessions with real tool execution.
 *
 * Use this provider when you need:
 *   - Real tool calling (tools execute server-side with handlers)
 *   - Full Copilot agent capabilities (file reading, shell, etc.)
 *   - Agentic multi-step reasoning
 *
 * Trade-off: ~4-9s per call (vs ~1.5s for the raw github-models provider).
 * The runtime is kept warm after first use for amortized startup cost.
 */

import { pathToFileURL } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { LlmAskRequest, LlmAskResponse, LlmProvider } from './types.ts';

// Dynamically resolved at first use
let sdkModule: any;
let clientInstance: any;
let clientStarting: Promise<void> | null = null;

/**
 * Resolve the path to the bundled copilot-sdk from the installed Copilot CLI.
 */
function findSdkPath(): string | null {
  const base = join(homedir(), '.copilot', 'pkg', 'win32-x64');
  if (!existsSync(base)) {
    // Try unix paths
    const unixBase = join(homedir(), '.copilot', 'pkg', 'linux-x64');
    if (existsSync(unixBase)) {
      const versions = readdirSync(unixBase).sort().reverse();
      if (versions.length > 0) return join(unixBase, versions[0]!, 'copilot-sdk', 'index.js');
    }
    return null;
  }
  const versions = readdirSync(base).sort().reverse();
  if (versions.length === 0) return null;
  const sdkPath = join(base, versions[0]!, 'copilot-sdk', 'index.js');
  return existsSync(sdkPath) ? sdkPath : null;
}

async function loadSdk(): Promise<any> {
  if (sdkModule) return sdkModule;
  const sdkPath = findSdkPath();
  if (!sdkPath) throw new Error('Copilot SDK not found at ~/.copilot/pkg/');
  sdkModule = await import(pathToFileURL(sdkPath).href);
  return sdkModule;
}

async function getClient(): Promise<any> {
  if (clientInstance) return clientInstance;
  if (clientStarting) { await clientStarting; return clientInstance; }

  clientStarting = (async () => {
    const sdk = await loadSdk();
    clientInstance = new sdk.CopilotClient({ logLevel: 'none' });
    await clientInstance.start();
  })();
  await clientStarting;
  clientStarting = null;
  return clientInstance;
}

/** Shut down the warm client (call on process exit). */
export async function shutdownCopilotClient(): Promise<void> {
  if (clientInstance) {
    try { await clientInstance.stop(); } catch { /* best-effort */ }
    clientInstance = null;
  }
}

export const copilotSdkProvider: LlmProvider = {
  id: 'copilot-sdk',
  displayName: 'GitHub Copilot SDK (real agent)',

  async isAvailable(): Promise<boolean> {
    return findSdkPath() !== null;
  },

  async ask(req: LlmAskRequest): Promise<LlmAskResponse> {
    const sdk = await loadSdk();
    const client = await getClient();

    // Build tool definitions with handlers from the request
    const tools = (req.tools ?? []).map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
      // Tools passed via HTTP won't have handlers — they're declaration-only.
      // For programmatic use, callers attach `_handler` to the tool def.
      handler: (t as any)._handler,
    })).filter((t) => t.handler); // Only register tools that have real handlers

    const systemContent = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');

    const userMessages = req.messages.filter((m) => m.role !== 'system');
    const prompt = userMessages.map((m) => m.content).join('\n');

    const sessionConfig: any = {
      onPermissionRequest: sdk.approveAll,
      // Performance optimizations: strip everything unnecessary
      availableTools: tools.length > 0 ? undefined : [],
      enableConfigDiscovery: false,
      infiniteSessions: { enabled: false },
      enableSessionTelemetry: false,
    };

    if (systemContent) {
      sessionConfig.systemMessage = { mode: 'replace', content: systemContent };
    }

    if (req.model) {
      sessionConfig.model = req.model;
    }

    if (tools.length > 0) {
      sessionConfig.tools = tools;
    }

    const t0 = performance.now();
    const session = await client.createSession(sessionConfig);

    try {
      const response = await session.sendAndWait(prompt, 60_000);
      const latency_ms = Math.round(performance.now() - t0);

      return {
        content: response?.data?.content ?? null,
        model: req.model ?? 'copilot-sdk-default',
        provider: 'copilot-sdk',
        latency_ms,
      };
    } finally {
      await session.disconnect();
    }
  },
};
