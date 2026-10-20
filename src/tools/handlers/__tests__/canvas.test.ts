import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { handleCanvasList } from '../canvas.js';
import { pageSlice } from '../canvas-common.js';
import { handleAddDrawing, handleRemoveDrawing, handleUpdateDrawing } from '../canvas-drawings.js';
import { handleAddRegion, handleRemoveRegion, handleUpdateRegion } from '../canvas-regions.js';
import { handleAddTile, handleRemoveTile, handleUpdateTile } from '../canvas-tiles.js';
import {
  buildWall,
  handleAddRoom,
  handleAddWalls,
  handleRemoveWalls,
  handleSetDoor,
  roomWalls,
  wallCategory,
} from '../canvas-walls.js';

const SCENE = 'SCENEAAAAAAAAAAA';
const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? '';

// 2000x1500 image, 100px grid, padding 0.25 => the map starts at canvas (500, 400).
function scene(over: Record<string, unknown> = {}) {
  return {
    _id: SCENE,
    name: 'Inn',
    active: false,
    width: 2000,
    height: 1500,
    padding: 0.25,
    grid: { size: 100 },
    walls: [
      {
        _id: 'WALLDOORAAAAAAAA',
        c: [500, 400, 600, 400],
        door: 1,
        ds: 0,
        move: 20,
        sight: 20,
        light: 20,
        sound: 20,
      },
      {
        _id: 'WALLPLAINAAAAAAA',
        c: [500, 400, 500, 500],
        door: 0,
        move: 20,
        sight: 20,
        light: 20,
        sound: 20,
      },
      {
        _id: 'WALLFARAAAAAAAAA',
        c: [2000, 1600, 2100, 1600],
        door: 0,
        move: 20,
        sight: 10,
        light: 10,
        sound: 10,
      },
    ],
    tiles: [
      {
        _id: 'TILEAAAAAAAAAAAA',
        x: 600,
        y: 500,
        width: 200,
        height: 100,
        texture: { src: 'a/b/tree.png' },
      },
    ],
    regions: [
      {
        _id: 'REGIONAAAAAAAAAA',
        name: 'Fountain',
        shapes: [{ type: 'circle', x: 700, y: 600 }],
        behaviors: [{}],
      },
    ],
    drawings: [{ _id: 'DRAWAAAAAAAAAAAA', x: 500, y: 400, shape: { type: 'r' }, text: 'Hatch' }],
    ...over,
  };
}

function client() {
  const calls = {
    createDocuments: vi.fn(async (_t: string, data: unknown[]) =>
      data.map((_, i) => ({ _id: `NEWAAAAAAAAAAAA${i}` })),
    ),
    updateDocuments: vi.fn(async () => []),
    deleteDocuments: vi.fn(async () => []),
  };
  return {
    mock: {
      getWorldSnapshot: () => ({ scenes: [scene()] }),
      getUserId: () => 'USERGMAAAAAAAAAA',
      ...calls,
    } as unknown as FoundryClient,
    ...calls,
  };
}

