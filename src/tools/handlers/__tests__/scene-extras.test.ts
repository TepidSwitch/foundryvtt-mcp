import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { regionBounds } from '../canvas-regions.js';
import { ensureFolder } from '../folders.js';
import { handlePlaceGroup, layoutGroup } from '../import-place.js';
import { handleFitGrid } from '../scene-mutations.js';

const SCENE = 'SCENEAAAAAAAAAAA';
const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? '';

function client(folders: unknown[] = []) {
  const updateDocuments = vi.fn(async () => []);
  const createDocuments = vi.fn(async () => [{ _id: 'NEWFOLDERAAAAAAA' }]);
  const batchRuns = vi.fn();
  const createSceneTokens = vi.fn(async (_s: string, _a: string, t: unknown[]) =>
    t.map((_, i) => ({ id: `T${i}`, name: 'x', x: 0, y: 0 })),
  );
  const mock = {
    getWorldSnapshot: () => ({
      folders,
      actors: [
        { _id: 'GOBLINAAAAAAAAAA', name: 'Goblin', prototypeToken: { width: 1 } },
        { _id: 'OGREAAAAAAAAAAAA', name: 'Ogre', prototypeToken: { width: 2 } },
      ],
      users: [],
      scenes: [
        {
          _id: SCENE,
          name: 'Hall',
          active: false,
          width: 2000,
          height: 1000,
          padding: 0,
          grid: { size: 100 },
          regions: [
            {
              _id: 'REGIONAAAAAAAAAA',
              name: 'Pit',
              shapes: [{ type: 'rectangle', x: 300, y: 200, width: 600, height: 400 }],
            },
          ],
        },
      ],
    }),
    updateDocuments,
    createDocuments,
    createSceneTokens,
    withBatch: async (fn: () => Promise<unknown>) => {
      batchRuns();
      return fn();
    },
  } as unknown as FoundryClient;
  return { mock, updateDocuments, createDocuments, createSceneTokens, batchRuns };
}

describe('fit_grid', () => {
  it('sets grid size from cells_x and reports counts', async () => {
    const c = client();
    const out = text(await handleFitGrid({ scene: 'Hall', cells_x: 20 }, c.mock));
    expect(c.updateDocuments).toHaveBeenCalledWith('Scene', [{ _id: SCENE, 'grid.size': 100 }]);
    expect(out).toContain('20×10 squares');
  });
  it('accepts grid_size and cells_y, and enforces the 50 px minimum', async () => {
    const c = client();
    await handleFitGrid({ scene: 'Hall', grid_size: 80 }, c.mock);
    expect(text(await handleFitGrid({ scene: 'Hall', cells_y: 8 }, c.mock))).toContain('125 px');
    await expect(handleFitGrid({ scene: 'Hall', cells_x: 50 }, c.mock)).rejects.toThrow(/minimum/);
    await expect(handleFitGrid({ scene: 'Hall', grid_size: 20 }, c.mock)).rejects.toThrow(
      /minimum/,
    );
    await expect(handleFitGrid({ scene: 'Hall' }, c.mock)).rejects.toThrow(/exactly one/);
  });
});

describe('ensureFolder', () => {
  it('reuses an existing folder, case-insensitively', async () => {
    const c = client([{ _id: 'EXISTINGAAAAAAAA', name: 'generated maps', type: 'Scene' }]);
    expect(await ensureFolder(c.mock, 'Generated Maps', 'Scene')).toBe('EXISTINGAAAAAAAA');
    expect(c.createDocuments).not.toHaveBeenCalled();
  });
  it('creates it when missing or of another type', async () => {
    const c = client([{ _id: 'ACTORFOLDERAAAAA', name: 'Generated Maps', type: 'Actor' }]);
    expect(await ensureFolder(c.mock, 'Generated Maps', 'Scene')).toBe('NEWFOLDERAAAAAAA');
    expect(c.createDocuments).toHaveBeenCalledWith('Folder', [
      { name: 'Generated Maps', type: 'Scene' },
    ]);
  });
});

