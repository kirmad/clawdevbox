/**
 * logger.ts
 *
 * Structured logger for the MCP server. Pinned to stderr because stdio MCP
 * owns stdout for protocol frames — anything written there would corrupt
 * the wire.
 *
 * Plain pino JSON output. Override the level via `CONDUCTOR_LOG_LEVEL`
 * (`trace|debug|info|warn|error|fatal`).
 */

import pino, { type Logger, type DestinationStream } from 'pino';

const level = process.env.CONDUCTOR_LOG_LEVEL ?? 'info';

// `sync: true` keeps the destination simple: every write is flushed
// synchronously to stderr, so the process can exit cleanly without
// dangling worker streams. For an MCP server this is the right
// trade-off — log throughput is low, and shutdown integrity matters
// more than the small perf gain of async writes.
const stderrDest: DestinationStream = pino.destination({ fd: 2, sync: true });

export const logger: Logger = pino(
  { level, base: { svc: 'conductor-mcp' } },
  stderrDest,
);
