/**
 * @fileoverview Walls: add (single, batch, room), door state, remove
 *
 * v14 wall fields: `c` is [x1,y1,x2,y2] in INTEGER canvas pixels; light, sight,
 * sound and move take EDGE_SENSE_TYPES (NONE 0, LIMITED 10, NORMAL 20,
 * PROXIMITY 30, DISTANCE 40); `door` is NONE 0 / DOOR 1 / SECRET 2; `ds` is the
 * door state CLOSED 0 / OPEN 1 / LOCKED 2; `dir` BOTH 0 / LEFT 1 / RIGHT 2.
 * The presets match how Foundry itself classifies a wall (Wall#getWallCategory).
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import {
  assertOnMap,
  embeddedOf,
  findEmbedded,
  type Geometry,
  pageLimit,
  px,
  sceneFor,
  squares,
  text,
} from './canvas-common.js';
import { num, type Rec, str } from './dnd5e.js';
import { withToolError } from './utils.js';

export type WallKind =
  | 'wall'
  | 'door'
  | 'secret_door'
  | 'window'
  | 'invisible'
  | 'terrain'
  | 'ethereal';

const NONE = 0;
const LIMITED = 10;
const NORMAL = 20;
const DISTANCE = 40;

interface Preset {
  move: number;
  sight: number;
  light: number;
  sound: number;
  door: number;
}

export const WALL_PRESETS: Record<WallKind, Preset> = {
  wall: { move: NORMAL, sight: NORMAL, light: NORMAL, sound: NORMAL, door: 0 },
  door: { move: NORMAL, sight: NORMAL, light: NORMAL, sound: NORMAL, door: 1 },
  secret_door: { move: NORMAL, sight: NORMAL, light: NORMAL, sound: NORMAL, door: 2 },
  window: { move: NORMAL, sight: DISTANCE, light: DISTANCE, sound: NORMAL, door: 0 },
  invisible: { move: NORMAL, sight: NONE, light: NONE, sound: NONE, door: 0 },
  terrain: { move: NORMAL, sight: LIMITED, light: LIMITED, sound: LIMITED, door: 0 },
  ethereal: { move: NONE, sight: NORMAL, light: NORMAL, sound: NORMAL, door: 0 },
};

const DOOR_STATES = { closed: 0, open: 1, locked: 2 } as const;
export type DoorState = keyof typeof DOOR_STATES;
const DIRECTIONS = { both: 0, left: 1, right: 2 } as const;
export type WallDirection = keyof typeof DIRECTIONS;

export interface WallSpec {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind?: WallKind | undefined;
  state?: DoorState | undefined;
  direction?: WallDirection | undefined;
}

const MAX_WALLS = 200;

/** Describes a wall's category like Foundry does, for listings. */
export function wallCategory(w: Rec): string {
  const sight = num(w.sight, NORMAL);
  if (sight === NONE) {
    return num(w.light) + num(w.sound) + num(w.move) === NONE ? 'blank' : 'invisible';
  }
  if (sight === LIMITED) {
    return 'terrain';
  }
  if (sight === DISTANCE || sight === 30) {
    return 'window';
  }
  if (num(w.move, NORMAL) === NONE) {
    return 'ethereal';
  }
  if (num(w.door) === 1) {
    return 'door';
  }
  if (num(w.door) === 2) {
    return 'secret door';
  }
  return 'wall';
}

export function buildWall(g: Geometry, spec: WallSpec): Rec {
  const { x1, y1, x2, y2 } = spec;
  for (const [x, y] of [
    [x1, y1],
    [x2, y2],
  ] as const) {
    assertOnMap(g, x, y, 'Wall end');
  }
  if (x1 === x2 && y1 === y2) {
    throw new McpError(ErrorCode.InvalidParams, 'A wall needs two different points');
  }
  const a = px(g, x1, y1);
  const b = px(g, x2, y2);
  const preset = WALL_PRESETS[spec.kind ?? 'wall'];
  const data: Rec = {
    c: [Math.round(a.x), Math.round(a.y), Math.round(b.x), Math.round(b.y)],
    ...preset,
  };
  if (preset.door > 0) {
    data.ds = DOOR_STATES[spec.state ?? 'closed'];
  } else if (spec.state) {
    throw new McpError(ErrorCode.InvalidParams, 'state only applies to door and secret_door walls');
  }
  if (spec.direction) {
    data.dir = DIRECTIONS[spec.direction];
  }
  return data;
}