describe('walls', () => {
  it('converts grid squares to integer canvas pixels with the scene origin', async () => {
    const { mock, createDocuments } = client();
    await handleAddWalls(
      {
        scene: 'Inn',
        walls: [
          { x1: 0, y1: 0, x2: 3, y2: 0 },
          { x1: 3, y1: 0, x2: 3, y2: 2.5, kind: 'secret_door', state: 'locked' },
        ],
      },
      mock,
    );
    expect(createDocuments).toHaveBeenCalledWith(
      'Wall',
      [
        { c: [500, 400, 800, 400], move: 20, sight: 20, light: 20, sound: 20, door: 0 },
        { c: [800, 400, 800, 650], move: 20, sight: 20, light: 20, sound: 20, door: 2, ds: 2 },
      ],
      `Scene.${SCENE}`,
    );
  });

  it('rejects points off the map, zero-length walls and a state on a plain wall', () => {
    const g = {
      scene: scene(),
      size: 100,
      cols: 20,
      rows: 15,
      originX: 500,
      originY: 400,
    } as never;
    expect(() => buildWall(g, { x1: 0, y1: 0, x2: 21, y2: 0 })).toThrow(
      /outside the map: columns 0-20, rows 0-15/,
    );
    expect(() => buildWall(g, { x1: 1, y1: 1, x2: 1, y2: 1 })).toThrow(/two different points/);
    expect(() => buildWall(g, { x1: 0, y1: 0, x2: 1, y2: 0, state: 'open' })).toThrow(
      /only applies to door/,
    );
  });

  it('classifies presets the way Foundry does', () => {
    const cat = (kind: Parameters<typeof buildWall>[1]['kind']) =>
      wallCategory(
        buildWall(
          { scene: scene(), size: 100, cols: 20, rows: 15, originX: 0, originY: 0 } as never,
          { x1: 0, y1: 0, x2: 1, y2: 0, kind },
        ),
      );
    expect(
      ['wall', 'door', 'secret_door', 'window', 'invisible', 'terrain', 'ethereal'].map((k) =>
        cat(k as never),
      ),
    ).toEqual(['wall', 'door', 'secret door', 'window', 'invisible', 'terrain', 'ethereal']);
  });

  it('builds a room with a centred door as a single write', async () => {
    expect(roomWalls({ x: 0, y: 0, width: 4, height: 3 })).toHaveLength(4);
    const split = roomWalls({ x: 2, y: 1, width: 5, height: 3 }, { side: 'south', width: 1 });
    // south side (5 wide, door at 2..3) becomes three segments: 3 other sides + 3 = 6
    expect(split).toHaveLength(6);
    expect(split.filter((w) => w.kind === 'door')).toEqual([
      { x1: 4, y1: 4, x2: 5, y2: 4, kind: 'door' },
    ]);
    const { mock, createDocuments } = client();
    await handleAddRoom(
      {
        scene: 'Inn',
        x: 0,
        y: 0,
        width: 4,
        height: 3,
        door_side: 'north',
        door_at: 1,
        door_state: 'open',
      },
      mock,
    );
    expect(createDocuments).toHaveBeenCalledTimes(1);
    expect((createDocuments.mock.calls[0]?.[1] as unknown[] | undefined)?.length).toBe(6);
    expect(() =>
      roomWalls({ x: 0, y: 0, width: 4, height: 3 }, { side: 'north', at: 3.5, width: 1 }),
    ).toThrow(/does not fit/);
  });

  it('sets door state only on doors, and removes walls by id in one write', async () => {
    const { mock, updateDocuments, deleteDocuments } = client();
    await handleSetDoor({ scene: 'Inn', wall: 'WALLDOORAAAAAAAA', state: 'locked' }, mock);
    expect(updateDocuments).toHaveBeenCalledWith(
      'Wall',
      [{ _id: 'WALLDOORAAAAAAAA', ds: 2 }],
      `Scene.${SCENE}`,
    );
    await expect(
      handleSetDoor({ scene: 'Inn', wall: 'WALLPLAINAAAAAAA', state: 'open' }, mock),
    ).rejects.toThrow(/not a door/);
    await handleRemoveWalls(
      { scene: 'Inn', walls: ['WALLDOORAAAAAAAA', 'WALLPLAINAAAAAAA'] },
      mock,
    );
    expect(deleteDocuments).toHaveBeenCalledWith(
      'Wall',
      ['WALLDOORAAAAAAAA', 'WALLPLAINAAAAAAA'],
      `Scene.${SCENE}`,
    );
    await expect(handleRemoveWalls({ scene: 'Inn', walls: ['nope'] }, mock)).rejects.toThrow(
      /foundry_canvas list/,
    );
  });

  it('lists walls in squares, filtered by category or area', async () => {
    const { mock } = client();
    const all = text(await handleCanvasList({ scene: 'Inn', kind: 'walls' }, mock));
    expect(all).toContain('`WALLDOORAAAAAAAA` (0, 0) → (1, 0) · door · closed');
    expect(all).toContain('3 matches of 3');
    expect(
      text(await handleCanvasList({ scene: 'Inn', kind: 'walls', filter: 'doors' }, mock)),
    ).toContain('1 match of 3');
    expect(
      text(await handleCanvasList({ scene: 'Inn', kind: 'walls', filter: 'terrain' }, mock)),
    ).toContain('WALLFARAAAAAAAAA');
    const area = text(
      await handleCanvasList(
        { scene: 'Inn', kind: 'walls', x: 0, y: 0, width: 2, height: 2 },
        mock,
      ),
    );
    expect(area).toContain('2 matches');
    expect(area).not.toContain('WALLFAR');
  });
});

