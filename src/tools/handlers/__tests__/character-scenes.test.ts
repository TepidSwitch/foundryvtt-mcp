/**
 * @fileoverview Unit tests for character lookup/items and scene browsing
 */

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import type { WorldActor, WorldData, WorldItem, WorldScene } from '../../../foundry/types.js';
import { handleGetActorItems, handleGetPartyOverview, resolveActor } from '../character.js';
import {
  folderPath,
  handleGetSceneInfo,
  handleSearchScenes,
  handleSuggestScenes,
  resolveScene,
  tagsFor,
} from '../scenes.js';

const text = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content[0]?.text ?? '';

function spell(
  id: string,
  name: string,
  level: number,
  system: Record<string, unknown> = {},
): WorldItem {
  return {
    _id: id,
    name,
    type: 'spell',
    system: {
      level,
      school: 'evo',
      properties: ['vocal', 'somatic'],
      activation: { type: 'action', value: 1 },
      range: { value: 60, units: 'ft' },
      duration: { units: 'inst' },
      preparation: { mode: 'always', prepared: false },
      description: { value: '<p>Boom.</p>' },
      ...system,
    },
  };
}

const bard: WorldActor = {
  _id: 'aaaaaaaaaaaaaaaa',
  name: 'Ossul kinda tall',
  type: 'character',
  system: {
    abilities: { cha: { value: 20, proficient: 1 }, con: { value: 16 }, dex: { value: 14 } },
    attributes: {
      hp: { value: 11, max: null, temp: 10 },
      ac: { calc: 'default' },
      spellcasting: 'cha',
    },
    skills: {},
  },
  items: [
    {
      _id: 'clsBard00000000001',
      name: 'Bard',
      type: 'class',
      system: {
        identifier: 'bard',
        levels: 10,
        hd: { denomination: 'd8' },
        spellcasting: { progression: 'full', ability: 'cha' },
        advancement: { a: { type: 'HitPoints', value: { '1': 8 } } },
      },
    },
    spell('spl1', 'Counterspell', 3),
    spell('spl2', 'Vicious Mockery', 0),
    spell('spl3', 'Sleep', 1),
    {
      _id: 'ftx1',
      name: 'Bardic Inspiration',
      type: 'feat',
      system: { uses: { max: '4', spent: 1 } },
    },
    {
      _id: 'wpn1',
      name: 'Rapier',
      type: 'weapon',
      system: { quantity: 1, equipped: true, activities: {} },
    },
  ],
};

const other: WorldActor = {
  ...bard,
  _id: 'bbbbbbbbbbbbbbbb',
  name: 'Ossul the Elder',
  type: 'npc',
  items: [],
};

function scene(over: Partial<WorldScene> & Record<string, unknown>): WorldScene {
  return {
    _id: 'sc00000000000001',
    name: 'Scene',
    active: false,
    navigation: false,
    width: 2800,
    height: 2100,
    padding: 0.25,
    darkness: 0,
    globalLight: false,
    grid: { size: 70, distance: 5, units: 'ft' },
    tokens: [],
    walls: [],
    lights: [],
    notes: [],
    ...over,
  } as WorldScene;
}

const arr = (n: number, extra: Record<string, unknown> = {}) =>
  Array.from({ length: n }, () => ({ ...extra }));

const snapshot: WorldData = {
  userId: 'gm',
  release: {},
  world: {},
  system: {},
  modules: [],
  demoMode: false,
  actors: [bard, other],
  scenes: [
    scene({
      _id: 'scTemple0000000001',
      name: 'Jade Temple',
      folder: 'fChild',
      walls: arr(145),
      lights: arr(11),
      tokens: arr(10, { disposition: -1, name: 'Cultist' }),
    }),
    scene({ _id: 'scTavern0000000001', name: 'Dockside Tavern', walls: arr(123), lights: arr(8) }),
    scene({ _id: 'scBare00000000001', name: 'Empty Field' }),
  ],
  items: [],
  journal: [],
  messages: [],
  combats: [],
  users: [
    { _id: 'uSkander', name: 'Skander', role: 2, color: '#fff', character: 'aaaaaaaaaaaaaaaa' },
    { _id: 'uGM', name: 'Stasykins', role: 4, color: '#fff' },
  ],
  activeUsers: [],
  settings: [],
  folders: [
    { _id: 'fRoot', name: 'Dako', type: 'Scene', folder: null },
    { _id: 'fChild', name: 'Temples', type: 'Scene', folder: 'fRoot' },
  ],
  macros: [],
  playlists: [],
  tables: [],
  cards: [],
  packs: [],
};

const client = {
  getWorldSnapshot: () => snapshot,
  getScenes: () => snapshot.scenes,
} as unknown as FoundryClient;