function kindLabel(specs: WallSpec[]): string {
  const counts = new Map<string, number>();
  for (const s of specs) {
    counts.set(s.kind ?? 'wall', (counts.get(s.kind ?? 'wall') ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ');
}

export async function handleAddWalls(
  args: { scene: string; walls: WallSpec[] },
  foundryClient: FoundryClient,
) {
  return withToolError('add walls', async () => {
    if (args.walls.length === 0 || args.walls.length > MAX_WALLS) {
      throw new McpError(ErrorCode.InvalidParams, `Give between 1 and ${MAX_WALLS} walls`);
    }
    const g = sceneFor(foundryClient, args.scene);
    const created = await foundryClient.createDocuments(
      'Wall',
      args.walls.map((w) => buildWall(g, w)),
      `Scene.${g.scene._id}`,
    );
    return text(
      `🧱 **Walls Added** to "${g.scene.name}": ${kindLabel(args.walls)}\n**IDs:** ${created.map((c) => `\`${str(c._id)}\``).join(' ')}\nThey are one write: foundry_history_edit undo removes all of them.`,
    );
  });
}

export type RoomSide = 'north' | 'south' | 'west' | 'east';

/** The four sides of a room as segments; one side can carry a door. */
export function roomWalls(
  rect: { x: number; y: number; width: number; height: number },
  door?: {
    side: RoomSide;
    at?: number | undefined;
    width?: number | undefined;
    kind?: WallKind | undefined;
    state?: DoorState | undefined;
  },
): WallSpec[] {
  const { x, y, width: w, height: h } = rect;
  if (!(w > 0 && h > 0)) {
    throw new McpError(ErrorCode.InvalidParams, 'A room needs a positive width and height');
  }
  type Side = { from: [number, number]; to: [number, number]; length: number };
  const sides: Record<RoomSide, Side> = {
    north: { from: [x, y], to: [x + w, y], length: w },
    east: { from: [x + w, y], to: [x + w, y + h], length: h },
    south: { from: [x, y + h], to: [x + w, y + h], length: w },
    west: { from: [x, y], to: [x, y + h], length: h },
  };
  const specs: WallSpec[] = [];
  const seg = (s: Side, t0: number, t1: number, extra: Partial<WallSpec> = {}): WallSpec => {
    const [fx, fy] = s.from;
    const [tx, ty] = s.to;
    const lerp = (t: number) =>
      [fx + ((tx - fx) * t) / s.length, fy + ((ty - fy) * t) / s.length] as const;
    const [ax, ay] = lerp(t0);
    const [bx, by] = lerp(t1);
    return { x1: ax, y1: ay, x2: bx, y2: by, ...extra };
  };
  for (const name of ['north', 'east', 'south', 'west'] as const) {
    const s = sides[name];
    if (door?.side !== name) {
      specs.push(seg(s, 0, s.length));
      continue;
    }
    const dw = door.width ?? 1;
    const start = door.at ?? Math.max(0, Math.floor((s.length - dw) / 2));
    if (!(dw > 0) || start < 0 || start + dw > s.length) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `The door does not fit on the ${name} side, which is ${s.length} squares long`,
      );
    }
    if (start > 0) {
      specs.push(seg(s, 0, start));
    }
    specs.push(
      seg(s, start, start + dw, {
        kind: door.kind ?? 'door',
        ...(door.state ? { state: door.state } : {}),
      }),
    );
    if (start + dw < s.length) {
      specs.push(seg(s, start + dw, s.length));
    }
  }
  return specs;
}

export async function handleAddRoom(
  args: {
    scene: string;
    x: number;
    y: number;
    width: number;
    height: number;
    door_side?: RoomSide;
    door_at?: number;
    door_width?: number;
    door_kind?: 'door' | 'secret_door';
    door_state?: DoorState;
  },
  foundryClient: FoundryClient,
) {
  const specs = roomWalls(
    args,
    args.door_side
      ? {
          side: args.door_side,
          at: args.door_at,
          width: args.door_width,
          kind: args.door_kind,
          state: args.door_state,
        }
      : undefined,
  );
  return handleAddWalls({ scene: args.scene, walls: specs }, foundryClient);
}

export async function handleSetDoor(
  args: { scene: string; wall: string; state: DoorState },
  foundryClient: FoundryClient,
) {
  return withToolError('set door state', async () => {
    const g = sceneFor(foundryClient, args.scene);
    const wall = findEmbedded(g, 'walls', args.wall);
    if (num(wall.door) === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Wall ${args.wall} is a ${wallCategory(wall)}, not a door. Doors are shown by foundry_canvas list kind=walls filter=doors.`,
      );
    }
    await foundryClient.updateDocuments(
      'Wall',
      [{ _id: str(wall._id), ds: DOOR_STATES[args.state] }],
      `Scene.${g.scene._id}`,
    );
    return text(`🚪 **Door ${args.state}** on "${g.scene.name}" (wall \`${str(wall._id)}\`)`);
  });
}

