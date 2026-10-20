/**
 * @fileoverview Scene and token tools: foundry_scenes (read), foundry_tokens_edit (write)
 */

import { z } from 'zod';
import { action, DomainTool } from '../domain.js';
import { handlePlaceActorOnScene, handlePlaceGroup } from '../handlers/import-place.js';
import {
  handleActivateScene,
  handleAddLight,
  handleAddNote,
  handleFitGrid,
  handleRemoveLight,
  handleRemoveNote,
  handleUpdateScene,
} from '../handlers/scene-mutations.js';
import {
  handleGetSceneImage,
  handleGetSceneInfo,
  handleSearchScenes,
  handleSuggestScenes,
} from '../handlers/scenes.js';
import {
  handleDeleteToken,
  handleMoveToken,
  handleUpdateToken,
} from '../handlers/token-mutations.js';

export const scenesTool = new DomainTool({
  name: 'foundry_scenes',
  title: 'Foundry scenes',
  toolset: 'scenes',
  write: false,
  description:
    'Read scenes (maps): list and filter them, inspect one, rank them by session readiness, or look at the map image.',
  actions: {
    search: action({
      description:
        'List and filter every scene with folder path, size in grid squares, wall/light/token/note counts and inferred tags (dungeon, social, wilderness, urban, nautical, set-piece). query words must all match name/folder/tags.',
      schema: z.object({
        query: z.string().optional().describe('Words that must match name, folder or tags'),
        folder: z.string().optional().describe('Folder path substring'),
        active_only: z.boolean().optional().describe('Only the active scene'),
        min_tokens: z.number().optional().describe('Minimum number of placed tokens'),
        has_walls: z.boolean().optional().describe('Only scenes with walls'),
        has_lights: z.boolean().optional().describe('Only scenes with lights'),
        has_notes: z.boolean().optional().describe('Only scenes with map notes'),
        limit: z.number().optional().describe('Maximum results (default 25)'),
      }),
      run: (a, ctx) => handleSearchScenes(a, ctx.foundryClient),
    }),
    get: action({
      description:
        'Full detail for one scene: folder, size, grid, lighting, counts of walls/lights/tokens/notes/tiles/regions/sounds, linked journal and playlist, every token (name, disposition, position), map-note labels, tags and a readiness score. By id or name; with neither, the active scene. Use it to get a sceneId.',
      schema: z.object({
        sceneId: z.string().optional().describe('Scene id'),
        name: z.string().optional().describe('Scene name (partial ok)'),
      }),
      run: (a, ctx) => handleGetSceneInfo(a, ctx.foundryClient),
    }),
    suggest: action({
      description:
        'Rank scenes by how ready they are to run (walls, lighting, tokens, notes, journal, audio, tiles/regions, size), 0-100 with reasons. Bias with theme keywords and purpose. include_compendium=true also lists matching not-yet-imported maps. A metadata heuristic - look at the top picks with the image action.',
      schema: z.object({
        theme: z.string().optional().describe('Theme keywords, e.g. "temple, tomb"'),
        purpose: z
          .enum(['combat', 'exploration', 'social', 'any'])
          .optional()
          .describe('Intended use (default any)'),
        min_readiness: z.number().optional().describe('Only scenes scoring at least this (0-100)'),
        limit: z.number().optional().describe('Maximum results (default 10)'),
        include_compendium: z
          .boolean()
          .optional()
          .describe('Also list matching compendium maps (default false)'),
      }),
      run: (a, ctx) => handleSuggestScenes(a, ctx.foundryClient),
    }),
    image: action({
      description:
        'Return the scene map as an image (thumbnail by default; full=true fetches the full background when under ~1.5 MB, else falls back to the thumbnail).',
      schema: z.object({
        scene: z.string().describe('Scene id or name (partial ok)'),
        full: z.boolean().optional().describe('Fetch the full background image (default false)'),
      }),
      run: (a, ctx) => handleGetSceneImage(a, ctx.foundryClient),
    }),
  },
});

