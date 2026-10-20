import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { handleGenerateEncounter, handlePlaceEncounter } from '../encounter.js';

const SCENE = 'SCENEAAAAAAAAAAA';
const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? '';

const pc = (id: string, level: number) => ({
  _id: id,
  name: id,
  type: 'character',
  items: [{ _id: `${id}cls`, type: 'class', name: 'Fighter', system: { levels: level } }],
  system: {},
});

function client(opts: { actors?: unknown[]; dry?: boolean } = {}) {
  const createSceneTokens = vi.fn(async (_s: string, _a: string, t: unknown[]) =>
    t.map((_, i) => ({ id: `TOK${i}`, name: 'x', x: 0, y: 0 })),
  );
  const importCompendiumDocument = vi.fn(async (_p: string, id: string) => ({
    type: 'Actor',
    id: `NEW${id}`,
    name: `Imported ${id}`,
    document: {},
  }));
  const startCombat = vi.fn(async () => ({ combatId: 'COMBAT', combatantCount: 3 }));
  const createDocuments = vi.fn(async () => [{ _id: 'FOLDERAAAAAAAAAA' }]);
  const batchRuns = vi.fn();
  const mock = {
    getWorldSnapshot: () => ({
      folders: [],
      users: [
        { name: 'A', character: 'PC1', role: 1 },
        { name: 'B', character: 'PC2', role: 1 },
      ],
      actors: opts.actors ?? [pc('PC1', 3), pc('PC2', 5)],
      scenes: [
        {
          _id: SCENE,
          name: 'Hall',
          active: false,
          width: 2000,
          height: 1000,
          padding: 0,
          grid: { size: 100 },
        },
      ],
    }),
    listPacks: () => [
      { id: 'dnd5e.monsters', label: 'M', type: 'Actor', packageName: 'dnd5e', count: 3 },
      { id: 'dnd5e.spells', label: 'S', type: 'Item', packageName: 'dnd5e', count: 1 },
    ],
    getPackIndexFields: vi.fn(async () => [
      {
        _id: 'gob',
        name: 'Goblin',
        type: 'npc',
        system: {
          details: {
            cr: 0.25,
            type: { value: 'humanoid' },
            habitat: { value: [{ type: 'forest' }] },
          },
        },
      },
      {
        _id: 'skel',
        name: 'Skeleton',
        type: 'npc',
        system: { details: { cr: 0.25, type: { value: 'undead' }, habitat: { value: [] } } },
      },
      { _id: 'nocr', name: 'Blob', type: 'npc', system: { details: { cr: null } } },
    ]),
    getCompendiumDocument: vi.fn(async () => ({ prototypeToken: { width: 1 } })),
    importCompendiumDocument,
    createSceneTokens,
    startCombat,
    createDocuments,
    getCurrentBatchId: () => 'b-test',
    isDryRunning: () => opts.dry ?? false,
    withBatch: async (fn: () => Promise<unknown>) => {
      batchRuns();
      return fn();
    },
  } as unknown as FoundryClient;
  return {
    mock,
    createSceneTokens,
    importCompendiumDocument,
    startCombat,
    batchRuns,
    createDocuments,
  };
}

describe('handleGenerateEncounter', () => {
  it('computes the budget from party levels and prints place_encounter input', async () => {
    const c = client();
    const out = text(await handleGenerateEncounter({ difficulty: 'moderate' }, c.mock));
    expect(out).toContain('budget 975 XP');
    expect(out).toContain('Compendium.dnd5e.monsters.Actor.gob');
    expect(out).toContain('"count"');
    expect(out).toContain('Nothing was created');
    expect(out).toMatch(/seed \d+/);
  });
  it('reproduces the same options for the same seed', async () => {
    const c = client();
    const a = text(await handleGenerateEncounter({ difficulty: 'moderate', seed: 7 }, c.mock));
    const b = text(await handleGenerateEncounter({ difficulty: 'moderate', seed: 7 }, c.mock));
    expect(a).toContain('seed 7');
    expect(a).toBe(b);
  });
  it('filters by creature type and habitat', async () => {
    const c = client();
    const undead = text(
      await handleGenerateEncounter({ difficulty: 'low', creature_type: 'undead' }, c.mock),
    );
    expect(undead).toContain('Skeleton');
    expect(undead).not.toContain('Goblin');
    const forest = text(
      await handleGenerateEncounter({ difficulty: 'low', environment: 'forest' }, c.mock),
    );
    expect(forest).toContain('Goblin');
    expect(forest).not.toContain('Skeleton');
  });
  it('errors without a party', async () => {
    const c = client({ actors: [] });
    await expect(handleGenerateEncounter({ difficulty: 'low' }, c.mock)).rejects.toThrow(/party/i);
  });
});