describe('regions', () => {
  it('builds v14 shape data in canvas pixels', async () => {
    const { mock, createDocuments } = client();
    await handleAddRegion(
      {
        scene: 'Inn',
        name: 'Trap',
        shapes: [
          { type: 'rectangle', x: 1, y: 1, width: 2, height: 1 },
          { type: 'circle', x: 5, y: 5, radius: 1.5, hole: true },
          { type: 'cone', x: 2, y: 2, radius: 3, angle: 90, rotation: 45 },
          { type: 'polygon', points: [0, 0, 2, 0, 1, 2] },
        ],
        color: '#ff0000',
        visibility: 'gamemaster',
        elevation_top: 10,
      },
      mock,
    );
    const [type, data, parent] = createDocuments.mock.calls[0] as unknown as [
      string,
      Array<Record<string, unknown>>,
      string,
    ];
    expect([type, parent]).toEqual(['Region', `Scene.${SCENE}`]);
    expect(data[0]).toMatchObject({
      name: 'Trap',
      color: '#ff0000',
      visibility: 1,
      elevation: { top: 10 },
    });
    expect(data[0]?.shapes).toEqual([
      {
        type: 'rectangle',
        hole: false,
        x: 600,
        y: 500,
        width: 200,
        height: 100,
        rotation: 0,
        anchorX: 0,
        anchorY: 0,
        gridBased: false,
      },
      { type: 'circle', hole: true, x: 1000, y: 900, radius: 150, gridBased: false },
      {
        type: 'cone',
        hole: false,
        x: 700,
        y: 600,
        radius: 300,
        angle: 90,
        rotation: 45,
        curvature: 'round',
        gridBased: false,
      },
      { type: 'polygon', hole: false, points: [500, 400, 700, 400, 600, 600] },
    ]);
  });

  it('says what a shape is missing, then updates and removes by name', async () => {
    const { mock, updateDocuments, deleteDocuments } = client();
    await expect(
      handleAddRegion({ scene: 'Inn', name: 'x', shapes: [{ type: 'circle', x: 1, y: 1 }] }, mock),
    ).rejects.toThrow(/circle region shape needs radius/);
    await expect(
      handleAddRegion(
        { scene: 'Inn', name: 'x', shapes: [{ type: 'polygon', points: [0, 0, 1, 1] }] },
        mock,
      ),
    ).rejects.toThrow(/at least 3 points/);
    await handleUpdateRegion(
      { scene: 'Inn', region: 'fountain', hidden: true, elevation_bottom: null, name: 'Well' },
      mock,
    );
    expect(updateDocuments).toHaveBeenCalledWith(
      'Region',
      [{ _id: 'REGIONAAAAAAAAAA', hidden: true, 'elevation.bottom': null, name: 'Well' }],
      `Scene.${SCENE}`,
    );
    expect(
      text(await handleRemoveRegion({ scene: 'Inn', region: 'REGIONAAAAAAAAAA' }, mock)),
    ).toContain('had 1 behavior');
    expect(deleteDocuments).toHaveBeenCalledWith('Region', ['REGIONAAAAAAAAAA'], `Scene.${SCENE}`);
    expect(text(await handleCanvasList({ scene: 'Inn', kind: 'regions' }, mock))).toContain(
      '**Fountain**',
    );
  });
});

