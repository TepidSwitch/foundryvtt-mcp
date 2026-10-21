/**
 * @fileoverview DiagnosticsClient: thin seam between the tool handlers and the
 * local diagnostics functions in `./local.ts`.
 *
 * It only adapts the FoundryClient (connection state + world snapshot) into the
 * plain input `localSystemHealth` takes, and forwards log queries to the MCP
 * server's own log buffer. Handlers depend on this small interface so their
 * tests can inject it without a FoundryClient.
 */

import type { z } from 'zod';
import type { FoundryClient } from '../foundry/client.js';
import { localRecentLogs, localSearchLogs, localSystemHealth } from './local.js';
import type {
  LogPatternSearchParams,
  LogResponseSchema,
  LogSearchParams,
  LogSearchResponseSchema,
  SystemHealthSchema,
} from './types.js';

type LogResponse = z.infer<typeof LogResponseSchema>;
type LogSearchResponse = z.infer<typeof LogSearchResponseSchema>;
type SystemHealth = z.infer<typeof SystemHealthSchema>;

export class DiagnosticsClient {
  constructor(private foundryClient: FoundryClient) {}

  /** Recent entries from the MCP server's log buffer, with optional filters. */
  async getRecentLogs(params: LogSearchParams = {}): Promise<LogResponse> {
    return localRecentLogs(params);
  }

  /** Regex search over the MCP server's log buffer. */
  async searchLogs(params: LogPatternSearchParams): Promise<LogSearchResponse> {
    return localSearchLogs(params);
  }

  /** System health computed from the connection state and world snapshot. */
  async getSystemHealth(): Promise<SystemHealth> {
    const world = this.foundryClient.getWorldData();
    return localSystemHealth({
      connected: this.foundryClient.isConnected() && world !== null,
      stale: this.foundryClient.isWorldDataStale(),
      world: (world?.world ?? {}) as Record<string, unknown>,
      system: (world?.system ?? {}) as Record<string, unknown>,
      release: (world?.release ?? {}) as Record<string, unknown>,
      users: world?.users ?? [],
      activeUsers: world?.activeUsers ?? [],
      modules: world?.modules ?? [],
    });
  }
}
