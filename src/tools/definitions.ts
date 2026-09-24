/**
 * @fileoverview Tool definitions for FoundryVTT MCP Server
 *
 * This module contains all tool schema definitions organized by category.
 * Tools are separated into logical groups for better maintainability.
 */

/**
 * Shared write-safety clause appended to every mutation tool description.
 *
 * Both halves are enforced in code by `assertWriteable()`
 * (`src/foundry/client.ts`): the `FOUNDRY_WRITE_ENABLED` opt-in (default
 * `false`, see `src/config/index.ts`) and a live authenticated Socket.IO
 * session. Foundry itself enforces the GM/owner permission (ADR-010).
 */
const WRITE_GATE =
  'WRITE: mutates the live world. Requires FOUNDRY_WRITE_ENABLED=true (default false) and an active Socket.IO connection, and is refused otherwise; Foundry additionally enforces GM/owner permission on the document.';

/**
 * Extra clause for destructive tools (data removal that this server cannot undo).
 */
const CONFIRM_FIRST =
  'DESTRUCTIVE and not undoable from this server: confirm the exact target with the user before calling.';

/**
 * Canonical `roll_dice` description.
 *
 * Exported so `RollDiceTool` (`src/tools/handlers/dice.ts`) can reuse the exact
 * same string instead of keeping a second copy that silently drifts: the
 * registry class is what *executes* the tool while `getAllTools()` is what is
 * *listed*, so a divergence would be invisible.
 */
export const ROLL_DICE_DESCRIPTION =
  'Roll dice and return the total with a per-term breakdown. Dice terms and whole numbers joined by + or -, with whitespace allowed anywhere ("1d20+5", "1d20 + 5", "1d20+5+3", "2d6 + 1d4", "3d6"; a count-less "d20" means one die), always work and every term counts towards the total - that is the portable grammar, safe on either transport. Multiplication and Foundry modifier syntax such as "4d6kh3" or "1d20r1" are rejected on both transports, with an error naming the offending character and its position, never dropped from the total in silence. Parentheses are the one difference: with FOUNDRY_API_KEY set the formula goes to FoundryVTT\'s own Roll engine, which evaluates them, while the default Socket.IO transport rolls locally and rejects them by name - and a REST roll that cannot reach the server falls back to that same local roller, so a parenthesised formula can still fail there. Prefer the expanded form when it matters. Use when: the user asks for a check, save, attack, damage, or any random result.';

/**
 * Dice rolling tool definitions
 */
export const diceTools = [
  {
    name: 'roll_dice',
    description: ROLL_DICE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        formula: {
          type: 'string',
          description: 'Dice formula (e.g., "1d20+5", "3d6")',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for the roll',
        },
      },
      required: ['formula'],
    },
  },
];

/**
 * Actor management tool definitions
 */