describe('handlePlaceEncounter', () => {
  const base = {
    scene: 'Hall',
    area: { x: 1, y: 1, width: 10, height: 4 },
  };

  it('imports once, places hidden tokens and starts combat in one batch', async () => {
    const c = client();
    const out = text(
      await handlePlaceEncounter(
        {
          ...base,
          creatures: [
            { uuid: 'Compendium.dnd5e.monsters.Actor.gob', count: 2 },
            { uuid: 'Compendium.dnd5e.monsters.Actor.gob', count: 1 },
          ],
          start_combat: true,
        },
        c.mock,
      ),
    );
    expect(c.batchRuns).toHaveBeenCalledTimes(1);
    expect(c.importCompendiumDocument).toHaveBeenCalledTimes(1);
    expect(c.importCompendiumDocument.mock.calls[0]?.[2]).toEqual({ folder: 'FOLDERAAAAAAAAAA' });
    expect(c.createSceneTokens).toHaveBeenCalledTimes(1);
    const tokens = c.createSceneTokens.mock.calls[0]?.[2] as Array<{ hidden: boolean }>;
    expect(tokens).toHaveLength(3);
    expect(tokens.every((t) => t.hidden === true)).toBe(true);
    expect(c.startCombat).toHaveBeenCalledTimes(1);
    expect(out).toContain('b-test');
    expect(out).toContain('COMBAT');
  });

  it('reuses a world actor with the same compendium source', async () => {
    const existing = {
      _id: 'EXISTINGAAAAAAAAA',
      name: 'Goblin',
      type: 'npc',
      prototypeToken: { width: 1 },
      _stats: { compendiumSource: 'Compendium.dnd5e.monsters.Actor.gob' },
    };
    const c = client({ actors: [pc('PC1', 3), existing] });
    await handlePlaceEncounter(
      { ...base, creatures: [{ uuid: 'Compendium.dnd5e.monsters.Actor.gob', count: 2 }] },
      c.mock,
    );
    expect(c.importCompendiumDocument).not.toHaveBeenCalled();
    expect(c.createDocuments).not.toHaveBeenCalled();
    expect(c.createSceneTokens.mock.calls[0]?.[1]).toBe('EXISTINGAAAAAAAAA');
  });

  it('writes nothing when the creatures do not fit', async () => {
    const c = client();
    await expect(
      handlePlaceEncounter(
        {
          scene: 'Hall',
          area: { x: 0, y: 0, width: 3, height: 1 },
          creatures: [{ uuid: 'Compendium.dnd5e.monsters.Actor.gob', count: 6 }],
        },
        c.mock,
      ),
    ).rejects.toThrow(/Not enough room/);
    expect(c.importCompendiumDocument).not.toHaveBeenCalled();
    expect(c.batchRuns).not.toHaveBeenCalled();
  });

  it('rejects bad input and skips tokens in dry run', async () => {
    const c = client();
    await expect(
      handlePlaceEncounter({ scene: 'Hall', creatures: [{ uuid: 'x' }] }, c.mock),
    ).rejects.toThrow(/exactly one of area or region_id/);
    await expect(
      handlePlaceEncounter({ ...base, creatures: [{ uuid: 'nonsense' }] }, c.mock),
    ).rejects.toThrow(/uuid/);
    const d = client({ dry: true });
    const out = text(
      await handlePlaceEncounter(
        { ...base, creatures: [{ uuid: 'Compendium.dnd5e.monsters.Actor.gob' }] },
        d.mock,
      ),
    );
    expect(d.createSceneTokens).not.toHaveBeenCalled();
    expect(out).toContain('Dry run');
  });
});
