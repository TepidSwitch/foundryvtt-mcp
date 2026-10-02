import { describe, expect, it, vi } from 'vitest';
import { backoffDelay, ConnectionManager, isPermanentAuthError } from './connection-manager.js';

function fakeClient(failures: Error[]) {
  let connected = false;
  const connect = vi.fn(async () => {
    const f = failures.shift();
    if (f) {
      throw f;
    }
    connected = true;
  });
  return { connect, isConnected: () => connected };
}

describe('ConnectionManager', () => {
  it('retries transient failures then connects', async () => {
    const c = fakeClient([
      new Error('No session cookie returned from /join'),
      new Error('ECONNRESET'),
    ]);
    const sleep = vi.fn(async () => undefined);
    const m = new ConnectionManager(c, { sleep });
    await m.ensureConnected(1000);
    expect(c.connect).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry rejected credentials', async () => {
    const c = fakeClient([
      new Error('FoundryVTT authentication failed (HTTP 401): JOIN.ErrorInvalidPassword'),
    ]);
    const m = new ConnectionManager(c, { sleep: async () => undefined });
    await expect(m.ensureConnected(1000)).rejects.toThrow(/Login rejected/);
    expect(c.connect).toHaveBeenCalledTimes(1);
  });

  it('times out with the last error and keeps retrying in background', async () => {
    const c = {
      connect: vi.fn(async () => {
        throw new Error('boom');
      }),
      isConnected: () => false,
    };
    const m = new ConnectionManager(c, { sleep: () => new Promise((r) => setTimeout(r, 5)) });
    await expect(m.ensureConnected(30)).rejects.toThrow(/last error: boom/);
  });
});

describe('helpers', () => {
  it('backs off exponentially with cap and jitter', () => {
    expect(backoffDelay(1, 1000, 30000, () => 1)).toBe(1000);
    expect(backoffDelay(3, 1000, 30000, () => 1)).toBe(4000);
    expect(backoffDelay(10, 1000, 30000, () => 0)).toBe(15000);
  });
  it('classifies permanent auth errors', () => {
    expect(isPermanentAuthError(new Error('authentication failed (HTTP 401): x'))).toBe(true);
    expect(isPermanentAuthError(new Error('No session cookie returned from /join'))).toBe(false);
  });
});