export const actorTools = [
  {
    name: 'search_actors',
    description:
      'Search actors (player characters, NPCs) by name, optionally filtered by type. Returns one line per match: name, type, class and level (or CR for NPCs), current/max HP (max is computed from class hit dice when the world stores none) and the actor id. Use when: finding an actor or getting a quick roster with ids. Do not use when: you want a full sheet (use get_actor_details), the party at a glance (use get_party_overview), or what an actor carries (use get_actor_items).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for actor names',
        },
        type: {
          type: 'string',
          description: 'Actor type filter (character, npc, etc.)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
          default: 10,
        },
      },
    },
  },
  {
    name: 'get_actor_details',
    description:
      "Get the full computed sheet for one actor: class/level (or CR), race, background, HP (current/max/temp), AC and how it is derived, initiative, speed, proficiency bonus, ability scores with modifiers and saves, trained skills with totals, passive Perception/Investigation/Insight, senses, languages, resistances, proficiencies, spellcasting (ability, save DC, attack bonus, spell slots used/max), currency and player name. Values are derived from raw world data (dnd5e stores no computed sheet values); active-effect and magic-item bonuses are not applied. Accepts an actor id, an actor name, or a player's name (returns their character). Use when: asked about any character or monster's stats, or as the read-before-write step for update_actor_attributes. Do not use when: you want the spell list, features or inventory (use get_actor_items) or the whole party (use get_party_overview).",
    inputSchema: {
      type: 'object',
      properties: {
        actor: {
          type: 'string',
          description: "Actor id, actor name (partial ok), or a player's name",
        },
        actorId: {
          type: 'string',
          description: 'Alias for actor (an actor id)',
        },
      },
    },
  },
  {
    name: 'get_actor_items',
    description:
      'List everything an actor owns, with item ids: spells grouped by level (school, casting time, range, duration, components, concentration/ritual, preparation state, uses), class features and feats, weapons, equipment, consumables, tools, loot and containers (quantity, equipped, attunement, damage). Use when: asked for a character\'s spell list, features, attacks, inventory or gear, or when you need an itemId for update_actor_item/delete_actor_item. Filter with type ("spell", "feat", "weapon", "equipment", "consumable", "tool", "loot", "container", "class", "subclass", "race", "background", or "inventory" for all gear) and/or query (name substring). Set details=true to include description text and damage/save activities. Accepts an actor id, name, or player name.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {
          type: 'string',
          description: "Actor id, actor name (partial ok), or a player's name",
        },
        type: {
          type: 'string',
          description: 'Item type filter, or "inventory" for all gear',
        },
        query: {
          type: 'string',
          description: 'Only items whose name contains this text',
        },
        details: {
          type: 'boolean',
          description: 'Include descriptions and activity summaries (longer output)',
          default: false,
        },
      },
      required: ['actor'],
    },
  },
  {
    name: 'get_party_overview',
    description:
      "One-screen summary of every player character: player name, class and level, HP, AC, passive Perception/Investigation/Insight, spell save DC and actor id, plus average party level and any characters with no assigned player. Use when: planning encounters, checking who is hurt, or asking about 'the party'. Do not use when: you need one character's full sheet (use get_actor_details).",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'find_in_party',
    description:
      'Find which characters have a spell, feature or item, by name substring, with quantity, equipped/attuned state, uses left, and spell preparation. Use when: asked "who has Counterspell?", "who is carrying healing potions?", "does anyone have a rope?". scope="party" (default) searches player characters, scope="all" searches every actor including NPCs; include_unassigned adds characters with no player. type narrows to spell, feat, weapon, equipment, consumable, tool, loot or container. Do not use when: you want everything one character owns (use get_actor_items).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name (or part of a name) to look for' },
        type: { type: 'string', description: 'Optional item type filter' },
        scope: {
          type: 'string',
          enum: ['party', 'all'],
          description: 'Who to search',
          default: 'party',
        },
        include_unassigned: {
          type: 'boolean',
          description: 'Include characters with no assigned player',
          default: false,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'compare_party',
    description:
      'Rank the party by one stat, effect-adjusted where effects are numeric. stat options: hp (most hurt first), ac, initiative, speed, level, proficiency, spell_dc, spell_attack, passive_perception, passive_investigation, passive_insight, ability:<str|dex|con|int|wis|cha>, save:<ability>, skill:<name> (e.g. skill:stealth, skill:sleight of hand). Use when: asked who is best at something, who is hurt, who has the highest AC, or who to send to scout. Do not use when: you want one character in full (use get_actor_details).',
    inputSchema: {
      type: 'object',
      properties: {
        stat: {
          type: 'string',
          description: 'Stat to rank by, e.g. "hp", "ac", "skill:stealth", "save:wis"',
        },
        scope: {
          type: 'string',
          enum: ['party', 'all'],
          description: 'Who to include',
          default: 'party',
        },
        include_unassigned: {
          type: 'boolean',
          description: 'Include characters with no assigned player',
          default: false,
        },
      },
      required: ['stat'],
    },
  },
];

/**
 * Actor attribute mutation tool definitions (#143)
 *
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active
 * Socket.IO connection (mutations use the core `modifyDocument` protocol).
 */
export const actorMutationTools = [
  {
    name: 'update_actor_attributes',
    description:
      'Update fields on an actor\'s system data. Patch keys are dot-paths into actor.system (e.g. "attributes.hp.value", "attributes.hp.temp", "currency.gp", "resources.primary.value", "spells.spell1.value", "attributes.exhaustion") and values are absolute target values, never relative deltas. Validates HP <= max + temp, spell slots <= max, and exhaustion within 0-10 (2024) or 0-6 (2014), and returns the post-update value for every patched path. Use when: applying damage or healing, spending a spell slot or resource, or adjusting currency on a known actorId. Do not use when: changing an item the actor owns (use update_actor_item) or only reading current values (use get_actor_details). ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: {
          type: 'string',
          description: 'The ID of the actor to update',
        },
        patch: {
          type: 'object',
          description:
            'Map of dot-path → value, where each dot-path addresses a field under actor.system ' +
            '(e.g. {"attributes.hp.value": 30, "currency.gp": 12}). Values must be number, string, or boolean.',
          additionalProperties: {
            type: ['number', 'string', 'boolean'],
          },
        },
      },
      required: ['actorId', 'patch'],
    },
  },
];

