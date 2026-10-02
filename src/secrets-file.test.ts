import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSecretsPath, permissionWarning, resolveSecretsPath } from './secrets-file.js';

describe('secrets file', () => {
  it('prefers FOUNDRY_ENV_FILE', () => {
    expect(resolveSecretsPath({ FOUNDRY_ENV_FILE: '/x/y.env' })).toBe('/x/y.env');
  });
  it('uses XDG on posix and APPDATA on windows', () => {
    expect(defaultSecretsPath({ XDG_CONFIG_HOME: '/c' }, 'linux')).toBe(
      join('/c', 'foundryvtt-mcp', '.env'),
    );
    expect(defaultSecretsPath({ APPDATA: 'C:\\A' }, 'win32')).toContain('foundryvtt-mcp');
  });
  it('returns null when no default file exists', () => {
    expect(resolveSecretsPath({ XDG_CONFIG_HOME: join(tmpdir(), 'nope-xyz') })).toBeNull();
  });
  it('warns about loose permissions on posix only', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'sec-')), '.env');
    writeFileSync(f, 'A=1');
    chmodSync(f, 0o644);
    expect(permissionWarning(f, 'linux')).toContain('chmod 600');
    chmodSync(f, 0o600);
    expect(permissionWarning(f, 'linux')).toBeNull();
    expect(permissionWarning(f, 'win32')).toBeNull();
  });
});
