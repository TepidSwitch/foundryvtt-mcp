/**
 * Optional secrets file so credentials need not live in the MCP host's config.
 *
 * Path: `FOUNDRY_ENV_FILE`, else `~/.config/foundryvtt-mcp/.env` (or
 * `%APPDATA%\foundryvtt-mcp\.env` on Windows) when it exists. Values already in
 * the environment win, so the host config can still override a field.
 */

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultSecretsPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'foundryvtt-mcp', '.env');
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'foundryvtt-mcp', '.env');
}

export function resolveSecretsPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.FOUNDRY_ENV_FILE;
  if (explicit) {
    return explicit;
  }
  const fallback = defaultSecretsPath(env);
  return existsSync(fallback) ? fallback : null;
}

/** Returns a warning when a POSIX secrets file is readable by group/others. */
export function permissionWarning(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === 'win32') {
    return null;
  }
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      return `Secrets file ${path} is accessible by other users (mode ${mode.toString(8)}); run: chmod 600 "${path}"`;
    }
  } catch {
    // Missing/unreadable files are reported by the loader.
  }
  return null;
}
