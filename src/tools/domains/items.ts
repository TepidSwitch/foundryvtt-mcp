/**
 * @fileoverview Item tools: foundry_items (read), foundry_items_edit (write)
 */

import { z } from 'zod';
import type { ActorItemCreateSource } from '../../foundry/types.js';
import { action, DomainTool } from '../domain.js';
import { handleUseItem } from '../handlers/chat-edits.js';
import {
  handleCreateActorItem,
  handleDeleteActorItem,
  handleUpdateActorItem,
} from '../handlers/item-mutations.js';
import { handleSearchItems } from '../handlers/items.js';
import {
  handleCreateWorldItem,
  handleDeleteWorldItem,
  handleUpdateWorldItem,
} from '../handlers/world-items.js';

export const itemsTool = new DomainTool({
  name: 'foundry_items',
  title: 'Foundry items',
  toolset: 'items',
  write: false,
  description:
    'Read world items. For what one actor carries use foundry_actors items; for compendium packs use foundry_compendium.',
  actions: {
    search: action({
      description:
        'Search item documents in the world by name, optionally by type. Returns name, type and rarity (rarity shows "Common" when none is recorded; price is not available). The rarity filter works only in REST API mode (FOUNDRY_API_KEY). Item ids are not printed - read the foundry://items resource.',
      schema: z.object({
        query: z.string().optional().describe('Search text for item names'),
        type: z.string().optional().describe('Item type filter (weapon, armor, consumable, ...)'),
        rarity: z.string().optional().describe('Rarity filter (REST API mode only)'),
        limit: z.number().optional().describe('Maximum results (default 10)'),
      }),
      run: (a, ctx) => handleSearchItems(a, ctx.foundryClient),
    }),
  },
});

export const itemsEditTool = new DomainTool({
  name: 'foundry_items_edit',
  title: 'Edit actor items',
  toolset: 'items',
  write: true,
  destructive: true,
  description:
    'WRITE: add, change or remove items - on actors, or world items - in the live world (D&D 5e v4+ activity schema). Needs FOUNDRY_WRITE_ENABLED=true and a GM login; writes are logged and revertible with foundry_history_edit.',
  actions: {
    create: action({
      description:
        'Create a world item (not on any actor). Give type (weapon, equipment, consumable, loot, spell, feat, ...) and optionally system data in the dnd5e schema. To put an item on an actor use add_to_actor.',
      schema: z.object({
        name: z.string().describe('Item name'),
        type: z.string().describe('Item type'),
        img: z.string().optional().describe('Icon path'),
        system: z.record(z.string(), z.unknown()).optional().describe('System data for the item'),
        folder: z.string().optional().describe('Existing Item folder (id or name)'),
      }),
      run: (a, ctx) => handleCreateWorldItem(a, ctx.foundryClient),
    }),
    update: action({
      description:
        'Change a world item (id or name): name, icon, folder, or system data (objects merge recursively, other values replace).',
      schema: z.object({
        item: z.string().describe('World item id or name'),
        name: z.string().optional().describe('New name'),
        img: z.string().optional().describe('New icon path'),
        folder: z.string().optional().describe('Existing Item folder (id or name)'),
        system: z.record(z.string(), z.unknown()).optional().describe('System data to merge'),
      }),
      run: (a, ctx) => handleUpdateWorldItem(a, ctx.foundryClient),
    }),
    delete: action({
      description:
        'Delete a world item (id or name). Confirm with the user first; foundry_history_edit undo can re-create it. Copies on actors are separate and untouched.',
      schema: z.object({ item: z.string().describe('World item id or name') }),
      run: (a, ctx) => handleDeleteWorldItem(a, ctx.foundryClient),
    }),
    use: action({
      description:
        'Post a card for an item an actor owns, with a link its owner clicks to use it (attack, damage, save, ...) in chat. activity picks one activity by name. Nothing is rolled or spent here.',
      schema: z.object({
        actor: z.string().describe("Actor id, name or a player's name"),
        item: z.string().describe('Item id or name on that actor'),
        activity: z.string().optional().describe('Name of one activity of the item'),
        prompt: z.string().optional().describe('Sentence shown above the card'),
        whisper: z
          .array(z.string())
          .optional()
          .describe('Whisper to these users; omit for everyone'),
      }),
      run: (a, ctx) => handleUseItem(a, ctx.foundryClient),
    }),
    add_to_actor: action({
      description:
        'Create an item on an actor from an inline item document or a compendium entry. Replacing an item is not atomic: add the replacement first, then remove the old one.',
      schema: z.object({
        actorId: z.string().describe('Id of the actor to add the item to'),
        source: z
          .object({
            type: z.enum(['compendium', 'inline']).describe('Source kind'),
            compendiumId: z.string().optional().describe('Pack id (compendium source)'),
            itemId: z.string().optional().describe('Entry id within the pack (compendium source)'),
            item: z
              .record(z.string(), z.unknown())
              .optional()
              .describe('Inline item document with type, name and system (inline source)'),
          })
          .describe(
            'Item source: {type:"inline", item:{type,name,system}} or {type:"compendium", compendiumId, itemId}',
          ),
      }),
      run: (a, ctx) =>
        handleCreateActorItem(
          { actorId: a.actorId, source: a.source as ActorItemCreateSource },
          ctx.foundryClient,
        ),
    }),
    update_on_actor: action({
      description:
        "Apply a JSON merge patch to an owned item's system data: nested paths such as activities.{id}.consumption.targets work, values are absolute, arrays replace, null deletes.",
      schema: z.object({
        actorId: z.string().describe('Id of the owning actor'),
        itemId: z.string().describe('Id of the item on that actor (see foundry_actors items)'),
        patch: z.record(z.string(), z.unknown()).describe('JSON merge patch for item.system'),
      }),
      run: (a, ctx) => handleUpdateActorItem(a, ctx.foundryClient),
    }),
    remove_from_actor: action({
      description:
        'Delete an item from an actor. Confirm the exact target with the user first; the delete can be reverted with foundry_history_edit undo.',
      schema: z.object({
        actorId: z.string().describe('Id of the owning actor'),
        itemId: z.string().describe('Id of the item to delete'),
      }),
      run: (a, ctx) => handleDeleteActorItem(a, ctx.foundryClient),
    }),
  },
});
