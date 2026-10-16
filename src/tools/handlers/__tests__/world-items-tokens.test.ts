import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { handleDeleteToken, handleUpdateToken } from '../token-mutations.js';
import {
  handleCreateWorldItem,
  handleDeleteWorldItem,
  handleUpdateWorldItem,
} from '../world-items.js';

const ITEM = 'ITEMAAAAAAAAAAAA';
const SCENE = 'SCENEAAAAAAAAAAA';
const TOKEN = 'TOKENAAAAAAAAAAA';

function client() {
  const calls = {
    createDocuments: vi.fn(async () => [{ _id: 'NEWITEMAAAAAAAAA' }]),
    updateDocuments: vi.fn(async () => []),
    deleteDocuments: vi.fn(async () => []),
  };
  const scene = { _id: SCENE, name: 'Inn', tokens: [{ _id: TOKEN, name: 'Goblin' }] };
  const mock = {
    getWorldSnapshot: () => ({
      items: [{ _id: ITEM, name: 'Cloak of Elvenkind', type: 'equipment' }],
      folders: [{ _id: 'FOLDERAAAAAAAAAA', name: 'Loot', type: 'Item' }],
      scenes: [scene],
    }),
    findToken: (id: string) => (id === TOKEN ? { scene, token: scene.tokens[0] } : null),
    ...calls,
  } as unknown as FoundryClient;
  return { mock, ...calls };
}

describe('world item handlers', () => {
  it('creates, updates and deletes a world item', async () => {
    const { mock, createDocuments, updateDocuments, deleteDocuments } = client();
    await handleCreateWorldItem(
      { name: 'Rope', type: 'loot', system: { weight: { value: 10 } }, folder: 'Loot' },
      mock,
    );
    expect(createDocuments).toHaveBeenCalledWith('Item', [
      { name: 'Rope', type: 'loot', system: { weight: { value: 10 } }, folder: 'FOLDERAAAAAAAAAA' },
    ]);
    await handleUpdateWorldItem({ item: 'cloak', name: 'Cloak', system: { rarity: 'rare' } }, mock);
    expect(updateDocuments).toHaveBeenCalledWith('Item', [
      { _id: ITEM, name: 'Cloak', system: { rarity: 'rare' } },
    ]);
    await expect(handleUpdateWorldItem({ item: 'cloak' }, mock)).rejects.toThrow(/at least one/);
    await handleDeleteWorldItem({ item: ITEM }, mock);
    expect(deleteDocuments).toHaveBeenCalledWith('Item', [ITEM]);
  });
});

describe('token update and delete', () => {
  it('maps friendly names to Foundry values and sets size as width and height', async () => {
    const { mock, updateDocuments } = client();
    await handleUpdateToken(
      { tokenId: TOKEN, hidden: true, disposition: 'hostile', size: 2, elevation: 10 },
      mock,
    );
    expect(updateDocuments).toHaveBeenCalledWith(
      'Token',
      [{ _id: TOKEN, hidden: true, elevation: 10, disposition: -1, width: 2, height: 2 }],
      `Scene.${SCENE}`,
    );
  });

  it('rejects an empty update and an unknown token', async () => {
    const { mock } = client();
    await expect(handleUpdateToken({ tokenId: TOKEN }, mock)).rejects.toThrow(/at least one/);
    await expect(handleUpdateToken({ tokenId: 'NOPE', hidden: true }, mock)).rejects.toThrow(
      /Token not found/,
    );
  });

  it('deletes a token from its scene', async () => {
    const { mock, deleteDocuments } = client();
    await handleDeleteToken({ tokenId: TOKEN }, mock);
    expect(deleteDocuments).toHaveBeenCalledWith('Token', [TOKEN], `Scene.${SCENE}`);
  });
});
