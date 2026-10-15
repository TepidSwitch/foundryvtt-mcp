/**
 * @fileoverview Compendium tools: foundry_compendium (read)
 */

import { z } from 'zod';
import { action, DomainTool } from '../domain.js';
import { handleSearchCompendium } from '../handlers/compendium.js';
import {
  handleBrowseWorld,
  handleGetCompendiumDocument,
  handleGetRollTable,
} from '../handlers/world-browse.js';

export const compendiumTool = new DomainTool({
  name: 'foundry_compendium',
  title: 'Foundry compendium',
  toolset: 'compendium',
  write: false,
  description:
    'Read compendium packs (SRD spells/monsters/items/rules, imports, map packs, roll tables). To copy an entry into the world use foundry_actors_edit import.',
  actions: {
    search: action({
      description:
        'Search compendium packs by name (all packs unless filters.compendiumId scopes it). Returns pack id and entry id per hit. packType (Item, Actor, Scene, JournalEntry, RollTable) and itemType filters work everywhere; spellLevel and source only with the REST API module.',
      schema: z.object({
        query: z.string().describe('Search text for entry names'),
        filters: z
          .object({
            compendiumId: z.string().optional().describe('Scope to one pack'),
            packType: z
              .string()
              .optional()
              .describe('Pack document type (Item, Actor, JournalEntry, ...)'),
            itemType: z.string().optional().describe('Item type (spell, weapon, feat, ...)'),
            spellLevel: z.number().optional().describe('Spell level (REST API mode only)'),
            source: z.string().optional().describe('Source/rules filter (REST API mode only)'),
          })
          .optional()
          .describe('Optional filters to narrow the search'),
        limit: z.number().optional().describe('Maximum results per page (default 20)'),
        cursor: z.string().optional().describe('Pagination cursor from a prior result'),
      }),
      run: (a, ctx) => handleSearchCompendium(a, ctx.foundryClient),
    }),
    get: action({
      description:
        'Read one full compendium entry: spell, monster stat block, item, journal page text or roll table. Pass compendiumId plus documentId or exact name from search.',
      schema: z.object({
        compendiumId: z.string().describe('Pack id, e.g. "dnd5e.spells24"'),
        documentId: z.string().optional().describe('Entry id from search'),
        name: z.string().optional().describe('Entry name (used when documentId is omitted)'),
      }),
      run: (a, ctx) => handleGetCompendiumDocument(a, ctx.foundryClient),
    }),
    packs: action({
      description:
        'List compendium packs with their ids and entry counts, optionally filtered by text.',
      schema: z.object({
        query: z.string().optional().describe('Only rows containing this text'),
        limit: z.number().optional().describe('Maximum rows (default 60)'),
      }),
      run: (a, ctx) => handleBrowseWorld({ ...a, kind: 'packs' }, ctx.foundryClient),
    }),
    roll_table: action({
      description:
        'Read a roll table from the world, or from a pack when compendiumId is given, listing every row. roll=true rolls it locally and shows the matching row (not posted to chat).',
      schema: z.object({
        table: z.string().describe('Table name or id'),
        compendiumId: z.string().optional().describe('Pack id when the table is in a compendium'),
        roll: z.boolean().optional().describe('Roll on the table (default false)'),
      }),
      run: (a, ctx) => handleGetRollTable(a, ctx.foundryClient),
    }),
  },
});
