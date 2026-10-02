/**
 * In-memory ring buffer of this MCP server's own log lines.
 *
 * Foundry's server log is only reachable through a companion server module, so
 * without one the diagnostics tools report on the MCP server itself (login
 * attempts, tool failures, write errors) — which is what usually explains a
 * connection problem anyway.
 */

export interface BufferedLog {
  timestamp: string;
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  stack?: string;
}

export const LOG_BUFFER_MAX = 500;

const buffer: BufferedLog[] = [];

export function pushLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  stack?: string,
): void {
  buffer.push({
    timestamp: new Date().toISOString(),
    level: level === 'debug' ? 'log' : level,
    message,
    ...(stack ? { stack } : {}),
  });
  if (buffer.length > LOG_BUFFER_MAX) {
    buffer.shift();
  }
}

/** Oldest first. */
export function getBufferedLogs(): BufferedLog[] {
  return [...buffer];
}

export function clearBufferedLogs(): void {
  buffer.length = 0;
}