describe('tiles and drawings', () => {
  it('adds and moves a tile in whole pixels', async () => {
    const { mock, createDocuments, updateDocuments } = client();
    await handleAddTile(
      {
        scene: 'Inn',
        image: 'a/tree.png',
        x: 1,
        y: 1,
        width: 2.5,
        height: 1,
        alpha: 0.5,
        hidden: true,
      },
      mock,
    );
    expect(createDocuments).toHaveBeenCalledWith(
      'Tile',
      [
        {
          texture: { src: 'a/tree.png' },
          x: 600,
          y: 500,
          width: 250,
          height: 100,
          alpha: 0.5,
          hidden: true,
        },
      ],
      `Scene.${SCENE}`,
    );
    await handleUpdateTile(
      { scene: 'Inn', tile: 'TILEAAAAAAAAAAAA', x: 2, y: 2, image: 'b.png' },
      mock,
    );
    expect(updateDocuments).toHaveBeenCalledWith(
      'Tile',
      [{ _id: 'TILEAAAAAAAAAAAA', 'texture.src': 'b.png', x: 700, y: 600 }],
      `Scene.${SCENE}`,
    );
    await expect(
      handleUpdateTile({ scene: 'Inn', tile: 'TILEAAAAAAAAAAAA', x: 2 }, mock),
    ).rejects.toThrow(/both x and y/);
    await expect(
      handleAddTile({ scene: 'Inn', image: 'a.png', x: 1, y: 1, width: 0, height: 1 }, mock),
    ).rejects.toThrow(/positive/);
    expect(text(await handleCanvasList({ scene: 'Inn', kind: 'tiles' }, mock))).toContain(
      'tree.png at (1, 1) 2×1 sq',
    );
    await handleRemoveTile({ scene: 'Inn', tile: 'TILEAAAAAAAAAAAA' }, mock);
  });

  it('draws shapes with single-letter v14 types and relative polygon points', async () => {
    const { mock, createDocuments, updateDocuments, deleteDocuments } = client();
    await handleAddDrawing(
      {
        scene: 'Inn',
        shape: 'ellipse',
        x: 1,
        y: 1,
        width: 2,
        height: 1,
        fill: 'solid',
        fill_color: '#00ff00',
      },
      mock,
    );
    expect(createDocuments).toHaveBeenLastCalledWith(
      'Drawing',
      [
        {
          shape: { type: 'e', width: 200, height: 100 },
          x: 600,
          y: 500,
          fillType: 1,
          fillColor: '#00ff00',
          author: 'USERGMAAAAAAAAAA',
        },
      ],
      `Scene.${SCENE}`,
    );
    await handleAddDrawing(
      { scene: 'Inn', shape: 'polygon', x: 1, y: 1, points: [1, 1, 3, 1, 2, 3] },
      mock,
    );
    expect(
      (createDocuments.mock.calls.at(-1)?.[1] as Array<Record<string, unknown>> | undefined)?.[0]
        ?.shape,
    ).toEqual({
      type: 'p',
      width: 200,
      height: 200,
      points: [0, 0, 200, 0, 100, 200],
    });
    await handleAddDrawing(
      {
        scene: 'Inn',
        shape: 'text',
        x: 0,
        y: 0,
        width: 4,
        height: 1,
        text: 'Cellar',
        font_size: 40,
      },
      mock,
    );
    expect(
      (createDocuments.mock.calls.at(-1)?.[1] as Array<Record<string, unknown>> | undefined)?.[0],
    ).toMatchObject({
      shape: { type: 'r', width: 400, height: 100 },
      fillType: 0,
      strokeWidth: 0,
      text: 'Cellar',
      fontSize: 40,
    });
    await expect(
      handleAddDrawing({ scene: 'Inn', shape: 'text', x: 0, y: 0, width: 1, height: 1 }, mock),
    ).rejects.toThrow(/needs text/);
    await handleUpdateDrawing(
      { scene: 'Inn', drawing: 'DRAWAAAAAAAAAAAA', hidden: true, stroke_color: '#fff' },
      mock,
    );
    expect(updateDocuments).toHaveBeenCalledWith(
      'Drawing',
      [{ _id: 'DRAWAAAAAAAAAAAA', strokeColor: '#fff', hidden: true }],
      `Scene.${SCENE}`,
    );
    await handleRemoveDrawing({ scene: 'Inn', drawing: 'DRAWAAAAAAAAAAAA' }, mock);
    expect(deleteDocuments).toHaveBeenCalledWith('Drawing', ['DRAWAAAAAAAAAAAA'], `Scene.${SCENE}`);
    expect(text(await handleCanvasList({ scene: 'Inn', kind: 'drawings' }, mock))).toContain(
      'rectangle at (0, 0) "Hatch"',
    );
  });
});

describe('paging', () => {
  it('slices a list into pages with a footer and next offset', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    expect(pageSlice(items, 10)).toEqual({ items, footer: '' });
    expect(pageSlice(items, 2)).toEqual({
      items: ['a', 'b'],
      footer: '\n_Showing 1–2 of 5; next offset=2._',
    });
    expect(pageSlice(items, 2, 2)).toEqual({
      items: ['c', 'd'],
      footer: '\n_Showing 3–4 of 5; next offset=4._',
    });
    expect(pageSlice(items, 2, 4)).toEqual({ items: ['e'], footer: '\n_Showing 5–5 of 5._' });
    expect(pageSlice(items, 2, 9)).toEqual({
      items: [],
      footer: '\n_No entries at offset 9; 5 total._',
    });
    expect(pageSlice(items, 2, -3).items).toEqual(['a', 'b']);
    expect(pageSlice(items, 2, 2.9).items).toEqual(['c', 'd']);
  });

  it('pages foundry_canvas list tiles with offset', async () => {
    const tiles = Array.from({ length: 45 }, (_, i) => ({
      _id: `TILE${String(i).padStart(12, '0')}`,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      texture: { src: `tree-${i}.png` },
    }));
    const mock = {
      getWorldSnapshot: () => ({ scenes: [scene({ tiles })] }),
    } as unknown as FoundryClient;

    const first = text(await handleCanvasList({ scene: 'Inn', kind: 'tiles', limit: 20 }, mock));
    expect(first).toContain('tree-0.png');
    expect(first).not.toContain('tree-20.png');
    expect(first).toContain('_Showing 1–20 of 45; next offset=20._');

    const last = text(
      await handleCanvasList({ scene: 'Inn', kind: 'tiles', limit: 20, offset: 40 }, mock),
    );
    expect(last).toContain('tree-44.png');
    expect(last).not.toContain('tree-39.png');
    expect(last).toContain('_Showing 41–45 of 45._');
    expect(last).not.toContain('next offset');
  });
});
