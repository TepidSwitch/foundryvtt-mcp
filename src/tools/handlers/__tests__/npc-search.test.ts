import { describe, expect, it } from 'vitest';
import { fakeFoundry } from '../../../test-utils/fake-foundry.js';
import { handleGenerateEncounter } from '../encounter.js';
import { handleFindNpc } from '../npc-search.js';

const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? '';

const npc = (id: string, name: string, cr: number, type: string, habitat: string[] = []) => ({
  _id: id,
  name,
  type: 'npc',
  system: {
    details: { cr, type: { value: type }, habitat: { value: habitat.map((t) => ({ type: t })) } },
  },
});

const pack = {
  id: 'world.monsters',
  type: 'Actor',
  documents: [
    npc('aaaaaaaaaaaaaa01', 'Goblin Boss', 1, 'humanoid', ['forest']),
    npc('aaaaaaaaaaaaaa02', 'Goblin Warrior', 0.25, 'humanoid', ['forest']),
    npc('aaaaaaaaaaaaaa03', 'Adult Red Dragon', 17, 'dragon', ['mountain']),
    npc('aaaaaaaaaaaaaa04', 'Adult Red Dragon (Legacy)', 17, 'dragon', ['mountain']),
    npc('aaaaaaaaaaaaaa05', 'Ogre', 2, 'giant', ['hill']),
    npc('aaaaaaaaaaaaaa06', 'Ogre (Legacy)', 2, 'giant'),
    npc('aaaaaaaaaaaaaa07', 'Skeleton', 0.25, 'undead'),
    { _id: 'aaaaaaaaaaaaaa08', name: 'Bob', type: 'character', system: {} },
  ],
};

describe('handleFindNpc', () => {
  it('sorts by closeness to cr, then name, with uuids and an import hint', async () => {
    const { client } = fakeFoundry({ packs: [pack] });
    const out = text(await handleFindNpc({ cr: 1 }, client));
    const order = ['Goblin Boss', 'Goblin Warrior', 'Skeleton', 'Ogre', 'Adult Red Dragon'];
    const idx = order.map((n) => out.indexOf(`**${n}**`));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(out).toContain('Compendium.world.monsters.Actor.aaaaaaaaaaaaaa01');
    expect(out).toContain('foundry_actors_edit import');
    expect(out).not.toContain('Bob');
  });
  it('hides legacy twins unless legacy is true', async () => {
    const { client } = fakeFoundry({ packs: [pack] });
    expect(text(await handleFindNpc({ query: 'dragon' }, client))).not.toContain('(Legacy)');
    expect(text(await handleFindNpc({ query: 'dragon', legacy: true }, client))).toContain(
      'Adult Red Dragon (Legacy)',
    );
  });
  it('filters by cr range, type, habitat and limit', async () => {
    const { client } = fakeFoundry({ packs: [pack] });
    const range = text(await handleFindNpc({ cr_min: 1, cr_max: 2 }, client));
    expect(range).toContain('Ogre');
    expect(range).toContain('Goblin Boss');
    expect(range).not.toContain('Dragon');
    expect(text(await handleFindNpc({ creature_type: 'undead' }, client))).toContain('1 match');
    expect(text(await handleFindNpc({ environment: 'hill' }, client))).toContain('**Ogre**');
    expect(text(await handleFindNpc({ limit: 1 }, client))).toContain('showing 1');
  });
});

describe('handleGenerateEncounter with 2024 preference', () => {
  const world = {
    users: [{ _id: 'USERAAAAAAAAAAAA', name: 'A', role: 1, character: 'PCAAAAAAAAAAAAAA' }],
    actors: [
      {
        _id: 'PCAAAAAAAAAAAAAA',
        name: 'Hero',
        type: 'character',
        items: [{ _id: 'cls', type: 'class', name: 'Fighter', system: { levels: 5 } }],
        system: {},
      },
    ],
  };
  it('drops legacy statblocks by default and keeps them on request', async () => {
    const { client } = fakeFoundry({ world, packs: [pack] });
    const a = text(await handleGenerateEncounter({ difficulty: 'high', seed: 1 }, client));
    expect(a).not.toContain('(Legacy)');
    expect(a).toContain('2024 statblocks preferred');
    const b = text(
      await handleGenerateEncounter({ difficulty: 'high', seed: 1, legacy: true }, client),
    );
    expect(b).toContain('legacy statblocks kept');
  });
});