/**
 * Item management tool definitions
 */
export const itemTools = [
  {
    name: 'search_items',
    description:
      'Search item documents in the world by name, optionally filtered by type. Returns name, type and rarity per match (rarity shows "Common" when the system records none); price is not available and always prints "Unknown price", and the rarity filter is ignored unless the REST API module is configured (FOUNDRY_API_KEY). Item ids are not printed - read the foundry://items resource, whose JSON lists up to the first 100 items with their _id (not exhaustive in larger worlds). Use when: checking whether an item exists in the world. Do not use when: searching compendium packs (use search_compendium) or listing what one actor carries (this searches world items, not owned items).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for item names',
        },
        type: {
          type: 'string',
          description: 'Item type filter (weapon, armor, consumable, etc.)',
        },
        rarity: {
          type: 'string',
          description:
            'Item rarity filter (common, uncommon, rare, etc.). Applied only in REST API mode (FOUNDRY_API_KEY); ignored on the default Socket.IO path.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
          default: 10,
        },
      },
    },
  },
];

/**
 * Compendium search tool definitions (#144)
 */
export const compendiumTools = [
  {
    name: 'search_compendium',
    description:
      'Search FoundryVTT compendium packs by name (SRD spells/monsters/items/rules, DDB imports, map packs, roll tables); searches all packs unless compendiumId scopes it to one. Returns pack id and entry id per hit - pass them to get_compendium_document to read the full entry. Works over the normal Socket.IO login; packType (Item, Actor, Scene, JournalEntry, RollTable) and itemType (spell, weapon, feat, npc...) filters work everywhere, while spellLevel and source filters only apply when the REST API module is configured. Use when: looking up spells, monsters, equipment or maps not yet in the world. Do not use when: the document already exists in the world - use search_items or search_world. See browse_world kind="packs" for the pack list.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for compendium entry names',
        },
        filters: {
          type: 'object',
          description: 'Optional metadata filters to narrow the search',
          properties: {
            compendiumId: {
              type: 'string',
              description: 'Scope the search to a single compendium pack',
            },
            packType: {
              type: 'string',
              description: 'Pack document type (Item, Actor, JournalEntry, Macro)',
            },
            itemType: {
              type: 'string',
              description: 'Item type filter (spell, weapon, feat, etc.)',
            },
            spellLevel: {
              type: 'number',
              description: 'Spell level filter',
            },
            source: {
              type: 'string',
              description: 'Source/rules filter (e.g. a sourcebook abbreviation)',
            },
          },
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results per page',
          default: 20,
        },
        cursor: {
          type: 'string',
          description:
            'Opaque pagination cursor from a prior result\'s "Next page" cursor; omit for the first page',
        },
      },
      required: ['query'],
    },
  },
];

/**
 * Actor item mutation tool definitions (WRITE — require FOUNDRY_WRITE_ENABLED
 * and an active Socket.IO connection; mutations use `modifyDocument`)
 *
 * The canonical mutation target is the D&D 5e v4+ activity schema. Item
 * `system` patches honour JSON-merge-patch semantics on nested paths.
 */
