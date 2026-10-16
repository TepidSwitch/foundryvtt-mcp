import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { handleCanvasList } from '../canvas.js';
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
    expect((createDocuments.mock.calls[0]?.[1] as unknown[]).length).toBe(6);
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