describe('resolveActor', () => {
  it('resolves by id, exact name, partial name and player name', () => {
    expect(resolveActor(client, 'aaaaaaaaaaaaaaaa').name).toBe('Ossul kinda tall');
    expect(resolveActor(client, 'ossul kinda tall').name).toBe('Ossul kinda tall');
    expect(resolveActor(client, 'kinda').name).toBe('Ossul kinda tall');
    expect(resolveActor(client, 'skander').name).toBe('Ossul kinda tall');
  });

  it('prefers the single character when a partial name is ambiguous', () => {
    expect(resolveActor(client, 'ossul').type).toBe('character');
  });

  it('rejects unknown names with guidance', () => {
    expect(() => resolveActor(client, 'nobody')).toThrow(McpError);
  });
});

describe('handleGetActorItems', () => {
  it('groups spells by level and prints item ids and prep state', async () => {
    const out = text(await handleGetActorItems({ actor: 'Skander', type: 'spell' }, client));
    expect(out).toContain('Cantrips');
    expect(out).toContain('Level 3 spells');
    expect(out.indexOf('Vicious Mockery')).toBeLessThan(out.indexOf('Sleep'));
    expect(out).toContain('`spl1`');
    expect(out).toContain('always prepared');
    expect(out).not.toContain('Rapier');
  });

  it('filters by name and shows uses for features', async () => {
    const out = text(
      await handleGetActorItems({ actor: 'Ossul kinda tall', query: 'inspiration' }, client),
    );
    expect(out).toContain('Bardic Inspiration');
    expect(out).toContain('3/4 uses');
  });

  it('includes descriptions when details=true', async () => {
    const out = text(
      await handleGetActorItems(
        { actor: 'Ossul kinda tall', type: 'spell', query: 'sleep', details: true },
        client,
      ),
    );
    expect(out).toContain('Boom.');
  });

  it('requires an actor', async () => {
    await expect(handleGetActorItems({}, client)).rejects.toThrow(McpError);
  });
});

describe('handleGetPartyOverview', () => {
  it('lists assigned player characters with computed HP and ids', async () => {
    const out = text(await handleGetPartyOverview({}, client));
    expect(out).toContain('Skander');
    expect(out).toContain('Ossul kinda tall');
    expect(out).toContain('Bard 10');
    expect(out).toContain('`aaaaaaaaaaaaaaaa`');
    expect(out).toContain('GM: Stasykins');
  });
});

describe('scene helpers', () => {
  it('builds folder paths through parents', () => {
    expect(folderPath(snapshot, 'fChild')).toBe('Dako / Temples');
    expect(folderPath(snapshot, null)).toBe('');
  });

  it('tags scenes from name and folder', () => {
    expect(tagsFor('Dockside Tavern', '')).toEqual(expect.arrayContaining(['social', 'nautical']));
    expect(tagsFor('Jade Temple', 'Dako')).toContain('dungeon');
  });

  it('resolves scenes by id and name and rejects ambiguity', () => {
    expect(resolveScene(snapshot, 'Jade').name).toBe('Jade Temple');
    expect(resolveScene(snapshot, 'scBare00000000001').name).toBe('Empty Field');
    expect(() => resolveScene(snapshot, 'e')).toThrow(McpError);
    expect(() => resolveScene(snapshot, 'zzz')).toThrow(McpError);
  });
});

describe('scene tools', () => {
  it('ranks a walled, lit, populated scene above a bare one', async () => {
    const out = text(await handleSuggestScenes({}, client));
    expect(out.indexOf('Jade Temple')).toBeLessThan(out.indexOf('Dockside Tavern'));
    expect(out.indexOf('Dockside Tavern')).toBeLessThan(out.indexOf('Empty Field'));
    expect(out).toContain('hostiles: Cultist');
  });

  it('filters by theme and biases by purpose', async () => {
    const out = text(await handleSuggestScenes({ theme: 'tavern', purpose: 'social' }, client));
    expect(out).toContain('Dockside Tavern');
    expect(out).not.toContain('Jade Temple');
  });

  it('rejects an unknown purpose', async () => {
    await expect(handleSuggestScenes({ purpose: 'chaos' }, client)).rejects.toThrow(McpError);
  });

  it('searches with structural filters', async () => {
    const out = text(await handleSearchScenes({ min_tokens: 1 }, client));
    expect(out).toContain('Jade Temple');
    expect(out).not.toContain('Empty Field');
    expect(text(await handleSearchScenes({ folder: 'temples' }, client))).toContain('1 of 3');
  });

  it('shows tokens and readiness in scene info', async () => {
    const out = text(await handleGetSceneInfo({ name: 'Jade Temple' }, client));
    expect(out).toMatch(/Cultist `\w*` \(hostile\)/);
    expect(out).toContain('Dako / Temples');
    expect(out).toContain('Readiness');
  });
});