export const itemMutationTools = [
  {
    name: 'create_actor_item',
    description:
      'Create an item on an actor from an inline item document (type, name, system). Use when: adding a new weapon, spell, feature, or piece of equipment to a known actorId. Do not use when: editing an item the actor already owns - use update_actor_item. Replacing an item is not atomic: create the replacement first and delete the old one second, so a mid-sequence failure leaves the actor with a duplicate rather than nothing. Compendium-source create is not yet supported over Socket.IO (see issue #159). Canonical target: D&D 5e v4+ activity schema. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: {
          type: 'string',
          description: 'The ID of the actor to add the item to',
        },
        source: {
          type: 'object',
          description:
            'Item source. Use { type: "inline", item: { type, name, system } } to create the item directly. The { type: "compendium", compendiumId, itemId } shape is accepted by the schema but rejected at call time - compendium-source create is not yet supported over Socket.IO.',
          properties: {
            type: {
              type: 'string',
              enum: ['compendium', 'inline'],
              description:
                'Source kind. Only "inline" is functional today; "compendium" is rejected at call time.',
            },
            compendiumId: {
              type: 'string',
              description: 'Compendium pack id (compendium source)',
            },
            itemId: {
              type: 'string',
              description: 'Item id within the compendium pack (compendium source)',
            },
            item: {
              type: 'object',
              description: 'Inline item document with type, name, and system (inline source)',
            },
          },
          required: ['type'],
        },
      },
      required: ['actorId', 'source'],
    },
  },
  {
    name: 'update_actor_item',
    description:
      "Apply a JSON merge patch to an item's system data on an actor: nested paths such as activities.{id}.consumption.targets are supported, values are absolute (arrays replace, null deletes). Use when: changing fields on an item the actor already owns, given actorId + itemId. Do not use when: adding a new item (create_actor_item) or removing one (delete_actor_item). Canonical target: D&D 5e v4+ activity schema. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: {
          type: 'string',
          description: 'The ID of the actor that owns the item',
        },
        itemId: {
          type: 'string',
          description: 'The ID of the item to update',
        },
        patch: {
          type: 'object',
          description:
            'JSON merge patch applied to item.system; nested paths supported (e.g. activities.{id}.consumption.targets)',
        },
      },
      required: ['actorId', 'itemId', 'patch'],
    },
  },
  {
    name: 'delete_actor_item',
    description:
      "Permanently remove an item owned by an actor. Use when: the user explicitly asks to delete or discard a specific owned item, and has given you the itemId - get the id from get_actor_items, and never guess one. Do not use when: only the item's data needs to change - use update_actor_item. In a replacement or migration flow, run create_actor_item first and this second: the two calls are not atomic, and failing after the delete loses the item. Echo the actorId and itemId back to the user and get their confirmation before calling. " +
      CONFIRM_FIRST +
      ' ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: {
          type: 'string',
          description: 'The ID of the actor that owns the item',
        },
        itemId: {
          type: 'string',
          description: 'The ID of the item to delete',
        },
      },
      required: ['actorId', 'itemId'],
    },
  },
];

/**
 * Scene management tool definitions
 */
export const sceneTools = [
  {
    name: 'get_scene_info',
    description:
      'Full detail for one scene: folder, size in grid squares and pixels, grid, lighting/darkness/weather, counts of walls/lights/tokens/notes/tiles/regions/sounds, linked journal and playlist, every token (name, disposition, position), the map-note labels, tags inferred from the name/folder, and a prep-readiness score. Accepts a scene id or name; with neither it returns the active scene. Use when: you need what is on a scene, who is on the map, or the sceneId. Do not use when: browsing many scenes (use search_scenes) or looking at the map (use get_scene_image).',
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'Scene id. If neither sceneId nor name is given, returns the active scene',
        },
        name: {
          type: 'string',
          description: 'Scene name (partial ok)',
        },
      },
    },
  },
  {
    name: 'search_scenes',
    description:
      'List and filter every scene in the world with folder path, size in grid squares, wall/light/token/note counts and inferred tags (dungeon, social, wilderness, urban, nautical, set-piece). Use when: finding a scene by name or folder, or seeing what maps exist. Filters: query (all words must match name/folder/tags), folder, active_only, min_tokens, has_walls, has_lights, has_notes. Do not use when: you want the best scenes for a session (use suggest_scenes).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words to match against scene name, folder and tags',
        },
        folder: { type: 'string', description: 'Folder path substring' },
        active_only: { type: 'boolean', description: 'Only the active scene' },
        min_tokens: { type: 'number', description: 'Minimum number of placed tokens' },
        has_walls: { type: 'boolean', description: 'Only scenes with walls' },
        has_lights: { type: 'boolean', description: 'Only scenes with lights' },
        has_notes: { type: 'boolean', description: 'Only scenes with map notes' },
        limit: { type: 'number', description: 'Maximum results', default: 25 },
      },
    },
  },
  {
    name: 'suggest_scenes',
    description:
      'Rank scenes by how ready they are to run: walls, lighting, pre-placed tokens (with hostile names), map notes, linked journal, audio, tiles/regions and playable size, each contributing to a 0-100 readiness score with the reasons listed. Optionally bias by theme keywords (e.g. "temple, tomb") and purpose (combat, exploration, social). include_compendium=true also lists matching not-yet-imported maps from compendium packs (by name only). This is a metadata heuristic - it cannot see how a map looks; call get_scene_image on the top picks. Use when: choosing a map for the next session or encounter.',
    inputSchema: {
      type: 'object',
      properties: {
        theme: {
          type: 'string',
          description: 'Comma/space separated keywords, e.g. "temple, dragon"',
        },
        purpose: {
          type: 'string',
          enum: ['combat', 'exploration', 'social', 'any'],
          description: 'What the scene is for',
          default: 'any',
        },
        min_readiness: { type: 'number', description: 'Only scenes scoring at least this (0-100)' },
        limit: { type: 'number', description: 'Maximum results', default: 10 },
        include_compendium: {
          type: 'boolean',
          description: 'Also list matching maps from compendium scene packs (needs theme)',
          default: false,
        },
      },
    },
  },
  {
    name: 'get_scene_image',
    description:
      'Return the scene map as an image so it can be looked at (thumbnail by default; full=true fetches the full background when it is under ~1.5 MB, otherwise falls back to the thumbnail). Accepts a scene id or name. Use when: judging whether a map suits an encounter, or describing a location to players.',
    inputSchema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: 'Scene id or name (partial ok)' },
        full: {
          type: 'boolean',
          description: 'Fetch the full-size map if small enough',
          default: false,
        },
      },
      required: ['scene'],
    },
  },
  {
    name: 'get_compendium_document',
    description:
      'Read one full entry from a compendium pack: spells (level, school, casting time, range, components, damage, description), monsters (full stat block, attacks, features, lore), items (rarity, price, attunement, description), journal entries (page text) and roll tables. Get compendiumId and the entry id or exact name from search_compendium. Use when: you need the rules text for a spell/monster/item that is not on any actor, or want to prep an encounter from the SRD or DDB imports.',
    inputSchema: {
      type: 'object',
      properties: {
        compendiumId: { type: 'string', description: 'Pack id, e.g. "dnd5e.spells24"' },
        documentId: { type: 'string', description: 'Entry id from search_compendium' },
        name: { type: 'string', description: 'Entry name (used when documentId is omitted)' },
      },
      required: ['compendiumId'],
    },
  },
  {
    name: 'get_roll_table',
    description:
      'Read a roll table from the world, or from a compendium pack when compendiumId is given, listing every result row. Set roll=true to roll it locally and show the matching row (the roll is not posted to Foundry chat). Use when: you need random encounters, loot, wild magic effects or similar.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name or id' },
        compendiumId: { type: 'string', description: 'Pack id when the table is in a compendium' },
        roll: { type: 'boolean', description: 'Roll on the table', default: false },
      },
      required: ['table'],
    },
  },
  {
    name: 'browse_world',
    description:
      'List world content that has no dedicated tool: playlists (with tracks), macros, roll tables, installed modules, folders (optionally by folder_type such as Scene or Actor) and compendium packs (with entry counts). Use when: asking what audio, macros, modules or compendiums exist, or looking up a pack id for search_compendium.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['playlists', 'macros', 'tables', 'modules', 'folders', 'packs'],
          description: 'What to list',
        },
        query: { type: 'string', description: 'Only rows containing this text' },
        folder_type: {
          type: 'string',
          description: 'For kind=folders: Scene, Actor, JournalEntry, Macro',
        },
        limit: { type: 'number', description: 'Maximum rows', default: 60 },
      },
      required: ['kind'],
    },
  },
];

