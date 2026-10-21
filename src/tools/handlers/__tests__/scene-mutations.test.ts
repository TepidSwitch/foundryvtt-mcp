import { describe, expect, it } from 'vitest';
import { fakeFoundry } from '../../../test-utils/fake-foundry.js';
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

type Row = Record<string, unknown>;

function setup(active = false) {
  const f = fakeFoundry({
    world: {
      scenes: [
        {
          _id: SCENE,
          name: 'Inn',
          active,
          width: 2000,
          height: 1500,
          padding: 0,
          grid: { size: 100, distance: 5, units: 'ft' },
          notes: [{ _id: 'NOTEAAAAAAAAAAAA', text: 'Cellar door' }],
          lights: [{ _id: 'LIGHTAAAAAAAAAAA', name: 'Torch' }],
        },
      ],
      journal: [{ _id: JOURNAL, name: 'Inn Notes', pages: [{ _id: PAGE, name: 'Cellar' }] }],
    },
  });
  const scene = () => f.world.scenes?.[0] as Row;
  const writes = () => f.sent.filter((s) => s.action !== 'get');
  return { ...f, mock: f.client, scene, writes };
}

describe('scene mutation handlers', () => {
  it('activates a scene, and skips the write when it is already active', async () => {
    const { mock, scene } = setup();
    await handleActivateScene({ scene: 'inn' }, mock);
    expect(scene().active).toBe(true);
    const again = setup(true);
    const out = (await handleActivateScene({ scene: 'Inn' }, again.mock)).content[0] as {
      text: string;
    };
    expect(out.text).toContain('already the active scene');
    expect(again.writes()).toEqual([]);
  });

  it('maps settings onto the v14 nested fields', async () => {
    const { mock, scene } = setup();
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
    expect(scene()).toMatchObject({
      name: 'Inn 2',
      navigation: true,
      environment: { darknessLevel: 0.8, globalLight: { enabled: true } },
      grid: { size: 140, distance: 5, units: 'ft' }, // siblings of the changed key survive
    });
    await expect(handleUpdateScene({ scene: 'Inn' }, mock)).rejects.toThrow(/at least one setting/);
  });

  it('adds a note at the centre of a grid square, linked to a journal page', async () => {
    const { mock, scene, writes } = setup();
    await handleAddNote(
      { scene: 'Inn', x: 3, y: 2, journal: 'inn notes', page: 'cellar', text: 'Cellar' },
      mock,
    );
    expect((scene().notes as Row[])[1]).toMatchObject({
      x: 350,
      y: 250,
      entryId: JOURNAL,
      pageId: PAGE,
      text: 'Cellar',
    });
    const before = writes().length;
    await expect(handleAddNote({ scene: 'Inn', x: 99, y: 1 }, mock)).rejects.toThrow(
      /outside the map/,
    );
    await expect(handleAddNote({ scene: 'Inn', x: 1, y: 1, page: 'x' }, mock)).rejects.toThrow(
      /needs journal/,
    );
    expect(writes().length).toBe(before);
  });

  it('adds a light with config and default radii, and removes notes and lights', async () => {
    const { mock, scene } = setup();
    await handleAddLight({ scene: 'Inn', x: 0, y: 0, color: '#ff8800', name: 'Brazier' }, mock);
    expect((scene().lights as Row[])[1]).toMatchObject({
      x: 50,
      y: 50,
      name: 'Brazier',
      config: { color: '#ff8800', dim: 20, bright: 10 },
    });
    await handleRemoveNote({ scene: 'Inn', note: 'cellar door' }, mock);
    expect(scene().notes).toEqual([]);
    await handleRemoveLight({ scene: 'Inn', light: 'LIGHTAAAAAAAAAAA' }, mock);
    expect((scene().lights as Row[]).map((l) => l.name)).toEqual(['Brazier']);
    await expect(handleRemoveLight({ scene: 'Inn', light: 'nope' }, mock)).rejects.toThrow(
      /No light on "Inn"/,
    );
  });
});