export const tokensEditTool = new DomainTool({
  name: 'foundry_tokens_edit',
  title: 'Edit tokens',
  toolset: 'tokens',
  write: true,
  destructive: true,
  description:
    'WRITE: place and move tokens on scenes in the live world. Needs FOUNDRY_WRITE_ENABLED=true and a GM login; writes are logged and revertible with foundry_history_edit.',
  actions: {
    place: action({
      description:
        'Place tokens of a world actor on a scene using its prototype token. x,y are grid squares from the top-left of the map image (0,0); omit both for the centre. count (1-20) places several in a row and numbers their names. hidden=true hides them from players (do this on the active scene unless players should see them at once). Only creates tokens.',
      schema: z.object({
        scene: z.string().describe('Scene id or name (partial ok)'),
        actor: z.string().describe('Actor id, name or player name'),
        x: z.number().optional().describe('Grid column from the left (0-based)'),
        y: z.number().optional().describe('Grid row from the top (0-based)'),
        count: z.number().optional().describe('How many tokens to place, 1-20 (default 1)'),
        hidden: z.boolean().optional().describe('Place hidden from players'),
        disposition: z
          .enum(['hostile', 'neutral', 'friendly'])
          .optional()
          .describe('Token disposition'),
        name: z.string().optional().describe('Override the token name'),
      }),
      run: (a, ctx) => handlePlaceActorOnScene(a, ctx.foundryClient),
    }),
    place_group: action({
      description:
        'Lay out several actors as a tidy block of tokens inside a rectangle (area, in grid squares from the map top-left) or a region (region_id; uses the bounding box of its first shape). Fills left to right then top to bottom, honouring each actor prototype token size, with spacing empty squares between tokens (default 1). Errors without placing anything if they do not fit. All tokens are one undo step. Only creates tokens.',
      schema: z.object({
        scene: z.string().describe('Scene id or name (partial ok)'),
        actors: z
          .array(
            z.object({
              ref: z.string().describe('Actor id, name or player name'),
              count: z
                .number()
                .int()
                .min(1)
                .max(20)
                .optional()
                .describe('Tokens of it (default 1)'),
            }),
          )
          .min(1)
          .max(20),
        area: z
          .object({
            x: z.number().describe('Left column'),
            y: z.number().describe('Top row'),
            width: z.number().positive().describe('Width in squares'),
            height: z.number().positive().describe('Height in squares'),
          })
          .optional()
          .describe('Rectangle in grid squares (or use region_id)'),
        region_id: z.string().optional().describe('Region id or name to fill (or use area)'),
        spacing: z.number().min(0).optional().describe('Empty squares between tokens (default 1)'),
        hidden: z.boolean().optional().describe('Place hidden from players'),
        disposition: z
          .enum(['hostile', 'neutral', 'friendly'])
          .optional()
          .describe('Token disposition'),
      }),
      run: (a, ctx) => handlePlaceGroup(a, ctx.foundryClient),
    }),
    update: action({
      description:
        'Change a placed token: name, hidden, disposition, size (grid squares, sets width and height), width, height, elevation, rotation, alpha, locked. Only the fields you give change.',
      schema: z.object({
        tokenId: z.string().describe('Id of the token'),
        sceneId: z.string().optional().describe('Scene to look in'),
        name: z.string().optional().describe('Token name'),
        hidden: z.boolean().optional().describe('Hide from players'),
        disposition: z
          .enum(['secret', 'hostile', 'neutral', 'friendly'])
          .optional()
          .describe('Token disposition'),
        size: z.number().positive().optional().describe('Size in grid squares (width and height)'),
        width: z.number().positive().optional().describe('Width in grid squares'),
        height: z.number().positive().optional().describe('Height in grid squares'),
        elevation: z.number().optional().describe('Elevation'),
        rotation: z.number().optional().describe('Rotation in degrees'),
        alpha: z.number().min(0).max(1).optional().describe('Opacity 0-1'),
        locked: z.boolean().optional().describe('Lock the token against movement'),
      }),
      run: (a, ctx) => handleUpdateToken(a, ctx.foundryClient),
    }),
    delete: action({
      description:
        'Remove a token from its scene; the actor is untouched. Confirm with the user first; foundry_history_edit undo can put it back.',
      schema: z.object({
        tokenId: z.string().describe('Id of the token to remove'),
        sceneId: z.string().optional().describe('Scene to look in'),
      }),
      run: (a, ctx) => handleDeleteToken(a, ctx.foundryClient),
    }),
    move: action({
      description:
        "Move a token to absolute pixel coordinates on its scene (not grid squares, not offsets). The token is found across scenes by id, optionally scoped with sceneId. No tool reports a token's current position or grid size, so ask the user for the destination rather than guessing.",
      schema: z.object({
        tokenId: z.string().describe('Id of the token to move'),
        x: z.number().describe('Target x in pixels'),
        y: z.number().describe('Target y in pixels'),
        sceneId: z.string().optional().describe('Scene to look in'),
      }),
      run: (a, ctx) => handleMoveToken(a, ctx.foundryClient),
    }),
  },
});

const sceneRef = z.string().describe('Scene id or name (partial ok)');
const col = z
  .number()
  .describe('Grid column from the left of the map image (0-based; fractions move within a square)');
const row = z
  .number()
  .describe('Grid row from the top of the map image (0-based; fractions move within a square)');

