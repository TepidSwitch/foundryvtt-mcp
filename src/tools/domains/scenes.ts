/**
 * @fileoverview Scene and token tools: foundry_scenes (read), foundry_tokens_edit (write)
 */

import { z } from 'zod';
import { action, DomainTool } from '../domain.js';
import { handlePlaceActorOnScene } from '../handlers/import-place.js';
import {
  handleGetSceneImage,
  handleGetSceneInfo,
  handleSearchScenes,
  handleSuggestScenes,
} from '../handlers/scenes.js';
import { handleMoveToken } from '../handlers/token-mutations.js';

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
