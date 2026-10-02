import { beforeEach, describe, expect, it } from 'vitest';
import { clearBufferedLogs, pushLog } from '../../utils/log-buffer.js';
import {
  localDiagnoseErrors,
  localRecentLogs,
  localSearchLogs,
  localSystemHealth,
} from '../local.js';

beforeEach(() => {
  clearBufferedLogs();
  pushLog('info', 'Connected to FoundryVTT');
  pushLog('warn', 'World refresh after reconnect failed');
  pushLog('error', 'Foundry server is not running (status=NOT_RUNNING)', 'stack here');
  pushLog('error', 'FoundryVTT rejected create ActiveEffect: nope');
});

describe('local diagnostics', () => {
  it('filters recent logs by level and strips stacks unless asked', () => {
    const errors = localRecentLogs({ level: 'error' });
    expect(errors.total).toBe(2);
    expect(errors.logs[0]?.stack).toBeUndefined();
    expect(localRecentLogs({ level: 'error', includeStack: true }).logs[0]?.stack).toBe(
      'stack here',
    );
    expect(localRecentLogs({ lines: 1 }).logs).toHaveLength(1);
  });

  it('searches by regex, case-insensitively by default', () => {
    const r = localSearchLogs({ pattern: 'not running' });
    expect(r.matches).toBe(1);
    expect(localSearchLogs({ pattern: 'NOT RUNNING', caseSensitive: true }).matches).toBe(0);
    expect(() => localSearchLogs({ pattern: '(' })).toThrow(/Invalid regular expression/);
  });

  it('categorises errors and suggests fixes', () => {
    const d = localDiagnoseErrors(3600);
    expect(d.summary.totalErrors).toBe(2);
    expect(d.summary.categories).toMatchObject({ connection: 1, write: 1 });
    expect(d.suggestions.map((s) => s.category)).toContain('connection');
    expect(d.healthScore).toBe(80);
  });

  it('builds system health from the world snapshot', () => {
    const base = {
      connected: true,
      stale: false,
      world: { id: 'humblebruvs' },
      system: { version: '6.0.5' },
      release: { version: '14.368' },
      users: [{ role: 4 }, { role: 1 }, { role: 1 }],
      activeUsers: ['a', 'b'],
      modules: [{ active: true }, { active: false }, { active: true }],
    };
    const h = localSystemHealth(base);
    expect(h).toMatchObject({
      status: 'healthy',
      server: { foundryVersion: '14.368', systemVersion: '6.0.5', worldId: 'humblebruvs' },
      users: { total: 3, active: 2, gm: 1 },
      modules: { total: 3, active: 2 },
    });
    expect(localSystemHealth({ ...base, stale: true }).status).toBe('warning');
    expect(localSystemHealth({ ...base, connected: false }).status).toBe('critical');
  });
});
