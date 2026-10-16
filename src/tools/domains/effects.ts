/**
 * @fileoverview Effect tools: foundry_effects_edit (write)
 */

import { z } from 'zod';
import { action, DomainTool } from '../domain.js';
import {
  handleCreateEffect,
  handleDeleteEffect,
  handleListEffects,
  handleUpdateEffect,
} from '../handlers/effect-mutations.js';
import { handleApplyStatusEffect } from '../handlers/token-mutations.js';

const where = {
  actor: z
    .string()
    .optional()
    .describe('Actor id, name or player name; with item, the actor that owns the item'),
  item: z
    .string()
    .optional()
    .describe('Item id or name: an item on actor, or (without actor) a world item'),
};

const change = z.object({
  key: z.string().describe('Data path the change targets, e.g. "system.attributes.ac.bonus"'),
  type: z
    .string()
    .optional()
    .describe(
      'How to apply it: add (default), subtract, multiply, override, upgrade, downgrade, custom, or a system type',
    ),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).describe('Value to apply'),
  phase: z.string().optional().describe('initial (default) or final'),
  priority: z.number().optional().describe('Order within the phase (default from the type)'),
});

const fields = {
  img: z.string().optional().describe('Icon path'),
  description: z.string().optional().describe('Description (HTML)'),
  changes: z
    .array(change)
    .optional()
    .describe('Changes the effect makes. On update this replaces the whole list.'),
  disabled: z.boolean().optional().describe('Suspend the effect without deleting it'),
  duration: z
    .object({
      value: z.number().nullable().optional().describe('How long; null for none'),
      units: z
        .enum(['seconds', 'minutes', 'hours', 'days', 'months', 'years', 'rounds', 'turns'])
        .optional()
        .describe('Unit of value'),
      expiry: z
        .enum(['combatStart', 'roundStart', 'turnStart', 'combatEnd', 'roundEnd', 'turnEnd'])
        .nullable()
        .optional()
        .describe('When a round/turn duration is counted down'),
    })
    .optional()
    .describe('Duration'),
  statuses: z.array(z.string()).optional().describe('Status ids this effect represents'),
  tint: z.string().optional().describe('Icon tint colour, e.g. "#ff0000"'),
  transfer: z
    .boolean()
    .optional()
    .describe('Item effects only: apply to the owning actor while equipped'),
  origin: z.string().optional().describe('UUID of what created the effect'),
};

export const effectsEditTool = new DomainTool({
  name: 'foundry_effects_edit',
  title: 'Edit status effects',
  toolset: 'effects',
  write: true,
  destructive: true,
  description:
    "WRITE: apply or clear status conditions, and create, change or delete active effects on actors and items, in the live world (v14 shape: changes live in system.changes with string types). Needs FOUNDRY_WRITE_ENABLED=true and a GM login; writes are logged and revertible with foundry_history_edit. Read an actor's effects with the list action.",
  actions: {
    list: action({
      description:
        'List effects on an actor, on an item the actor owns, or on a world item, with ids, changes and statuses.',
      schema: z.object(where),
      run: (a, ctx) => handleListEffects(a, ctx.foundryClient),
    }),
    create: action({
      description:
        'Create an effect on an actor, an owned item or a world item. Item effects with transfer=true apply to the actor that owns the item.',
      schema: z.object({ ...where, name: z.string().describe('Effect name'), ...fields }),
      run: (a, ctx) => handleCreateEffect(a, ctx.foundryClient),
    }),
    update: action({
      description:
        'Change an effect (id or name) on an actor or item. Only the fields you give change; changes replaces the whole list.',
      schema: z.object({
        ...where,
        effect: z.string().describe('Effect id or name'),
        name: z.string().optional().describe('New name'),
        ...fields,
      }),
      run: (a, ctx) => handleUpdateEffect(a, ctx.foundryClient),
    }),
    delete: action({
      description:
        'Delete an effect (id or name). Confirm with the user first; foundry_history_edit undo can re-create it.',
      schema: z.object({ ...where, effect: z.string().describe('Effect id or name') }),
      run: (a, ctx) => handleDeleteEffect(a, ctx.foundryClient),
    }),
    remove_status: action({
      description:
        "Remove a status condition from a token's actor; same as apply_status with active=false. Removing an absent status is a no-op.",
      schema: z.object({
        tokenId: z.string().describe('Id of the token'),
        statusId: z.string().describe('Status id, e.g. "prone"'),
        sceneId: z.string().optional().describe('Scene to look in (default: search all scenes)'),
      }),
      run: (a, ctx) => handleApplyStatusEffect({ ...a, active: false }, ctx.foundryClient),
    }),
    apply_status: action({
      description:
        'Apply or remove a status condition (e.g. "prone", "stunned") on a token\'s actor; active=false removes it. Matches by status id, so re-applying or clearing an absent status is a no-op that reports success without writing. For HP or exhaustion use foundry_actors_edit update.',
      schema: z.object({
        tokenId: z.string().describe('Id of the token'),
        statusId: z.string().describe('Status id, e.g. "prone"'),
        active: z.boolean().optional().describe('true applies (default), false removes'),
        sceneId: z.string().optional().describe('Scene to look in (default: search all scenes)'),
      }),
      run: (a, ctx) => handleApplyStatusEffect(a, ctx.foundryClient),
    }),
  },
});
