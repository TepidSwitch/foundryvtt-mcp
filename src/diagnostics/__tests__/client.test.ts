/**
 * @fileoverview Tests for DiagnosticsClient: the wiring between the client
 * (world snapshot + connection state) and the local diagnostics functions.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { FoundryClient } from '../../foundry/client.js';
import { clearBufferedLogs, pushLog } from '../../utils/log-buffer.js';
import { DiagnosticsClient } from '../client.js';

function fakeFoundry(opts: { connected: boolean; stale?: boolean; withWorld?: boolean }) {
  const world = opts.withWorld
    ? {
        world: { id: 'my-world' },
        system: { version: '5.0.0' },
        release: { version: '14.360' },
        users: [{ role: 4 }, { role: 1 }],
        activeUsers: ['u1'],
        modules: [{ active: true }, { active: false }],
      }
    : null;
  return {
    getWorldData: () => world,
    isConnected: () => opts.connected,
    isWorldDataStale: () => opts.stale ?? false,
  } as unknown as FoundryClient;
}

describe('DiagnosticsClient', () => {
  beforeEach(() => {
    clearBufferedLogs();
    pushLog('info', 'Connected to FoundryVTT');
    pushLog('error', 'Foundry server is not running', 'stack here');
  });

  it('reports system health from the world snapshot', async () => {
    const client = new DiagnosticsClient(fakeFoundry({ connected: true, withWorld: true }));
    const health = await client.getSystemHealth();
    expect(health.status).toBe('healthy');
    expect(health.server.worldId).toBe('my-world');
    expect(health.server.foundryVersion).toBe('14.360');
    expect(health.users).toEqual({ total: 2, active: 1, gm: 1 });
    expect(health.modules).toEqual({ total: 2, active: 1 });
    expect(health.logs.recentErrors).toBe(1);
  });

  it('is critical when disconnected and warning when the cache is stale', async () => {
    const down = new DiagnosticsClient(fakeFoundry({ connected: false }));
    expect(await down.getHealthStatus()).toEqual({ status: 'critical' });
    const stale = new DiagnosticsClient(
      fakeFoundry({ connected: true, stale: true, withWorld: true }),
    );
    expect(await stale.getHealthStatus()).toEqual({ status: 'warning' });
  });

  it('serves logs, searches and error diagnosis from the MCP log buffer', async () => {
    const client = new DiagnosticsClient(fakeFoundry({ connected: true, withWorld: true }));
    expect((await client.getRecentLogs({ level: 'error' })).logs).toHaveLength(1);
    expect((await client.searchLogs({ pattern: 'not running' })).matches).toBe(1);
    const diagnosis = await client.diagnoseErrors();
    expect(diagnosis.summary.totalErrors).toBe(1);
    expect(diagnosis.suggestions.map((s) => s.category)).toContain('connection');
  });

  it('getErrorsOnly returns entries of the requested level with stacks', async () => {
    const client = new DiagnosticsClient(fakeFoundry({ connected: true }));
    const errors = await client.getErrorsOnly(3600, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.stack).toBe('stack here');
    expect(await client.getErrorsOnly(3600, 'warn')).toHaveLength(0);
  });

  it('is always available', async () => {
    expect(await new DiagnosticsClient(fakeFoundry({ connected: false })).isAvailable()).toBe(true);
  });
});