/**
 * Content generation tool definitions
 */
export const generationTools = [
  {
    name: 'generate_npc',
    description:
      'Generate a random NPC (name, race, class, HP, ability scores, background) as text. Use when: the user needs a throwaway NPC on the spot. Do not use when: the NPC must exist in FoundryVTT - this creates no documents, and the result still has to be entered into the world by hand.',
    inputSchema: {
      type: 'object',
      properties: {
        level: {
          type: 'number',
          description: 'Character level (1-20)',
          minimum: 1,
          maximum: 20,
          default: 1,
        },
        race: {
          type: 'string',
          description: 'Character race (optional)',
        },
        class: {
          type: 'string',
          description: 'Character class (optional)',
        },
      },
    },
  },
  {
    name: 'generate_loot',
    description:
      "Generate random treasure for an encounter as text. Only the currency amounts vary: they scale with the challenge rating, while the item list is fixed (a Healing Potion and a Silver Ring) and the treasureType argument is accepted but not used. Use when: the user wants a quick coin total for an encounter. Do not use when: the loot should end up in an actor's inventory - this creates no documents; use create_actor_item for that.",
    inputSchema: {
      type: 'object',
      properties: {
        challengeRating: {
          type: 'number',
          description: 'Challenge rating for loot generation',
          minimum: 0,
          maximum: 30,
        },
        treasureType: {
          type: 'string',
          description:
            'Type of treasure (hoard, individual, etc.). Accepted but not used - the generated result is the same whichever value is passed.',
        },
      },
    },
  },
  {
    name: 'lookup_rule',
    description:
      'Stub: builds a templated placeholder from the query and consults no rules source, so the text it returns carries no rules content. No tool in this server looks rules up.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Rule or mechanic to look up',
        },
        system: {
          type: 'string',
          description: 'Game system (D&D 5e, Pathfinder, etc.)',
        },
      },
      required: ['query'],
    },
  },
];

