/**
 * Diagnostics computed without any Foundry server module: from the world
 * snapshot the Socket.IO login already loaded, and from this MCP server's own
 * log buffer. Backs DiagnosticsClient (and the diagnostics handlers).
 */

import { type BufferedLog, getBufferedLogs, LOG_BUFFER_MAX } from '../utils/log-buffer.js';
import type {
  ErrorDiagnosis,
  LogEntry,
  LogPatternSearchParams,
  LogResponse,
  LogSearchParams,
  LogSearchResponse,
  SystemHealth,
} from './types.js';

function toEntry(l: BufferedLog): LogEntry {
  return {
    timestamp: l.timestamp,
    level: l.level,
    message: l.message,
    ...(l.stack ? { stack: l.stack } : {}),
    // These are the MCP server's own lines, not Foundry's.
    source: 'api',
  };
}

function inTimeframe(l: BufferedLog, seconds: number): boolean {
  return Date.parse(l.timestamp) >= Date.now() - seconds * 1000;
}

export function localRecentLogs(params: LogSearchParams = {}): LogResponse {
  let logs = getBufferedLogs();
  if (params.level) {
    logs = logs.filter((l) => l.level === params.level);
  }
  if (params.since) {
    const since = Date.parse(params.since);
    if (!Number.isNaN(since)) {
      logs = logs.filter((l) => Date.parse(l.timestamp) >= since);
    }
  }
  const total = logs.length;
  const lines = params.lines ?? 50;
  const entries = logs.slice(-lines).map(toEntry);
  if (!params.includeStack) {
    for (const e of entries) {
      delete e.stack;
    }
  }
  return {
    logs: entries,
    total,
    bufferSize: getBufferedLogs().length,
    maxBufferSize: LOG_BUFFER_MAX,
  };
}

export function localSearchLogs(params: LogPatternSearchParams): LogSearchResponse {
  const seconds = params.timeframe ? Number(params.timeframe) : 3600;
  let re: RegExp;
  try {
    re = new RegExp(params.pattern, params.caseSensitive ? '' : 'i');
  } catch {
    throw new Error(`Invalid regular expression: ${params.pattern}`);
  }
  const logs = getBufferedLogs()
    .filter((l) => inTimeframe(l, Number.isFinite(seconds) ? seconds : 3600))
    .filter((l) => !params.level || l.level === params.level)
    .filter((l) => re.test(l.message))
    .map(toEntry);
  return {
    logs,
    matches: logs.length,
    pattern: params.pattern,
    searchTimeframe: `${Number.isFinite(seconds) ? seconds : 3600}s`,
  };
}

const CATEGORIES: Array<[string, RegExp, string]> = [
  [
    'connection',
    /connect|socket|ECONN|ENOTFOUND|ETIMEDOUT|not running|session cookie|\/join/i,
    'Check that the Foundry server is running (hosts like Molten stop idle servers) and FOUNDRY_URL is right.',
  ],
  [
    'authentication',
    /authentication|password|JOIN\.Error|login/i,
    'Check FOUNDRY_USERNAME / FOUNDRY_PASSWORD in the secrets file.',
  ],
  [
    'write',
    /rejected (create|update|delete)|write operations|modifyDocument/i,
    'A world write was refused. Check FOUNDRY_WRITE_ENABLED and that the Foundry user is a GM.',
  ],
  ['tool', /tool execution failed|failed to/i, 'See the individual tool errors below.'],
];

/** The category an MCP log message falls into ('other' when none matches). */
function categoryOf(message: string): string {
  return CATEGORIES.find(([, re]) => re.test(message))?.[0] ?? 'other';
}

/** Category names `localDiagnoseErrors` can report, `other` last. */
export const ERROR_CATEGORIES = [...CATEGORIES.map(([name]) => name), 'other'];

export function localDiagnoseErrors(timeframeSeconds = 3600, category?: string): ErrorDiagnosis {
  const errors = getBufferedLogs()
    .filter((l) => l.level === 'error')
    .filter((l) => inTimeframe(l, timeframeSeconds))
    .filter((l) => !category || categoryOf(l.message) === category);
  const categories: Record<string, number> = {};
  const hints = new Map<string, string>();
  for (const e of errors) {
    const hit = CATEGORIES.find(([, re]) => re.test(e.message));
    const name = hit?.[0] ?? 'other';
    categories[name] = (categories[name] ?? 0) + 1;
    if (hit) {
      hints.set(name, hit[2]);
    }
  }
  const unique = new Set(errors.map((e) => e.message.slice(0, 120))).size;
  return {
    timestamp: new Date().toISOString(),
    timeframe: `${timeframeSeconds}s`,
    summary: { totalErrors: errors.length, uniqueErrors: unique, categories },
    recentErrors: errors.slice(-20).map(toEntry),
    suggestions: [...hints.entries()].map(([category, suggestion]) => ({
      category,
      suggestion,
      priority: errors.length > 5 ? ('high' as const) : ('medium' as const),
    })),
    healthScore: Math.max(0, 100 - errors.length * 10),
  };
}

export interface WorldSnapshotHealth {
  connected: boolean;
  stale: boolean;
  world: Record<string, unknown>;
  system: Record<string, unknown>;
  release: Record<string, unknown>;
  users: Array<{ role: number }>;
  activeUsers: string[];
  modules: Array<Record<string, unknown>>;
}

export function localSystemHealth(w: WorldSnapshotHealth): SystemHealth {
  const logs = getBufferedLogs();
  const recent = logs.filter((l) => inTimeframe(l, 3600));
  const recentErrors = recent.filter((l) => l.level === 'error').length;
  const recentWarnings = recent.filter((l) => l.level === 'warn').length;
  let status: SystemHealth['status'] = 'healthy';
  if (!w.connected) {
    status = 'critical';
  } else if (w.stale || recentErrors > 5) {
    status = 'warning';
  }
  return {
    timestamp: new Date().toISOString(),
    server: {
      foundryVersion: String(w.release.version ?? w.release.generation ?? 'unknown'),
      systemVersion: String(w.system.version ?? 'unknown'),
      worldId: String(w.world.id ?? 'unknown'),
    },
    users: {
      total: w.users.length,
      active: w.activeUsers.length,
      gm: w.users.filter((u) => u.role >= 3).length,
    },
    modules: {
      total: w.modules.length,
      active: w.modules.filter((m) => m.active === true).length,
    },
    performance: { connectedClients: w.activeUsers.length },
    logs: {
      bufferSize: logs.length,
      recentErrors,
      recentWarnings,
      errorRate: recent.length ? Math.round((recentErrors / recent.length) * 1000) / 10 : 0,
    },
    status,
  };
}
