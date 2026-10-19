import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../foundry/client.js';
import { BudgetError, ScriptApi } from '../api.js';

function fakeClient() {
  return {
    getWorldData: () => ({ actors: [{ _id: 'a1', name: 'Goblin', type: 'npc' }] }),
    getUserId: () => 'u1',
    createDocuments: vi.fn(async (_t: string, d: object[]) =>
      d.map((x, i) => ({ ...x, _id: `n${i}` })),
    ),
    updateDocuments: vi.fn(async (_t: string, u: object[]) => u),
    deleteDocuments: vi.fn(async (_t: string, ids: string[]) => ids),
  } as unknown as FoundryClient & Record<string, ReturnType<typeof vi.fn>>;
}

describe('ScriptApi', () => {
  it('lists and gets from the cache', async () => {
    const api = new ScriptApi(fakeClient());
    expect(await api.call('list', ['Actor', { query: 'gob' }])).toHaveLength(1);
    expect(await api.call('get', ['Actor', 'a1'])).toMatchObject({ name: 'Goblin' });
    await expect(api.call('get', ['Actor', 'zz'])).rejects.toThrow('not found');
  });

  it('enforces the call budget', async () => {
    const api = new ScriptApi(fakeClient(), { maxCalls: 2, maxDeletes: 30 });
    await api.call('list', ['Actor']);
    await api.call('list', ['Actor']);
    await expect(api.call('list', ['Actor'])).rejects.toBeInstanceOf(BudgetError);
  });

  it('enforces the delete budget by id count', async () => {
    const c = fakeClient();
    const api = new ScriptApi(c, { maxCalls: 150, maxDeletes: 3 });
    await api.call('delete', ['Item', ['1', '2']]);
    await expect(api.call('delete', ['Item', ['3', '4']])).rejects.toBeInstanceOf(BudgetError);
    expect(c.deleteDocuments).toHaveBeenCalledTimes(1);
  });

  it('refuses User and Setting writes', async () => {
    const api = new ScriptApi(fakeClient());
    await expect(api.call('update', ['User', [{ _id: 'x' }]])).rejects.toThrow('may not write');
    await expect(api.call('create', ['Setting', [{}]])).rejects.toThrow('may not write');
  });

  it('sends chat with the author', async () => {
    const c = fakeClient();
    await new ScriptApi(c).call('chat', ['hello']);
    expect(c.createDocuments).toHaveBeenCalledWith('ChatMessage', [
      { content: 'hello', author: 'u1' },
    ]);
  });

  it('passes the parent uuid for embedded writes', async () => {
    const c = fakeClient();
    await new ScriptApi(c).call('create', ['Token', [{}], { parent: 'Scene.s1' }]);
    expect(c.createDocuments).toHaveBeenCalledWith('Token', [{}], 'Scene.s1');
  });

  it('rejects unknown methods', async () => {
    await expect(new ScriptApi(fakeClient()).call('eval', [])).rejects.toThrow('Unknown');
  });
});