/**
 * Diagnostics and logging tool definitions
 */
export const diagnosticsTools = [
  {
    name: 'get_recent_logs',
    description:
      'Get recent FoundryVTT server log entries, optionally filtered by level or since a timestamp. Use when: investigating an error or recent server behaviour. Do not use when: you have a specific term to look for - use search_logs. Requires the REST API module (FOUNDRY_API_KEY); fails without it.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of log entries to retrieve',
          default: 20,
          minimum: 1,
          maximum: 100,
        },
        level: {
          type: 'string',
          description: 'Log level filter (debug, info, warn, error)',
          enum: ['debug', 'info', 'warn', 'error'],
        },
        since: {
          type: 'string',
          description: 'Get logs since this timestamp (ISO format)',
        },
      },
    },
  },
  {
    name: 'search_logs',
    description:
      'Search the FoundryVTT server logs for a query string and list the matching entries. Use when: hunting a specific error message, stack trace, or module name. Do not use when: you just want the latest entries - use get_recent_logs. The reported match count is the server\'s total for the query, while limit caps how many of those entries are rendered (default 50, hard cap 1000). Level filtering accepts info, warn and error; "debug" is not a level this log store records, so it is reported back as unsupported and no level filter is applied. Requires the REST API module (FOUNDRY_API_KEY); fails without it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for log contents',
        },
        level: {
          type: 'string',
          description:
            'Log level filter; "debug" is not recorded by this log store and is not applied',
          enum: ['debug', 'info', 'warn', 'error'],
        },
        limit: {
          type: 'number',
          description: 'Maximum number of matched entries to render (capped at 1000)',
          default: 50,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_system_health',
    description:
      "Get the FoundryVTT server's health report: the overall status (healthy, warning, or critical), FoundryVTT and game-system versions, world id and uptime, active/total user counts with the number of GMs, active/installed module counts, connected clients, heap and RSS memory, and the log buffer size with recent error/warning counts and error rate. CPU and disk are not reported - the diagnostics response models no such fields - and the uptime and memory lines are omitted when the server does not supply them. Use when: you want the server's own view of its health. Do not use when: you also want connection and world status - use get_health_status. Requires the REST API module (FOUNDRY_API_KEY); fails without it.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'diagnose_errors',
    description:
      'Stub: returns a fixed "no errors detected" summary regardless of input; real diagnostic logic is not implemented, so the summary reflects nothing about the server. For actual log content use get_recent_logs.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Error category to focus on',
        },
      },
    },
  },
  {
    name: 'get_health_status',
    description:
      "Get a combined health report: MCP-to-FoundryVTT connection state, world title/system/core version, and the server's health status with its active/total user counts, uptime, heap memory and recent error/warning counts. The world section is prefixed with a stale marker when the cached snapshot stopped following live document changes - typically a dropped connection, whose missed updates are never replayed - and refresh_world_data resyncs it. The connection line is a live read of the socket on the default Socket.IO transport, so it follows a link that drops or comes back in both directions; with FOUNDRY_API_KEY set there is no socket and it reports the outcome of the last REST request instead, not a live probe, so a server that went away between requests still reads as connected until the next request fails. Uptime and memory are omitted when the server does not report them; CPU, disk and playtime are not reported at all. Degrades gracefully - sections that need the REST API module (FOUNDRY_API_KEY) report as unavailable rather than failing. Use when: first checking which world is loaded and whether the server reports itself healthy.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Combat tool definitions
 */
export const combatTools = [
  {
    name: 'get_combat_state',
    description:
      "Get the active combat encounter: initiative order with each combatant's name, initiative, HP and AC, plus the current round and which combatant is up. Use when: reporting whose turn it is, or checking whether a combat is already running before start_combat. Do not use when: you need a combatantId for set_initiative - this prints names and ordinals, not ids; read the foundry://combat resource, whose JSON includes each combatant's _id and lists combatants in this same initiative order, so the Nth entry printed here is that resource's combatants[N-1] and combat.turn indexes it directly.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Combat control mutation tool definitions (FR-018)
 *
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active Socket.IO
 * connection (mutations use the core `modifyDocument` protocol). All operate on
 * the *active* combat; the connected user needs GM/owner permission.
 */
export const combatMutationTools = [
  {
    name: 'next_turn',
    description:
      'Advance the active combat to the next turn, wrapping to the next round after the last combatant. When skipDefeated is true, defeated combatants are skipped. Use when: the current combatant has finished their turn. Do not use when: only reporting the turn order - use get_combat_state. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        skipDefeated: {
          type: 'boolean',
          description:
            "Skip combatants flagged as defeated when advancing. Defaults to the combat's skipDefeated setting, or false.",
        },
      },
    },
  },
  {
    name: 'end_combat',
    description:
      'End the active combat encounter by deleting its Combat document, discarding the initiative order and round count. Use when: the fight is over and the user asks to end the encounter. ' +
      CONFIRM_FIRST +
      ' ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'set_initiative',
    description:
      "Set a combatant's initiative in the active combat (or in combatId when given), reordering the turn order. When that reorder moves the combatant who is currently acting to a different position, the encounter's turn index is rewritten to follow them - whoever was up stays up, and the result says so - rather than leaving the marker on whoever slid into the old slot. That follow-up applies only to the active combat: a combatId naming some other encounter still records the initiative, but its turn order is not readable here and is left alone. Use when: an initiative roll needs to be recorded or corrected for a known combatantId. Do not use when: simply moving on to the next combatant - use next_turn. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        combatantId: {
          type: 'string',
          description: 'The ID of the combatant whose initiative to set',
        },
        initiative: {
          type: 'number',
          description: 'The initiative value to assign',
        },
        combatId: {
          type: 'string',
          description: 'Optional Combat document ID; defaults to the active combat',
        },
      },
      required: ['combatantId', 'initiative'],
    },
  },
  {
    name: 'start_combat',
    description:
      'Start a new combat encounter, seeding combatants from tokens: pass explicit tokenIds, or omit them to seed every token on the scene. Defaults to the active scene when sceneId is omitted. Use when: a fight begins and no combat is running. Do not use when: a combat is already active - check get_combat_state first, since this always creates an additional encounter. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        tokenIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of Token document IDs to add as combatants. Defaults to all tokens on the scene.',
        },
        sceneId: {
          type: 'string',
          description: 'Optional Scene document ID; defaults to the active scene.',
        },
      },
    },
  },
];

