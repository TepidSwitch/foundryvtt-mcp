import { describe, expect, it } from 'vitest';
import { fakeFoundry } from '../../../test-utils/fake-foundry.js';
import { handleDeleteToken, handleUpdateToken } from '../token-mutations.js';
import {
  handleCreateWorldItem,
  handleDeleteWorldItem,
  handleUpdateWorldItem,
} from '../world-items.js';

const ITEM = 'ITEMAAAAAAAAAAAA';
const SCENE = 'SCENEAAAAAAAAAAA';
const TOKEN = 'TOKENAAAAAAAAAAA';

function setup() {
  const f = fakeFoundry({
    world: {
      items: [{ _id: ITEM, name: 'Cloak of Elvenkind', type: 'equipment' }],
      folders: [{ _id: 'FOLDERAAAAAAAAAA', name: 'Loot', type: 'Item' }],
      scenes: [{ _id: SCENE, name: 'Inn', tokens: [{ _id: TOKEN, name: 'Goblin' }] }],
    },
  });
  const tokens = () => (f.world.scenes?.[0]?.tokens as Array<Record<string, unknown>>) ?? [];
  return { ...f, mock: f.client, tokens };
}

describe('world item handlers', () => {
  it('creates, updates and deletes a world item', async () => {
    const { mock, world } = setup();
    await handleCreateWorldItem(
      { name: 'Rope', type: 'loot', system: { weight: { value: 10 } }, folder: 'Loot' },
      mock,
    );
    expect(world.items?.find((i) => i.name === 'Rope')).toMatchObject({
      type: 'loot',
      system: { weight: { value: 10 } },
      folder: 'FOLDERAAAAAAAAAA', // folder resolved by name
    });
    await handleUpdateWorldItem({ item: 'cloak', name: 'Cloak', system: { rarity: 'rare' } }, mock);
    expect(world.items?.find((i) => i._id === ITEM)).toMatchObject({
      name: 'Cloak',
      system: { rarity: 'rare' },
    });
    await expect(handleUpdateWorldItem({ item: 'cloak' }, mock)).rejects.toThrow(/at least one/);
    await handleDeleteWorldItem({ item: ITEM }, mock);
    expect(world.items?.map((i) => i.name)).toEqual(['Rope']);
  });
});

describe('token update and delete', () => {
  it('maps friendly names to Foundry values and sets size as width and height', async () => {
    const { mock, tokens } = setup();
    await handleUpdateToken(
      { tokenId: TOKEN, hidden: true, disposition: 'hostile', size: 2, elevation: 10 },
      mock,
    );
    expect(tokens()[0]).toMatchObject({
      name: 'Goblin',
      hidden: true,
      elevation: 10,
      disposition: -1,
      width: 2,
      height: 2,
    });
  });

  it('rejects an empty update and an unknown token', async () => {
    const { mock, sent } = setup();
    await expect(handleUpdateToken({ tokenId: TOKEN }, mock)).rejects.toThrow(/at least one/);
    await expect(handleUpdateToken({ tokenId: 'NOPE', hidden: true }, mock)).rejects.toThrow(
      /Token not found/,
    );
    expect(sent.filter((s) => s.action !== 'get')).toEqual([]);
  });

  it('deletes a token from its scene', async () => {
    const { mock, tokens } = setup();
    await handleDeleteToken({ tokenId: TOKEN }, mock);
    expect(tokens()).toEqual([]);
  });
});
