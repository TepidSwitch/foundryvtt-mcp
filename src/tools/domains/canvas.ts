/**
 * @fileoverview Canvas tools: foundry_canvas (read), foundry_canvas_edit (write)
 *
 * Off by default (toolset "canvas"): these are low-level scene edits. Positions
 * are grid squares from the top-left of the map image.
 */

import { z } from 'zod';
import { action, DomainTool } from '../domain.js';
import { handleCanvasList } from '../handlers/canvas.js';
import {
  handleAddRoom,
  handleAddWalls,
  handleRemoveWalls,
  handleSetDoor,
} from '../handlers/canvas-walls.js';

const scene = z.string().describe('Scene id or name (partial ok)');
const col = (what: string) =>
  z.number().describe(`${what}, in grid squares from the left of the map image (fractions ok)`);
const row = (what: string) =>
  z.number().describe(`${what}, in grid squares from the top of the map image (fractions ok)`);
const squaresLong = (what: string) => z.number().positive().describe(`${what}, in grid squares`);

const wallKind = z
  .enum(['wall', 'door', 'secret_door', 'window', 'invisible', 'terrain', 'ethereal'])
  .optional()
  .describe(
    'wall (default, blocks everything), door, secret_door, window (blocks movement, lets sight through), invisible (blocks movement only), terrain (limits sight), ethereal (blocks sight, not movement)',
  );
const doorState = z
  .enum(['closed', 'open', 'locked'])
  .optional()
  .describe('Door state (default closed)');

export const canvasTool = new DomainTool({
  name: 'foundry_canvas',
  title: 'Foundry canvas',
  toolset: 'canvas',
  write: false,
  description:
    "List a scene's walls, regions, tiles and drawings with ids and positions (grid squares from the top-left of the map image).",
  actions: {
    list: action({
      description:
        'List one kind of canvas object on a scene. For walls, filter by door/wall/window/terrain/invisible/ethereal/"secret door" or give x, y, width, height (squares) to see only walls with an end inside that area. Scenes can hold hundreds of walls, so narrow before raising limit.',
      schema: z.object({
        scene,
        kind: z.enum(['walls']).describe('What to list'),
        filter: z
          .enum([
            'all',
            'doors',
            'wall',
            'window',
            'terrain',
            'invisible',
            'ethereal',
            'secret_door',
          ])
          .optional()
          .describe('Walls only: restrict to one category'),
        x: z.number().optional().describe('Walls only: area left edge (squares)'),
        y: z.number().optional().describe('Walls only: area top edge (squares)'),
        width: z.number().optional().describe('Walls only: area width (squares)'),
        height: z.number().optional().describe('Walls only: area height (squares)'),
        limit: z.number().optional().describe('Maximum entries (default 40, max 200)'),
      }),
      run: (a, ctx) => handleCanvasList(a, ctx.foundryClient),
    }),
  },
});

export const canvasEditTool = new DomainTool({
  name: 'foundry_canvas_edit',
  title: 'Edit the canvas',
  toolset: 'canvas',
  write: true,
  destructive: true,
  description:
    'WRITE: add, change and remove walls, doors, regions, tiles and drawings on a scene in the live world. Positions are grid squares from the top-left of the map image. Batch actions (add_walls, add_room) are one write, so a single foundry_history_edit undo reverses all of it. Needs FOUNDRY_WRITE_ENABLED=true and a GM login. Look up ids with foundry_canvas list.',
  actions: {
    add_walls: action({
      description:
        'Add several wall segments at once (up to 200). Endpoints sit on grid lines: (0,0) is the top-left corner of the map, (3,2) is 3 squares right and 2 down.',
      schema: z.object({
        scene,
        walls: z
          .array(
            z.object({
              x1: col('Start'),
              y1: row('Start'),
              x2: col('End'),
              y2: row('End'),
              kind: wallKind,
              state: doorState,
              direction: z
                .enum(['both', 'left', 'right'])
                .optional()
                .describe('One-way wall: which side blocks (default both)'),
            }),
          )
          .min(1)
          .describe('Wall segments'),
      }),
      run: (a, ctx) => handleAddWalls(a, ctx.foundryClient),
    }),
    add_room: action({
      description:
        'Enclose a rectangle with four walls, optionally with a door on one side (the wall on that side is split around it). x,y is the top-left corner.',
      schema: z.object({
        scene,
        x: col('Left edge'),
        y: row('Top edge'),
        width: squaresLong('Width'),
        height: squaresLong('Height'),
        door_side: z
          .enum(['north', 'south', 'west', 'east'])
          .optional()
          .describe('Side that gets a door'),
        door_at: z
          .number()
          .min(0)
          .optional()
          .describe(
            'Door start, squares along that side from its start (north/south: from the left, west/east: from the top). Default centred',
          ),
        door_width: z.number().positive().optional().describe('Door width in squares (default 1)'),
        door_kind: z
          .enum(['door', 'secret_door'])
          .optional()
          .describe('door (default) or secret_door'),
        door_state: doorState,
      }),
      run: (a, ctx) => handleAddRoom(a, ctx.foundryClient),
    }),
    set_door: action({
      description: 'Open, close or lock an existing door (wall id from foundry_canvas list).',
      schema: z.object({
        scene,
        wall: z.string().describe('Wall id of a door'),
        state: z.enum(['closed', 'open', 'locked']).describe('New door state'),
      }),
      run: (a, ctx) => handleSetDoor(a, ctx.foundryClient),
    }),
    remove_walls: action({
      description:
        'Remove walls by id (up to 200). Confirm with the user first; one foundry_history_edit undo restores them all.',
      schema: z.object({ scene, walls: z.array(z.string()).min(1).describe('Wall ids') }),
      run: (a, ctx) => handleRemoveWalls(a, ctx.foundryClient),
    }),
  },
});