/**
 * Token manipulation mutation tool definitions (FR-019)
 *
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active Socket.IO
 * connection (mutations use the core `modifyDocument` protocol). The connected
 * user needs GM/owner permission.
 */
export const tokenMutationTools = [
  {
    name: 'move_token',
    description:
      "Move a token to new x/y pixel coordinates on its scene; the token is located across scenes by id, optionally scoped with sceneId. Coordinates are absolute pixels, not grid squares and not offsets. Use when: repositioning a token to a position the user has given you. Do not use when: you would have to guess the destination - no tool in this server reports a token's current position or the scene grid size, so ask the user for the target coordinates rather than inferring them. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: {
          type: 'string',
          description: 'The ID of the token to move',
        },
        x: {
          type: 'number',
          description: 'Target x pixel coordinate on the scene',
        },
        y: {
          type: 'number',
          description: 'Target y pixel coordinate on the scene',
        },
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID to scope the token lookup',
        },
      },
      required: ['tokenId', 'x', 'y'],
    },
  },
  {
    name: 'apply_status_effect',
    description:
      'Apply or remove a status condition (e.g. "prone", "stunned") on a token\'s actor. Set active=false to remove. Matches by status id, so re-applying or clearing-when-absent is a no-op. Use when: a condition is gained or lost. Do not use when: changing numeric state such as HP or exhaustion - use update_actor_attributes. ' +
      WRITE_GATE +
      ' Exception: the no-op cases (applying an already-present status, or clearing an absent one) report success without attempting a write, so they also return normally while writes are disabled.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: {
          type: 'string',
          description: 'The ID of the token whose actor to affect',
        },
        statusId: {
          type: 'string',
          description: "The status condition id (e.g. 'prone', 'stunned', 'blinded')",
        },
        active: {
          type: 'boolean',
          description: 'true to apply the effect (default), false to remove it',
          default: true,
        },
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID to scope the token lookup',
        },
      },
      required: ['tokenId', 'statusId'],
    },
  },
];

/**
 * Chat message tool definitions
 */
export const chatTools = [
  {
    name: 'get_chat_messages',
    description:
      'Get the most recent chat messages from the game log. Use when: you need recent in-game context - what players said, or roll results that already happened.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of messages to retrieve (default 20)',
          default: 20,
          minimum: 1,
          maximum: 100,
        },
      },
    },
  },
];

/**
 * User tool definitions
 */
