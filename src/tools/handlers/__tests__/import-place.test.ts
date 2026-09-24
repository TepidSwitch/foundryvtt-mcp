/**
 * @fileoverview Unit tests for the additive write tools (compendium import,
 * token placement) and the pure helpers behind them.
 */

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import {
  buildTokenData,
  cleanForImport,
  compendiumUuid,
  sceneOrigin,
  sceneSquares,
  squareToPixels,
} from '../../../foundry/import.js';
import type { WorldData } from '../../../foundry/types.js';
import { handleImportFromCompendium, handlePlaceActorOnScene } from '../import-place.js';

const text = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content[0]?.text ?? '';

describe('cleanForImport', () => {
  const source = {
    _id: 'mmYoungRedDragon',
    name: 'Young Red Dragon',
    type: 'npc',
    sort: 400,
    folder: 'compFolder',
    ownership: { default: 3 },
    _stats: { systemVersion: '5.2.5' },
    items: [{ _id: 'itemAAAAAAAAAAAA', name: 'Rend', type: 'weapon' }],
    system: { attributes: { hp: { value: 178 } } },
  };
  const opts = {
    packId: 'dnd5e.actors24',
    packType: 'Actor',
    documentId: 'mmYoungRedDragon',
  };

  it('drops identity, sort, ownership and folder and records the compendium source', () => {
    const data = cleanForImport(source, opts);
    expect(data._id).toBeUndefined();
    expect('_id' in data).toBe(false);
    expect('sort' in data).toBe(false);
    expect('ownership' in data).toBe(false);
    expect(data.folder).toBeNull();
    expect(data._stats).toEqual({
      compendiumSource: 'Compendium.dnd5e.actors24.Actor.mmYoungRedDragon',
    });
    expect(data.name).toBe('Young Red Dragon');
  });

  it('keeps embedded documents and their ids (activities can reference them)', () => {
    const data = cleanForImport(source, opts);
    expect(data.items).toEqual([{ _id: 'itemAAAAAAAAAAAA', name: 'Rend', type: 'weapon' }]);
  });

  it('applies a new name and a target folder', () => {
    const data = cleanForImport(source, { ...opts, name: 'Ember', folder: 'worldFolder0001' });
    expect(data.name).toBe('Ember');
    expect(data.folder).toBe('worldFolder0001');
  });

  it('omits the folder entirely for embedded creation', () => {
    const data = cleanForImport(source, { ...opts, embedded: true, folder: 'ignored' });
    expect('folder' in data).toBe(false);
  });

  it('never leaves an imported scene active', () => {
    const data = cleanForImport(
      { _id: 's1', name: 'Map', active: true },
      { packId: 'p.maps', packType: 'Scene', documentId: 's1' },
    );
    expect(data.active).toBe(false);
  });

  it('does not mutate the source document', () => {
    cleanForImport(source, opts);
    expect(source._id).toBe('mmYoungRedDragon');
    expect(source.ownership).toEqual({ default: 3 });
  });

  it('formats the compendium uuid', () => {
    expect(compendiumUuid('dnd5e.spells24', 'Item', 'abc')).toBe(
      'Compendium.dnd5e.spells24.Item.abc',
    );
  });
});

describe('scene geometry', () => {
  // Real values from the Jade Temple scene: 1960×4200, 140px grid, 25% padding
  const jade = { width: 1960, height: 4200, padding: 0.25, gridSize: 140 };

  it('offsets canvas coordinates by the padding rounded up to whole squares', () => {
    expect(sceneOrigin(jade)).toEqual({ x: 4 * 140, y: 8 * 140 });
    expect(sceneSquares(jade)).toEqual({ cols: 14, rows: 30 });
  });

  it('converts a grid square to canvas pixels', () => {
    expect(squareToPixels(jade, 0, 0)).toEqual({ x: 560, y: 1120 });
    // An existing party token at canvas x=1960 sits at map column 10
    expect(squareToPixels(jade, 10, 0).x).toBe(1960);
  });

  it('adds a manual scene shift', () => {
    expect(sceneOrigin({ ...jade, shiftX: 70, shiftY: -70 })).toEqual({ x: 630, y: 1050 });
  });
});

describe('buildTokenData', () => {
  const proto = {
    _id: 'protoid',
    name: 'Dragon',
    width: 3,
    height: 3,
    actorLink: false,
    texture: { src: 'a.webp' },
    disposition: -1,
  };

  it('builds token data from the prototype token', () => {
    const data = buildTokenData('actorAAAAAAAAAAAA', proto, { x: 100, y: 200 });
    expect(data).toMatchObject({
      actorId: 'actorAAAAAAAAAAAA',
      x: 100,
      y: 200,
      name: 'Dragon',
      width: 3,
      disposition: -1,
      actorLink: false,
    });
    expect('_id' in data).toBe(false);
  });

  it('applies overrides and tolerates a missing prototype', () => {
    const data = buildTokenData('actorAAAAAAAAAAAA', undefined, {
      x: 0,
      y: 0,
      name: 'Boss',
      hidden: true,
      disposition: 0,
    });
    expect(data).toEqual({
      actorId: 'actorAAAAAAAAAAAA',
      x: 0,
      y: 0,
      name: 'Boss',
      hidden: true,
      disposition: 0,
    });
    expect(proto.name).toBe('Dragon');
  });
});

