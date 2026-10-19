import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { handleRunScript, resetSeenScripts } from '../script.js';

function client() {
  const state = { dry: false, batch: null as string | null };
  const c = {
    getWorldData: () => ({ actors: [{ _id: 'a1', name: 'Goblin', type: 'npc' }] }),
    getUserId: () => 'u1',
    getCurrentBatchId: () => state.batch,
    withBatch: async (fn: () => Promise<unknown>) => {
      state.batch = 'b-1';
      try {
        return await fn();
      } finally {
        state.batch = null;
      }
    },
    withDryRun: async (fn: () => Promise<unknown>) => {
      state.dry = true;
      try {
        return await fn();
      } finally {
        state.dry = false;
      }
    },
    updateDocuments: vi.fn(async (_t: string, u: object[]) => {
      state.seenDry = state.dry;
      return u;
    }),
  } as unknown as FoundryClient & { updateDocuments: ReturnType<typeof vi.fn> };
  return Object.assign(c, { state: state as typeof state & { seenDry?: boolean } });
}

const CODE = 'await foundry.update("Actor", [{_id:"a1", name:"Gob"}]); return 1;';
const text = (r: Awaited<ReturnType<typeof handleRunScript>>) => r.content[0]?.text ?? '';

describe('handleRunScript', () => {
  beforeEach(() => resetSeenScripts());

  it('runs a new script as a dry run, then for real on the repeat', async () => {
    const c = client();
    const first = await handleRunScript({ code: CODE }, c);
    expect(text(first)).toContain('DRY RUN');
    expect(c.state.seenDry).toBe(true);
    const second = await handleRunScript({ code: CODE }, c);
    expect(text(second)).not.toContain('DRY RUN');
    expect(c.state.seenDry).toBe(false);
    expect(text(second)).toContain('batch b-1');
  });

  it('honors an explicit dry_run=false on the first run', async () => {
    const c = client();
    const r = await handleRunScript({ code: CODE, dry_run: false }, c);
    expect(text(r)).not.toContain('DRY RUN');
  });

  it('reports script errors', async () => {
    const r = await handleRunScript({ code: 'throw new Error("bad")' }, client());
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('bad');
  });

  it('aborts when the call budget is exceeded', async () => {
    const r = await handleRunScript(
      { code: 'for (let i=0;i<200;i++) await foundry.list("Actor"); return 1;' },
      client(),
    );
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('budget');
  });
});
