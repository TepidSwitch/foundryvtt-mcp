/**
 * @fileoverview World tools: foundry_world (read)
 */

import { z } from 'zod';
import { action, DomainTool, noArgs } from '../domain.js';
import { handleGetUsers } from '../handlers/users.js';
import {
  handleGetWorldSummary,
  handleRefreshWorldData,
  handleSearchWorld,
} from '../handlers/world.js';
import { handleBrowseWorld } from '../handlers/world-browse.js';

export const worldTool = new DomainTool({
  name: 'foundry_world',
  title: 'Foundry world',
  toolset: 'world',
  write: false,
  description:
    'Read world-level information: overview, cross-collection search, audio/macros/modules/folders, users.',
  actions: {
    summary: action({
      description:
        'World metadata (title, game system, core version) and per-collection document counts.',
      schema: noArgs,
      run: (a, ctx) => handleGetWorldSummary(a, ctx.foundryClient),
    }),
    search: action({
      description:
        'Search actors, items, scenes and journals by name at once, grouped by collection. For ids of actors/items read the foundry://actors and foundry://items resources or use foundry_actors search.',
      schema: z.object({
        query: z.string().describe('Search text'),
        limit: z.number().optional().describe('Maximum results per collection (default 5)'),
      }),
      run: (a, ctx) => handleSearchWorld(a, ctx.foundryClient),
    }),
    browse: action({
      description:
        'List world content with no dedicated tool: playlists (with tracks), macros, roll tables, installed modules, folders (optionally by folder_type such as Scene or Actor) and compendium packs.',
      schema: z.object({
        kind: z
          .enum(['playlists', 'macros', 'tables', 'modules', 'folders', 'packs'])
          .describe('What to list'),
        query: z.string().optional().describe('Only rows containing this text'),
        folder_type: z
          .string()
          .optional()
          .describe('Folder document type for kind="folders", e.g. Scene, Actor'),
        limit: z.number().optional().describe('Maximum rows (default 60)'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Rows to skip before the page (default 0)'),
      }),
      run: (a, ctx) => handleBrowseWorld(a, ctx.foundryClient),
    }),
    users: action({
      description:
        "The world's users with roles and online status. Online status follows live userActivity broadcasts while the socket is up; after a drop it is stale until refresh. Use it to find who holds the GM role or who is connected.",
      schema: noArgs,
      run: (a, ctx) => handleGetUsers(a, ctx.foundryClient),
    }),
    refresh: action({
      description:
        'Re-fetch the cached world data. Reads follow live changes while the connection holds, so this is rarely needed: use it after the connection dropped and came back, or when a read looks stale after an out-of-band change (notably unlinked token actors). Refreshes the cache only.',
      schema: noArgs,
      run: (a, ctx) => handleRefreshWorldData(a, ctx.foundryClient),
    }),
  },
});