// --- handlers ------------------------------------------------------------

function makeClient(over: Record<string, unknown> = {}) {
  const snapshot = {
    actors: [
      {
        _id: 'ossulossulossul1',
        name: 'Ossul kinda tall',
        type: 'character',
        system: {},
        items: [{ _id: 'existingitem0001', name: 'Sleep', type: 'spell' }],
        prototypeToken: { name: 'Ossul kinda tall', width: 1, height: 1, actorLink: true },
      },
      {
        _id: 'goblingoblingob1',
        name: 'Goblin',
        type: 'npc',
        system: {},
        items: [],
        prototypeToken: { name: 'Goblin', width: 1, height: 1, actorLink: false, disposition: -1 },
      },
    ],
    scenes: [
      {
        _id: 'scenesceneScene1',
        name: 'Jade Temple',
        active: true,
        navigation: false,
        width: 1960,
        height: 4200,
        padding: 0.25,
        darkness: 0,
        globalLight: false,
        grid: { size: 140 },
      },
      {
        _id: 'scenesceneScene2',
        name: 'Quiet Cave',
        active: false,
        navigation: false,
        width: 700,
        height: 700,
        padding: 0,
        darkness: 0,
        globalLight: false,
        grid: { size: 70 },
      },
    ],
    items: [],
    journal: [],
    tables: [],
    users: [],
    folders: [{ _id: 'folderActors0001', name: 'Monsters', type: 'Actor', folder: null }],
    packs: [],
  } as unknown as WorldData;

  const importCompendiumDocument = vi.fn(async (_p: string, id: string, o: { name?: string }) => ({
    type: 'Actor',
    id: 'newnewnewnewnew1',
    name: o.name ?? 'Young Red Dragon',
    document: { _id: id },
  }));
  const createSceneTokens = vi.fn(
    async (_s: string, _a: string, tokens: Array<{ x: number; y: number; name?: string }>) =>
      tokens.map((t, i) => ({
        id: `token00000000000${i}`,
        name: t.name ?? 'Goblin',
        x: t.x,
        y: t.y,
      })),
  );
  const client = {
    getWorldSnapshot: () => snapshot,
    listPacks: () => [
      { id: 'dnd5e.actors24', label: 'Actors', type: 'Actor', packageName: 'dnd5e', count: 3 },
      { id: 'dnd5e.spells24', label: 'Spells', type: 'Item', packageName: 'dnd5e', count: 3 },
      {
        id: 'dnd5e.content24',
        label: 'Rules',
        type: 'JournalEntry',
        packageName: 'dnd5e',
        count: 3,
      },
      { id: 'weird.pack', label: 'Macros', type: 'Macro', packageName: 'x', count: 1 },
    ],
    getPackIndex: async (id: string) =>
      id === 'dnd5e.actors24'
        ? [{ _id: 'mmYoungRedDragon', name: 'Young Red Dragon' }]
        : [{ _id: 'phbsplCounterspe', name: 'Counterspell' }],
    getCompendiumDocument: async (_p: string, id: string) => ({
      _id: id,
      name: id === 'phbsplCounterspe' ? 'Counterspell' : 'Young Red Dragon',
    }),
    importCompendiumDocument,
    createSceneTokens,
    ...over,
  } as unknown as FoundryClient;
  return { client, importCompendiumDocument, createSceneTokens };
}