export const scenesEditTool = new DomainTool({
  name: 'foundry_scenes_edit',
  title: 'Edit scenes',
  toolset: 'scenes',
  write: true,
  destructive: true,
  description:
    'WRITE: activate scenes, change scene settings, and add or remove map notes and lights in the live world. Positions are grid squares from the top-left of the map image. Needs FOUNDRY_WRITE_ENABLED=true and a GM login; writes are logged and revertible with foundry_history_edit. Note and light ids are shown by foundry_scenes get.',
  actions: {
    activate: action({
      description:
        'Make a scene the active scene: players are moved to it and any other active scene is deactivated.',
      schema: z.object({ scene: sceneRef }),
      run: (a, ctx) => handleActivateScene(a, ctx.foundryClient),
    }),
    update: action({
      description:
        'Change scene settings: name, darkness (0 = day, 1 = night), global_light, navigation (show in the scene bar) and nav_name, token_vision, fog_exploration, and the grid (grid_size in pixels, grid_distance and grid_units per square). Only the settings you give change.',
      schema: z.object({
        scene: sceneRef,
        name: z.string().optional().describe('New scene name'),
        darkness: z.number().min(0).max(1).optional().describe('Darkness level 0-1'),
        global_light: z.boolean().optional().describe('Global illumination on or off'),
        navigation: z.boolean().optional().describe('Show in the navigation bar'),
        nav_name: z.string().optional().describe('Name shown in the navigation bar'),
        token_vision: z.boolean().optional().describe('Enable token vision'),
        fog_exploration: z.boolean().optional().describe('Remember explored areas'),
        grid_size: z
          .number()
          .int()
          .min(50)
          .optional()
          .describe('Grid square size in pixels (min 50)'),
        grid_distance: z.number().positive().optional().describe('Distance of one square, e.g. 5'),
        grid_units: z.string().optional().describe('Distance unit, e.g. "ft"'),
      }),
      run: (a, ctx) => handleUpdateScene(a, ctx.foundryClient),
    }),
    fit_grid: action({
      description:
        'Set the grid size so a given number of squares spans the map image: cells_x (squares across) or cells_y (squares down), or set grid_size in pixels directly. Uses the scene image size (no image analysis); the grid never goes below 50 px. Reports the resulting square counts.',
      schema: z.object({
        scene: sceneRef,
        cells_x: z.number().int().positive().optional().describe('Squares across the image'),
        cells_y: z.number().int().positive().optional().describe('Squares down the image'),
        grid_size: z.number().int().min(50).optional().describe('Pixels per square (min 50)'),
      }),
      run: (a, ctx) => handleFitGrid(a, ctx.foundryClient),
    }),
    add_note: action({
      description:
        'Pin a map note at a grid square, optionally linked to a journal entry (and one of its pages) so players can open it from the map.',
      schema: z.object({
        scene: sceneRef,
        x: col,
        y: row,
        journal: z.string().optional().describe('Journal entry id or name to link'),
        page: z.string().optional().describe('Page id or name of that journal (needs journal)'),
        text: z.string().optional().describe('Label shown on the map'),
        icon_size: z.number().int().min(32).optional().describe('Icon size in pixels (default 40)'),
        font_size: z.number().int().min(8).max(128).optional().describe('Label size (default 32)'),
        global: z.boolean().optional().describe('Visible even outside line of sight'),
      }),
      run: (a, ctx) => handleAddNote(a, ctx.foundryClient),
    }),
    remove_note: action({
      description: 'Remove a map note by id or exact label.',
      schema: z.object({
        scene: sceneRef,
        note: z.string().describe('Note id or exact label (ids: foundry_scenes get)'),
      }),
      run: (a, ctx) => handleRemoveNote(a, ctx.foundryClient),
    }),
    add_light: action({
      description:
        'Add an ambient light at a grid square. bright and dim are radii in scene distance units (defaults 10 and 20 if neither is given); color is a hex string; angle < 360 makes a cone aimed by rotation.',
      schema: z.object({
        scene: sceneRef,
        x: col,
        y: row,
        name: z.string().optional().describe('Label for the light'),
        bright: z.number().min(0).optional().describe('Bright radius'),
        dim: z.number().min(0).optional().describe('Dim radius'),
        color: z.string().optional().describe('Light colour, e.g. "#ffaa55"'),
        angle: z.number().min(0).max(360).optional().describe('Emission angle (default 360)'),
        alpha: z.number().min(0).max(1).optional().describe('Colour intensity 0-1'),
        rotation: z.number().optional().describe('Direction in degrees for a cone'),
        walls: z.boolean().optional().describe('Blocked by walls (default true)'),
        vision: z.boolean().optional().describe('Also grants vision'),
        hidden: z.boolean().optional().describe('Switched off'),
      }),
      run: (a, ctx) => handleAddLight(a, ctx.foundryClient),
    }),
    remove_light: action({
      description: 'Remove an ambient light by id or exact name.',
      schema: z.object({
        scene: sceneRef,
        light: z.string().describe('Light id or exact name (ids: foundry_scenes get)'),
      }),
      run: (a, ctx) => handleRemoveLight(a, ctx.foundryClient),
    }),
  },
});