describe('layoutGroup', () => {
  const area = { col: 2, row: 1, cols: 6, rows: 4 };
  it('packs left to right with spacing and wraps by row height', () => {
    const slots = layoutGroup(
      [
        { label: 'Ogre', span: 2, count: 1 },
        { label: 'Goblin', span: 1, count: 3 },
      ],
      area,
    );
    expect(slots.map((s) => [s.col, s.row])).toEqual([
      [2, 1],
      [5, 1],
      [7, 1],
      [2, 4],
    ]);
  });
  it('errors with a clear message when it does not fit', () => {
    expect(() => layoutGroup([{ label: 'Goblin', span: 1, count: 20 }], area)).toThrow(
      /Not enough room/,
    );
    expect(() =>
      layoutGroup([{ label: 'Dragon', span: 5, count: 1 }], { ...area, rows: 3 }),
    ).toThrow(/does not fit/);
  });
  it('spacing 0 packs tightly', () => {
    const slots = layoutGroup([{ label: 'G', span: 1, count: 6 }], area, 0);
    expect(slots.at(-1)).toMatchObject({ col: 7, row: 1 });
  });
});

describe('regionBounds', () => {
  it('computes squares for rectangle and circle shapes', () => {
    const c = client();
    const scene = c.mock.getWorldSnapshot()?.scenes[0] as never;
    const g = { scene, size: 100, cols: 20, rows: 10, originX: 0, originY: 0 };
    expect(
      regionBounds(g, { shapes: [{ type: 'rectangle', x: 300, y: 200, width: 600, height: 400 }] }),
    ).toEqual({ x: 3, y: 2, width: 6, height: 4 });
    expect(regionBounds(g, { shapes: [{ type: 'circle', x: 500, y: 500, radius: 200 }] })).toEqual({
      x: 3,
      y: 3,
      width: 4,
      height: 4,
    });
    expect(() => regionBounds(g, { name: 'e', shapes: [] })).toThrow(/no shapes/);
  });
});

describe('handlePlaceGroup', () => {
  it('places all actors in one batch inside an area', async () => {
    const c = client();
    const out = text(
      await handlePlaceGroup(
        {
          scene: 'Hall',
          actors: [{ ref: 'Ogre' }, { ref: 'Goblin', count: 2 }],
          area: { x: 1, y: 1, width: 8, height: 4 },
          spacing: 1,
        },
        c.mock,
      ),
    );
    expect(c.batchRuns).toHaveBeenCalledTimes(1);
    expect(c.createSceneTokens).toHaveBeenCalledTimes(2);
    expect(c.createSceneTokens.mock.calls[0]?.[2]).toEqual([{ x: 100, y: 100 }]);
    expect(c.createSceneTokens.mock.calls[1]?.[2]).toEqual([
      { x: 400, y: 100, name: 'Goblin 1' },
      { x: 600, y: 100, name: 'Goblin 2' },
    ]);
    expect(out).toContain('Placed 3 tokens');
  });
  it('uses the region bounding box and fails cleanly without writing', async () => {
    const c = client();
    await handlePlaceGroup(
      { scene: 'Hall', actors: [{ ref: 'Goblin' }], region_id: 'Pit' },
      c.mock,
    );
    expect(c.createSceneTokens.mock.calls[0]?.[2]).toEqual([{ x: 300, y: 200 }]);
    const d = client();
    await expect(
      handlePlaceGroup(
        { scene: 'Hall', actors: [{ ref: 'Goblin', count: 20 }], region_id: 'Pit' },
        d.mock,
      ),
    ).rejects.toThrow(/Not enough room/);
    expect(d.createSceneTokens).not.toHaveBeenCalled();
    await expect(
      handlePlaceGroup({ scene: 'Hall', actors: [{ ref: 'Goblin' }] }, d.mock),
    ).rejects.toThrow(/exactly one of area or region_id/);
  });
});