describe('handleImportFromCompendium', () => {
  it('imports a monster into an existing folder by name', async () => {
    const { client, importCompendiumDocument } = makeClient();
    const out = text(
      await handleImportFromCompendium(
        {
          compendiumId: 'dnd5e.actors24',
          name: 'Young Red Dragon',
          folder: 'monsters',
          new_name: 'Ember',
        },
        client,
      ),
    );
    expect(importCompendiumDocument).toHaveBeenCalledWith('dnd5e.actors24', 'mmYoungRedDragon', {
      name: 'Ember',
      folder: 'folderActors0001',
    });
    expect(out).toContain('Imported **Ember**');
    expect(out).toContain('newnewnewnewnew1');
    expect(out).toContain('Nothing existing was modified');
  });

  it('adds a compendium item to an actor resolved by player-independent name', async () => {
    const { client, importCompendiumDocument } = makeClient();
    const out = text(
      await handleImportFromCompendium(
        { compendiumId: 'dnd5e.spells24', name: 'Counterspell', actor: 'Ossul' },
        client,
      ),
    );
    expect(importCompendiumDocument).toHaveBeenCalledWith('dnd5e.spells24', 'phbsplCounterspe', {
      actorId: 'ossulossulossul1',
    });
    expect(out).toContain('on **Ossul kinda tall**');
  });

  it('warns when a same-named document already exists instead of blocking', async () => {
    const { client } = makeClient();
    const out = text(
      await handleImportFromCompendium(
        {
          compendiumId: 'dnd5e.spells24',
          documentId: 'phbsplCounterspe',
          actor: 'Ossul',
          new_name: 'Sleep',
        },
        client,
      ),
    );
    expect(out).toContain('already existed');
  });

  it('rejects unsafe or invalid requests before writing anything', async () => {
    const { client, importCompendiumDocument } = makeClient();
    await expect(handleImportFromCompendium({}, client)).rejects.toThrow(McpError);
    await expect(
      handleImportFromCompendium({ compendiumId: 'dnd5e.actors24' }, client),
    ).rejects.toThrow(McpError);
    await expect(
      handleImportFromCompendium({ compendiumId: 'nope', name: 'x' }, client),
    ).rejects.toThrow(McpError);
    await expect(
      handleImportFromCompendium({ compendiumId: 'weird.pack', name: 'x' }, client),
    ).rejects.toThrow(/not supported/);
    // actor only makes sense for item packs
    await expect(
      handleImportFromCompendium(
        { compendiumId: 'dnd5e.actors24', name: 'Young Red Dragon', actor: 'Ossul' },
        client,
      ),
    ).rejects.toThrow(/Item compendiums/);
    // folders are never invented
    await expect(
      handleImportFromCompendium(
        { compendiumId: 'dnd5e.actors24', name: 'Young Red Dragon', folder: 'No Such Folder' },
        client,
      ),
    ).rejects.toThrow(/No Actor folder/);
    await expect(
      handleImportFromCompendium(
        {
          compendiumId: 'dnd5e.spells24',
          name: 'Counterspell',
          actor: 'Ossul',
          folder: 'Monsters',
        },
        client,
      ),
    ).rejects.toThrow(/folder does not apply/);
    expect(importCompendiumDocument).not.toHaveBeenCalled();
  });
});

describe('handlePlaceActorOnScene', () => {
  it('places one token at the requested grid square in canvas pixels', async () => {
    const { client, createSceneTokens } = makeClient();
    const out = text(
      await handlePlaceActorOnScene(
        { scene: 'Jade Temple', actor: 'Goblin', x: 2, y: 3, hidden: true, disposition: 'hostile' },
        client,
      ),
    );
    // origin (560,1120) + (2,3) squares of 140px
    expect(createSceneTokens).toHaveBeenCalledWith('scenesceneScene1', 'goblingoblingob1', [
      { x: 560 + 280, y: 1120 + 420, hidden: true, disposition: -1 },
    ]);
    expect(out).toContain('Placed 1 token');
    expect(out).toContain('(2, 3)');
    expect(out).not.toContain('players can see them');
  });

  it('centres the token when no position is given and warns on a live scene', async () => {
    const { client, createSceneTokens } = makeClient();
    const out = text(
      await handlePlaceActorOnScene({ scene: 'Jade Temple', actor: 'Goblin' }, client),
    );
    // 14×30 map → centre square (7, 15)
    expect(createSceneTokens.mock.calls[0]?.[2]).toEqual([
      { x: 560 + 7 * 140, y: 1120 + 15 * 140 },
    ]);
    expect(out).toContain('players can see them now');
  });

  it('places several numbered tokens in a row, wrapping at the map edge', async () => {
    const { client, createSceneTokens } = makeClient();
    // Quiet Cave: 10×10, no padding. Start at column 8 so the third token wraps.
    await handlePlaceActorOnScene(
      { scene: 'Quiet Cave', actor: 'Goblin', x: 8, y: 0, count: 4 },
      client,
    );
    const tokens = createSceneTokens.mock.calls[0]?.[2] ?? [];
    expect(tokens.map((t) => t.name)).toEqual(['Goblin 1', 'Goblin 2', 'Goblin 3', 'Goblin 4']);
    expect(tokens.map((t) => [t.x / 70, t.y / 70])).toEqual([
      [8, 0],
      [9, 0],
      [8, 1],
      [9, 1],
    ]);
  });

  it('refuses positions outside the map and bad arguments, without writing', async () => {
    const { client, createSceneTokens } = makeClient();
    await expect(
      handlePlaceActorOnScene({ scene: 'Quiet Cave', actor: 'Goblin', x: 50, y: 50 }, client),
    ).rejects.toThrow(/outside/);
    await expect(
      handlePlaceActorOnScene({ scene: 'Quiet Cave', actor: 'Goblin', x: 1 }, client),
    ).rejects.toThrow(/both x and y/);
    await expect(
      handlePlaceActorOnScene({ scene: 'Quiet Cave', actor: 'Goblin', count: 99 }, client),
    ).rejects.toThrow(/1 to 20/);
    await expect(
      handlePlaceActorOnScene(
        { scene: 'Quiet Cave', actor: 'Goblin', disposition: 'grumpy' },
        client,
      ),
    ).rejects.toThrow(/disposition/);
    await expect(
      handlePlaceActorOnScene({ scene: 'Nowhere', actor: 'Goblin' }, client),
    ).rejects.toThrow(McpError);
    await expect(
      handlePlaceActorOnScene({ scene: 'Quiet Cave', actor: 'Nobody' }, client),
    ).rejects.toThrow(McpError);
    expect(createSceneTokens).not.toHaveBeenCalled();
  });
});