export const userTools = [
  {
    name: 'get_users',
    description:
      "List the world's users with their roles and online status. Online status is live while the Socket.IO connection is up: FoundryVTT's userActivity broadcasts are applied to the cached presence list as users connect and disconnect. It stops tracking if that connection drops and the missed changes are not replayed - get_health_status shows the snapshot as stale, and refresh_world_data resyncs it. Use when: you need to know which user holds the GM role, or who is connected right now.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Journal tool definitions
 */
export const journalTools = [
  {
    name: 'search_journals',
    description:
      'Search journal entries by name and page content. Use when: looking for notes, lore, or handouts by keyword. Do not use when: you already have the journalId - use get_journal.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for journal names and content',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results',
          default: 10,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_journal',
    description:
      'Get one journal entry by id with the text of its pages. Page bodies are HTML-stripped and each is truncated to its first 500 characters, marked with a trailing "...", so long pages come back partial. Use when: you have a journalId and need the text of its pages. Do not use when: you only have a title or keyword - run search_journals first.',
    inputSchema: {
      type: 'object',
      properties: {
        journalId: {
          type: 'string',
          description: 'The ID of the journal entry to retrieve',
        },
      },
      required: ['journalId'],
    },
  },
];

/**
 * Journal mutation tool definitions (WRITE)
 */
export const journalMutationTools = [
  {
    name: 'create_journal_entry',
    description:
      'Create a new journal entry with one or more text pages, optionally filed under a folder. Defaults to GM-only visibility - pass visibility to let players read it. Use when: recording session notes, lore, or a handout in the world. Do not use when: adding text to an existing entry - this always creates a new one. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Title of the journal entry',
        },
        pages: {
          type: 'array',
          description: 'One or more pages to create on the entry',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Page title',
              },
              content: {
                type: 'string',
                description: 'Page body as HTML or plain text',
              },
            },
            required: ['name', 'content'],
          },
          minItems: 1,
        },
        folder: {
          type: 'string',
          description: 'Optional Folder document id to file the entry under',
        },
        visibility: {
          type: 'string',
          enum: ['gm-only', 'observer', 'owner'],
          description:
            "Who can see the entry. 'gm-only' (default) hides it from players; 'observer' lets every player read it; 'owner' lets every player read and edit it.",
        },
      },
      required: ['name', 'pages'],
    },
  },
];

/**
 * World-level tool definitions
 */
export const worldTools = [
  {
    name: 'search_world',
    description:
      'Search across all collections (actors, items, scenes, journals) by name, grouped by collection. Use when: you do not know which collection holds what you are looking for. Do not use when: you already know the collection - use search_actors, search_items, or search_journals. Of those, only search_journals prints document ids; for actor and item ids read the foundry://actors and foundry://items resources, each of which lists up to the first 100 documents (not exhaustive in larger worlds).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to match against entity names',
        },
        limit: {
          type: 'number',
          description: 'Maximum results per collection (default 5)',
          default: 5,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_world_summary',
    description:
      'Get world metadata (title, game system, core version) and per-collection document counts. Use when: orienting yourself in an unfamiliar world, or confirming the game system before system-specific edits.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'refresh_world_data',
    description:
      'Force a re-fetch of the cached world data from the FoundryVTT server. Reads are normally served from a cache that follows live document changes for as long as the connection holds, so this is rarely needed. Use when: the connection dropped and came back - the cache stopped following changes while it was down and nothing replays them, so it stays a point-in-time copy until this runs, and get_health_status flags it as stale until then; or a read still looks stale after an out-of-band change - notably edits to unlinked (synthetic) token actors, which the live update feed does not cover. Refreshes the cache only; it does not modify the world.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Get all tool definitions combined
 */
export function getAllTools() {
  return [
    ...diceTools,
    ...actorTools,
    ...actorMutationTools,
    ...itemTools,
    ...compendiumTools,
    ...itemMutationTools,
    ...sceneTools,
    ...combatTools,
    ...combatMutationTools,
    ...tokenMutationTools,
    ...chatTools,
    ...userTools,
    ...journalTools,
    ...journalMutationTools,
    ...worldTools,
    ...generationTools,
    ...diagnosticsTools,
  ];
}

/**
 * Get modernized tool definitions from registry (when available)
 */
export async function getModernizedTools() {
  try {
    const { toolRegistry } = await import('./registry.js');
    const modernTools = toolRegistry.getToolDefinitions();

    // Filter out tools that have been modernized to avoid duplicates
    const modernToolNames = new Set(modernTools.map((tool) => tool.name));
    const legacyTools = getAllTools().filter((tool) => !modernToolNames.has(tool.name));

    return [...modernTools, ...legacyTools];
  } catch (_error) {
    // Fallback to legacy definitions if registry is not available
    return getAllTools();
  }
}
