import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import {
  handleActivateScene,
  handleAddLight,
  handleAddNote,
  handleRemoveLight,
  handleRemoveNote,
  handleUpdateScene,
} from '../scene-mutations.js';

const SCENE = 'SCENEAAAAAAAAAAA';
const JOURNAL = 'JOURNALAAAAAAAAA';
const PAGE = 'PAGEAAAAAAAAAAAA';

function client(active = false) {
  const calls = {
    createDocuments: vi.fn(async () => [{ _id: 'NEWAAAAAAAAAAAAA' }]),
    updateDocuments: vi.fn(async () => []),
    deleteDocuments: vi.fn(async () => []),
  };
  const scene = {
    _id: SCENE,
    name: 'Inn',
    active,
    width: 2000,
    height: 1500,
    padding: 0,
    grid: { size: 100, distance: 5, units: 'ft' },
    notes: [{ _id: 'NOTEAAAAAAAAAAAA', text: 'Cellar door' }],
    lights: [{ _id: 'LIGHTAAAAAAAAAAA', name: 'Torch' }],
  };
  return {
    mock: {
      getWorldSnapshot: () => ({
        scenes: [scene],
        journal: [{ _id: JOURNAL, name: 'Inn Notes', pages: [{ _id: PAGE, name: 'Cellar' }] }],
      }),
      ...calls,
    } as unknown as FoundryClient,
    ...calls,
  };
}

describe('scene mutation handlers', () => {
  it('activates a scene, and skips the write when it is already active', async () => {
    const { mock, updateDocuments } = client();
    await handleActivateScene({ scene: 'inn' }, mock);
    expect(updateDocuments).toHaveBeenCalledWith('Scene', [{ _id: SCENE, active: true }]);
    const again = client(true);
    const out = (await handleActivateScene({ scene: 'Inn' }, again.mock)).content[0] as {
      text: string;
    };
    expect(out.text).toContain('already the active scene');
    expect(again.updateDocuments).not.toHaveBeenCalled();
  });

  it('maps settings to v14 dot paths', async () => {
    const { mock, updateDocuments } = client();
    await handleUpdateScene(
      {
        scene: 'Inn',
        darkness: 0.8,
        global_light: true,
        grid_size: 140,
        navigation: true,
        name: 'Inn 2',
      },
      mock,
    );
    expect(updateDocuments).toHaveBeenCalledWith('Scene', [
      {
        _id: SCENE,
        name: 'Inn 2',
        navigation: true,
        'environment.darknessLevel': 0.8,
        'environment.globalLight.enabled': true,
        'grid.size': 140,
      },
    ]);
    await expect(handleUpdateScene({ scene: 'Inn' }, mock)).rejects.toThrow(/at least one setting/);
  });

  it('adds a note at the centre of a grid square, linked to a journal page', async () => {
    const { mock, createDocuments } = client();
    await handleAddNote(
      { scene: 'Inn', x: 3, y: 2, journal: 'inn notes', page: 'cellar', text: 'Cellar' },
      mock,
    );
    expect(createDocuments).toHaveBeenCalledWith(
      'Note',
      [{ x: 350, y: 250, entryId: JOURNAL, pageId: PAGE, text: 'Cellar' }],
      `Scene.${SCENE}`,
    );
    await expect(handleAddNote({ scene: 'Inn', x: 99, y: 1 }, mock)).rejects.toThrow(
      /outside the map/,
    );
    await expect(handleAddNote({ scene: 'Inn', x: 1, y: 1, page: 'x' }, mock)).rejects.toThrow(
      /needs journal/,
    );
  });

  it('adds a light with config and default radii, and removes notes and lights', async () => {
    const { mock, createDocuments, deleteDocuments } = client();
    await handleAddLight({ scene: 'Inn', x: 0, y: 0, color: '#ff8800', name: 'Brazier' }, mock);
    expect(createDocuments).toHaveBeenCalledWith(
      'AmbientLight',
      [{ x: 50, y: 50, name: 'Brazier', config: { color: '#ff8800', dim: 20, bright: 10 } }],
      `Scene.${SCENE}`,
    );
    await handleRemoveNote({ scene: 'Inn', note: 'cellar door' }, mock);
    expect(deleteDocuments).toHaveBeenCalledWith('Note', ['NOTEAAAAAAAAAAAA'], `Scene.${SCENE}`);
    await handleRemoveLight({ scene: 'Inn', light: 'LIGHTAAAAAAAAAAA' }, mock);
    expect(deleteDocuments).toHaveBeenLastCalledWith(
      'AmbientLight',
      ['LIGHTAAAAAAAAAAA'],
      `Scene.${SCENE}`,
    );
    await expect(handleRemoveLight({ scene: 'Inn', light: 'nope' }, mock)).rejects.toThrow(
      /No light on "Inn"/,
    );
  });
});
