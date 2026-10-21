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
    expect((await down.getSystemHealth()).status).toBe('critical');
    const stale = new DiagnosticsClient(
      fakeFoundry({ connected: true, stale: true, withWorld: true }),
    );
    expect((await stale.getSystemHealth()).status).toBe('warning');
  });

  it('serves logs and searches from the MCP log buffer', async () => {
    const client = new DiagnosticsClient(fakeFoundry({ connected: true, withWorld: true }));
    const errors = await client.getRecentLogs({ level: 'error', includeStack: true });
    expect(errors.logs).toHaveLength(1);
    expect(errors.logs[0]?.stack).toBe('stack here');
    expect((await client.searchLogs({ pattern: 'not running' })).matches).toBe(1);
  });
});
