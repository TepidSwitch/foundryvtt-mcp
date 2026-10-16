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
  handleAddDrawing,
  handleRemoveDrawing,
  handleUpdateDrawing,
} from '../handlers/canvas-drawings.js';
import {
  handleAddRegion,
  handleRemoveRegion,
  handleUpdateRegion,
} from '../handlers/canvas-regions.js';
import { handleAddTile, handleRemoveTile, handleUpdateTile } from '../handlers/canvas-tiles.js';
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

const shape = z.object({
  type: z
    .enum(['rectangle', 'circle', 'ellipse', 'cone', 'ring', 'polygon'])
    .describe('Shape type'),
  x: z
    .number()
    .optional()
    .describe('rectangle: left edge; circle, ellipse, cone, ring: centre/origin (squares)'),
  y: z
    .number()
    .optional()
    .describe('rectangle: top edge; circle, ellipse, cone, ring: centre/origin (squares)'),
  width: z.number().optional().describe('rectangle width (squares)'),
  height: z.number().optional().describe('rectangle height (squares)'),
  radius: z.number().optional().describe('circle, cone, ring radius (squares)'),
  radius_x: z.number().optional().describe('ellipse horizontal radius (squares)'),
  radius_y: z.number().optional().describe('ellipse vertical radius (squares)'),
  angle: z.number().optional().describe('cone opening angle in degrees'),
  rotation: z.number().optional().describe('rotation in degrees (rectangle, ellipse, cone)'),
  inner_width: z.number().optional().describe('ring inner band width (squares)'),
  outer_width: z.number().optional().describe('ring outer band width (squares)'),
  points: z
    .array(z.number())
    .optional()
    .describe('polygon corners [x1, y1, x2, y2, x3, y3, ...] in squares'),
  hole: z.boolean().optional().describe('Cut this shape out of the region'),
});

const regionFields = {
  color: z.string().optional().describe('Region colour, e.g. "#ff0000"'),
  hidden: z.boolean().optional().describe('Hide the region'),
  locked: z.boolean().optional().describe('Lock it against editing'),
  visibility: z
    .enum(['layer', 'layer_unlocked', 'gamemaster', 'observer', 'always'])
    .optional()
    .describe('Who sees it on the map (default layer_unlocked)'),
  display_measurements: z.boolean().optional().describe('Show measurements'),
  elevation_bottom: z
    .number()
    .nullable()
    .optional()
    .describe('Lowest elevation it covers; null for unbounded'),
  elevation_top: z
    .number()
    .nullable()
    .optional()
    .describe('Highest elevation it covers; null for unbounded'),
};

const tileFields = {
  rotation: z.number().optional().describe('Rotation in degrees'),
  alpha: z.number().min(0).max(1).optional().describe('Opacity 0-1'),
  hidden: z.boolean().optional().describe('Hide from players'),
  locked: z.boolean().optional().describe('Lock against editing'),
  elevation: z.number().optional().describe('Elevation'),
  sort: z.number().int().optional().describe('Stacking order; higher draws on top'),
};

