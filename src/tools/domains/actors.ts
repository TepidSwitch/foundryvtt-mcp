/**
 * @fileoverview Actor tools: foundry_actors (read), foundry_actors_edit (write)
 */

import { z } from 'zod';
import { action, DomainTool } from '../domain.js';
import { handleUpdateActorAttribute } from '../handlers/actor-mutations.js';
import { handleGetActorDetails, handleSearchActors } from '../handlers/actors.js';
import { handleGetActorItems, handleGetPartyOverview } from '../handlers/character.js';
import { handleImportFromCompendium } from '../handlers/import-place.js';
import { handleSetActorOwnership } from '../handlers/ownership.js';
import { handleCompareParty, handleFindInParty } from '../handlers/party.js';
import {
  handleDamage,
  handleHeal,
  handleRequestRest,
  handleSetTempHp,
} from '../handlers/rest-healing.js';

const scope = z
  .enum(['party', 'all'])
  .optional()
  .describe('Who to include: party (default) or all');
const includeUnassigned = z
  .boolean()
  .optional()
  .describe('Include characters with no assigned player (default false)');

export const actorsTool = new DomainTool({
  name: 'foundry_actors',
  title: 'Foundry actors',
  toolset: 'actors',
  write: false,
  description:
    'Read actors (player characters, NPCs, monsters) in the Foundry world: rosters, full computed sheets, what they carry, and party-wide comparisons.',
  actions: {
    search: action({
      description:
        'Find actors by name, optionally by type. One line per match: name, type, class and level (or CR), current/max HP and the actor id. Use for rosters and to get ids.',
      schema: z.object({
        query: z.string().optional().describe('Search text for actor names'),
        type: z.string().optional().describe('Actor type filter (character, npc, ...)'),
        limit: z.number().optional().describe('Maximum results (default 10)'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Results to skip before the page (default 0)'),
      }),
      run: (a, ctx) => handleSearchActors(a, ctx.foundryClient),
    }),
    get: action({
      description:
        "Full computed sheet for one actor: class/level or CR, HP, AC, initiative, speed, abilities and saves, skills, passives, senses, languages, resistances, spellcasting, currency. Derived from raw world data; active-effect and magic-item bonuses are not applied. Accepts an actor id, name or a player's name. Read this before editing the actor.",
      schema: z.object({
        actor: z.string().optional().describe("Actor id, name (partial ok) or a player's name"),
        actorId: z.string().optional().describe('Alias for actor (an actor id)'),
      }),
      run: (a, ctx) => {
        if (typeof a.actor !== 'string' && typeof a.actorId !== 'string') {
          throw new Error('Missing required parameter: actor (id, name, or player name)');
        }
        return handleGetActorDetails(a, ctx.foundryClient);
      },
    }),
    items: action({
      description:
        'Everything an actor owns, with item ids: spells by level, features, weapons, equipment, consumables, loot. Filter with type (spell, feat, weapon, equipment, consumable, tool, loot, container, class, subclass, race, background, or "inventory" for all gear) and/or query. details=true adds descriptions and activities.',
      schema: z.object({
        actor: z.string().describe("Actor id, name (partial ok) or a player's name"),
        type: z.string().optional().describe('Item type filter, or "inventory" for all gear'),
        query: z.string().optional().describe('Only items whose name contains this text'),
        details: z
          .boolean()
          .optional()
          .describe('Include descriptions and activities (longer output)'),
      }),
      run: (a, ctx) => handleGetActorItems(a, ctx.foundryClient),
    }),
    party: action({
      description:
        'One-screen summary of every player character: player, class and level, HP, AC, passives, spell save DC, actor id; plus average level and unassigned characters.',
      schema: z.object({}),
      run: (a, ctx) => handleGetPartyOverview(a, ctx.foundryClient),
    }),
    find_in_party: action({
      description:
        'Which characters have a spell, feature or item (name substring), with quantity, equipped/attuned state, uses left and spell preparation. For "who has Counterspell?".',
      schema: z.object({
        query: z.string().describe('Name (or part of a name) to look for'),
        type: z.string().optional().describe('Item type filter'),
        scope,
        include_unassigned: includeUnassigned,
      }),
      run: (a, ctx) => handleFindInParty(a, ctx.foundryClient),
    }),
    compare: action({
      description:
        'Rank the party by one stat, effect-adjusted where numeric. stat: hp, ac, initiative, speed, level, proficiency, spell_dc, spell_attack, passive_perception, passive_investigation, passive_insight, ability:<str|dex|con|int|wis|cha>, save:<ability>, skill:<name>.',
      schema: z.object({
        stat: z.string().describe('Stat to rank by, e.g. "hp", "ac", "skill:stealth", "save:wis"'),
        scope,
        include_unassigned: includeUnassigned,
      }),
      run: (a, ctx) => handleCompareParty(a, ctx.foundryClient),
    }),
  },
});

export const actorsEditTool = new DomainTool({
  name: 'foundry_actors_edit',
  title: 'Edit Foundry actors',
  toolset: 'actors',
  write: true,
  destructive: true,
  description:
    'WRITE: change actors in the live world. Needs FOUNDRY_WRITE_ENABLED=true and a GM login; every write is logged and can be reverted with foundry_history_edit.',
  actions: {
    update: action({
      description:
        'Update fields on an actor\'s system data. patch keys are dot-paths into actor.system (e.g. "attributes.hp.value", "attributes.hp.temp", "currency.gp", "spells.spell1.value", "attributes.exhaustion"); values are absolute targets, never deltas. Validates HP <= max + temp, slots <= max and exhaustion range; returns the post-update value of each path. To change an item the actor owns use foundry_items_edit.',
      schema: z.object({
        actorId: z.string().describe('Id of the actor to update'),
        patch: z
          .record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
          .describe(
            'Map of dot-path under actor.system to value, e.g. {"attributes.hp.value": 30}',
          ),
      }),
      run: (a, ctx) => handleUpdateActorAttribute(a, ctx.foundryClient),
    }),
    set_ownership: action({
      description:
        'Set what one user (or everyone else) may do with an actor: none, limited (sees the token), observer (sees the sheet) or owner (full control; lets a player edit and use it). user is a user id or name (see foundry_world users), or "default" for everyone else.',
      schema: z.object({
        actor: z.string().describe("Actor id, name or a player's name"),
        user: z.string().describe('User id or name, or "default"'),
        level: z.enum(['none', 'limited', 'observer', 'owner']).describe('Ownership level'),
      }),
      run: (a, ctx) => handleSetActorOwnership(a, ctx.foundryClient),
    }),
    import: action({
      description:
        'Copy a compendium entry into the world as a NEW document: a monster/character becomes an Actor, an item becomes an Item (or, with actor set, is added to that actor), a map becomes a Scene (never activated); journals and roll tables too. Find compendiumId and the entry with foundry_compendium search. folder files a top-level import into an existing world folder; new_name renames the copy. Only creates; importing twice makes two copies.',
      schema: z.object({
        compendiumId: z.string().describe('Pack id, e.g. "dnd5e.actors24"'),
        documentId: z.string().optional().describe('Entry id from foundry_compendium search'),
        name: z.string().optional().describe('Entry name, used when documentId is omitted'),
        actor: z
          .string()
          .optional()
          .describe('Item packs only: actor (id, name or player name) to add the item to'),
        folder: z.string().optional().describe('Existing world folder (id or name)'),
        new_name: z.string().optional().describe('Name for the imported copy'),
      }),
      run: (a, ctx) => handleImportFromCompendium(a, ctx.foundryClient),
    }),
    request_rest: action({
      description:
        "Post dnd5e's rest request card in chat: each listed character's player presses the button to take the rest. type short (1 hour) or long (8 hours, new day). actors defaults to the party (every user-assigned character). new_day overrides the type default (long: true). Does not rest anyone itself.",
      schema: z.object({
        type: z.enum(['short', 'long']).describe('Rest type'),
        actors: z
          .array(z.string())
          .optional()
          .describe('Actor ids, names or player names (default: the party)'),
        new_day: z.boolean().optional().describe('Count as a new day (default: true for long)'),
      }),
      run: (a, ctx) => handleRequestRest(a, ctx.foundryClient),
    }),
    heal: action({
      description:
        'Restore hit points, clamped at max HP (temp HP untouched). target is an actor id/name/player name or a token id (unlinked tokens are healed on their own copy; sceneId narrows the token search). announce=true also posts a chat line. Returns HP before and after.',
      schema: z.object({
        target: z.string().describe('Actor id/name/player name, or token id'),
        amount: z.number().int().min(1).describe('Hit points to restore'),
        sceneId: z.string().optional().describe('Scene id, to find a token'),
        announce: z.boolean().optional().describe('Post a short chat line'),
      }),
      run: (a, ctx) => handleHeal(a, ctx.foundryClient),
    }),
    damage: action({
      description:
        'Deal damage: temp HP absorb first, then HP, never below 0. The raw amount is applied: type is informational only and resistances, vulnerabilities and immunities are NOT calculated. target is an actor id/name/player name or a token id (unlinked tokens are hurt on their own copy). announce=true also posts a chat line.',
      schema: z.object({
        target: z.string().describe('Actor id/name/player name, or token id'),
        amount: z
          .number()
          .int()
          .min(1)
          .describe('Damage to apply (already adjusted for resistance)'),
        type: z.string().optional().describe('Damage type, shown in the output only'),
        sceneId: z.string().optional().describe('Scene id, to find a token'),
        announce: z.boolean().optional().describe('Post a short chat line'),
      }),
      run: (a, ctx) => handleDamage(a, ctx.foundryClient),
    }),
    set_temp_hp: action({
      description:
        'Grant temporary HP. Temp HP do not stack: the higher of current and new is kept unless force=true, which replaces it (also to lower or clear it with 0). target is an actor id/name/player name or a token id.',
      schema: z.object({
        target: z.string().describe('Actor id/name/player name, or token id'),
        amount: z.number().int().min(0).describe('Temp HP'),
        force: z.boolean().optional().describe('Replace even if lower than the current temp HP'),
        sceneId: z.string().optional().describe('Scene id, to find a token'),
      }),
      run: (a, ctx) => handleSetTempHp(a, ctx.foundryClient),
    }),
  },
});