export async function handleRemoveWalls(
  args: { scene: string; walls: string[] },
  foundryClient: FoundryClient,
) {
  return withToolError('remove walls', async () => {
    if (args.walls.length === 0 || args.walls.length > MAX_WALLS) {
      throw new McpError(ErrorCode.InvalidParams, `Give between 1 and ${MAX_WALLS} wall ids`);
    }
    const g = sceneFor(foundryClient, args.scene);
    const ids = args.walls.map((ref) => str(findEmbedded(g, 'walls', ref)._id));
    await foundryClient.deleteDocuments('Wall', [...new Set(ids)], `Scene.${g.scene._id}`);
    return text(
      `🗑️ **Walls Removed** ${new Set(ids).size} from "${g.scene.name}". One write: foundry_history_edit undo restores them all.`,
    );
  });
}

/** One line per wall for foundry_canvas list. */
export function listWalls(
  g: Geometry,
  filter: {
    filter?: string | undefined;
    area?: { x: number; y: number; width: number; height: number } | undefined;
    limit?: number | undefined;
  },
): string {
  let walls = embeddedOf(g.scene, 'walls');
  const f = filter.filter;
  if (f === 'doors') {
    walls = walls.filter((w) => num(w.door) > 0);
  } else if (f && f !== 'all') {
    walls = walls.filter((w) => wallCategory(w) === f.replace('_', ' '));
  }
  const area = filter.area;
  const located = walls
    .map((w) => ({ w, c: Array.isArray(w.c) ? (w.c as number[]) : [] }))
    .filter(({ c }) => c.length === 4);
  const inArea = area
    ? located.filter(({ c }) => {
        const [x1, y1] = squares(g, num(c[0]), num(c[1]));
        const [x2, y2] = squares(g, num(c[2]), num(c[3]));
        const inside = (x: number, y: number) =>
          x >= area.x && x <= area.x + area.width && y >= area.y && y <= area.y + area.height;
        return inside(x1, y1) || inside(x2, y2);
      })
    : located;
  const limit = pageLimit(filter.limit);
  const lines = inArea.slice(0, limit).map(({ w, c }) => {
    const [x1, y1] = squares(g, num(c[0]), num(c[1]));
    const [x2, y2] = squares(g, num(c[2]), num(c[3]));
    const state = num(w.door) > 0 ? ` · ${['closed', 'open', 'locked'][num(w.ds)] ?? '?'}` : '';
    return `- \`${str(w._id)}\` (${x1}, ${y1}) → (${x2}, ${y2}) · ${wallCategory(w)}${state}`;
  });
  return `🧱 **Walls on "${g.scene.name}"** — ${inArea.length} match${inArea.length === 1 ? '' : 'es'} of ${embeddedOf(g.scene, 'walls').length}\n${lines.join('\n') || '_None._'}${inArea.length > limit ? `\n_Showing ${limit}; narrow with area or filter, or raise limit (max 200)._` : ''}`;
}
