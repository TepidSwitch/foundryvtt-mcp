import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { handleCreateFolder, handleMoveToFolder } from '../folders.js';

function client(deep = false) {
  const calls = {
    createDocuments: vi.fn(async () => [{ _id: 'NEWFOLDERAAAAAAA' }]),
    updateDocuments: vi.fn(async () => []),
  };
  const folders = deep
    ? [
        { _id: 'F1AAAAAAAAAAAAAA', name: 'L1', type: 'Actor', folder: null },
        { _id: 'F2AAAAAAAAAAAAAA', name: 'L2', type: 'Actor', folder: 'F1AAAAAAAAAAAAAA' },
        { _id: 'F3AAAAAAAAAAAAAA', name: 'L3', type: 'Actor', folder: 'F2AAAAAAAAAAAAAA' },
        { _id: 'F4AAAAAAAAAAAAAA', name: 'L4', type: 'Actor', folder: 'F3AAAAAAAAAAAAAA' },
      ]
    : [
        { _id: 'NPCFOLDERAAAAAAA', name: 'NPCs', type: 'Actor', folder: null },
        { _id: 'SCENEFOLDERAAAAA', name: 'NPCs', type: 'Scene', folder: null },
      ];
  const mock = {
    getWorldSnapshot: () => ({
      folders,
      actors: [{ _id: 'ACTORAAAAAAAAAAA', name: 'Bartender' }],
      journal: [],
      items: [],
      scenes: [],
      playlists: [],
      tables: [],
      macros: [],
    }),
    ...calls,
  } as unknown as FoundryClient;
  return { mock, ...calls };
}

describe('folder handlers', () => {
  it('creates a folder, resolving the parent among folders of the same type', async () => {
    const { mock, createDocuments } = client();
    await handleCreateFolder(
      { name: 'Inn', type: 'Actor', parent: 'NPCs', color: '#112233' },
      mock,
    );
    expect(createDocuments).toHaveBeenCalledWith('Folder', [
      { name: 'Inn', type: 'Actor', folder: 'NPCFOLDERAAAAAAA', color: '#112233' },
    ]);
  });

  it('refuses to nest past the depth limit and unknown types', async () => {
    const { mock, createDocuments } = client(true);
    await expect(
      handleCreateFolder({ name: 'x', type: 'Actor', parent: 'L4' }, mock),
    ).rejects.toThrow(/4 levels/);
    await expect(handleCreateFolder({ name: 'x', type: 'Cards' }, mock)).rejects.toThrow(
      /type must be/,
    );
    expect(createDocuments).not.toHaveBeenCalled();
  });

  it('moves a document into a folder and back to the top level', async () => {
    const { mock, updateDocuments } = client();
    await handleMoveToFolder({ type: 'Actor', document: 'bartender', folder: 'NPCs' }, mock);
    expect(updateDocuments).toHaveBeenCalledWith('Actor', [
      { _id: 'ACTORAAAAAAAAAAA', folder: 'NPCFOLDERAAAAAAA' },
    ]);
    await handleMoveToFolder({ type: 'Actor', document: 'bartender' }, mock);
    expect(updateDocuments).toHaveBeenLastCalledWith('Actor', [
      { _id: 'ACTORAAAAAAAAAAA', folder: null },
    ]);
  });
});