const drawingStyle = {
  fill: z.enum(['none', 'solid']).optional().describe('Fill type'),
  fill_color: z.string().optional().describe('Fill colour, e.g. "#cc28a8"'),
  fill_alpha: z.number().min(0).max(1).optional().describe('Fill opacity 0-1'),
  stroke_width: z.number().int().min(0).optional().describe('Outline width in pixels'),
  stroke_color: z.string().optional().describe('Outline colour'),
  stroke_alpha: z.number().min(0).max(1).optional().describe('Outline opacity 0-1'),
  text: z.string().optional().describe('Text label'),
  font_size: z.number().int().min(8).max(256).optional().describe('Label size'),
  text_color: z.string().optional().describe('Label colour'),
  hidden: z.boolean().optional().describe('Hide from players'),
  locked: z.boolean().optional().describe('Lock against editing'),
  elevation: z.number().optional().describe('Elevation'),
};

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
        kind: z.enum(['walls', 'regions', 'tiles', 'drawings']).describe('What to list'),
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
    add_region: action({
      description:
        'Create a region (a scene area) from one or more shapes. Regions are the v14 replacement for measured templates. They are created without behaviors; add teleport/trigger behaviors in Foundry.',
      schema: z.object({
        scene,
        name: z.string().describe('Region name'),
        shapes: z.array(shape).min(1).describe('Shapes that make up the region'),
        ...regionFields,
      }),
      run: (a, ctx) => handleAddRegion(a, ctx.foundryClient),
    }),
    update_region: action({
      description:
        'Change a region (id or name): name, colour, hidden, locked, visibility, elevation range.',
      schema: z.object({
        scene,
        region: z.string().describe('Region id or exact name'),
        name: z.string().optional().describe('New name'),
        ...regionFields,
      }),
      run: (a, ctx) => handleUpdateRegion(a, ctx.foundryClient),
    }),
    remove_region: action({
      description:
        'Delete a region, including its behaviors. Confirm first; foundry_history_edit undo re-creates it.',
      schema: z.object({ scene, region: z.string().describe('Region id or exact name') }),
      run: (a, ctx) => handleRemoveRegion(a, ctx.foundryClient),
    }),
    add_tile: action({
      description:
        'Place an image on the scene as a tile. image is a path in the Foundry data folder (upload one with foundry_files_edit). x,y is the top-left corner.',
      schema: z.object({
        scene,
        image: z.string().describe('Image path, e.g. "worlds/my-world/mcp-uploads/tree.png"'),
        x: col('Left edge'),
        y: row('Top edge'),
        width: squaresLong('Width'),
        height: squaresLong('Height'),
        ...tileFields,
      }),
      run: (a, ctx) => handleAddTile(a, ctx.foundryClient),
    }),
    update_tile: action({
      description:
        'Change a tile: image, position (give both x and y), size, rotation, opacity, hidden, locked, elevation, order.',
      schema: z.object({
        scene,
        tile: z.string().describe('Tile id'),
        image: z.string().optional().describe('New image path'),
        x: col('New left edge').optional(),
        y: row('New top edge').optional(),
        width: squaresLong('New width').optional(),
        height: squaresLong('New height').optional(),
        ...tileFields,
      }),
      run: (a, ctx) => handleUpdateTile(a, ctx.foundryClient),
    }),
    remove_tile: action({
      description: 'Remove a tile. foundry_history_edit undo puts it back.',
      schema: z.object({ scene, tile: z.string().describe('Tile id') }),
      run: (a, ctx) => handleRemoveTile(a, ctx.foundryClient),
    }),
    add_drawing: action({
      description:
        'Draw a rectangle, ellipse, polygon or text label. For text give shape "text", x, y, width, height (the box) and text. For a polygon give points; x,y is where it is anchored.',
      schema: z.object({
        scene,
        shape: z.enum(['rectangle', 'ellipse', 'polygon', 'text']).describe('What to draw'),
        x: col('Left edge or anchor'),
        y: row('Top edge or anchor'),
        width: z
          .number()
          .positive()
          .optional()
          .describe('Width in squares (rectangle, ellipse, text)'),
        height: z
          .number()
          .positive()
          .optional()
          .describe('Height in squares (rectangle, ellipse, text)'),
        points: z
          .array(z.number())
          .optional()
          .describe('Polygon corners [x1, y1, x2, y2, ...] in squares'),
        ...drawingStyle,
      }),
      run: (a, ctx) => handleAddDrawing(a, ctx.foundryClient),
    }),
    update_drawing: action({
      description:
        'Change a drawing: position (give both x and y), colours, text, hidden, locked, elevation.',
      schema: z.object({
        scene,
        drawing: z.string().describe('Drawing id'),
        x: col('New left edge').optional(),
        y: row('New top edge').optional(),
        ...drawingStyle,
      }),
      run: (a, ctx) => handleUpdateDrawing(a, ctx.foundryClient),
    }),
    remove_drawing: action({
      description: 'Remove a drawing. foundry_history_edit undo puts it back.',
      schema: z.object({ scene, drawing: z.string().describe('Drawing id') }),
      run: (a, ctx) => handleRemoveDrawing(a, ctx.foundryClient),
    }),
  },
});
