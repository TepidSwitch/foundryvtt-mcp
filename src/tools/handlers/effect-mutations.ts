/**
 * @fileoverview ActiveEffect create / update / delete on actors and items
 *
 * Foundry v14 shape: an effect's changes live in `system.changes[]` and each
 * change has a STRING type (custom, multiply, add, subtract, downgrade, upgrade,
 * override, or a system/module type), a `phase` (initial, final) and an
 * optional priority. The old numeric `mode` is gone. Effect arrays replace on
 * update, so `changes` is always sent whole.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import { resolveActor } from './character.js';
import { isRec, type Rec, str } from './dnd5e.js';
import { resolveByRef, snapshotOf } from './refs.js';
import { withToolError } from './utils.js';

export interface EffectChange {
  key: string;
  type?: string;
  value: string | number | boolean | null;
  phase?: string;
  priority?: number;
}

export interface EffectFields {
  name?: string;
  img?: string;
  description?: string;
  changes?: EffectChange[];
  disabled?: boolean;
  duration?: { value?: number | null; units?: string; expiry?: string | null };
  statuses?: string[];
  tint?: string;
  transfer?: boolean;
  origin?: string;
}

interface Target {
  parentUuid: string;
  label: string;
  effects: Rec[];
}

/** Where an effect lives: an actor, an item owned by an actor, or a world item. */
function resolveTarget(
  foundryClient: FoundryClient,
  args: { actor?: string | undefined; item?: string | undefined },
): Target {
  if (args.actor) {
    const actor = resolveActor(foundryClient, args.actor);
    if (!args.item) {
      return {
        parentUuid: `Actor.${actor._id}`,
        label: `actor ${actor.name}`,
        effects: effectsOf(actor as unknown as Rec),
      };
    }
    const items = (Array.isArray(actor.items) ? actor.items : []) as unknown as Rec[];
    const item = resolveByRef(items, args.item, `item on ${actor.name}`, 'foundry_actors items');
    return {
      parentUuid: `Actor.${actor._id}.Item.${str(item._id)}`,
      label: `item ${str(item.name)} on ${actor.name}`,
      effects: effectsOf(item),
    };
  }
  if (args.item) {
    const snapshot = snapshotOf(foundryClient);
    const item = resolveByRef(
      snapshot.items as unknown as Rec[],
      args.item,
      'world item',
      'foundry_items search',
    );
    return {
      parentUuid: `Item.${str(item._id)}`,
      label: `world item ${str(item.name)}`,
      effects: effectsOf(item),
    };
  }
  throw new McpError(
    ErrorCode.InvalidParams,
    'Say where the effect is: actor (an actor, or the owner of item) or item (a world item)',
  );
}

function effectsOf(doc: Rec): Rec[] {
  return (Array.isArray(doc.effects) ? doc.effects : []).filter(isRec);
}

function changeSource(change: EffectChange): Rec {
  const out: Rec = { key: change.key, type: change.type ?? 'add', value: change.value };
  if (change.phase !== undefined) {
    out.phase = change.phase;
  }
  if (change.priority !== undefined) {
    out.priority = change.priority;
  }
  return out;
}

/** Update keys for the given fields (dot-notation, so duration merges). */
function fieldUpdates(fields: EffectFields): Rec {
  const out: Rec = {};
  for (const k of [
    'name',
    'img',
    'description',
    'disabled',
    'tint',
    'transfer',
    'origin',
  ] as const) {
    if (fields[k] !== undefined) {
      out[k] = fields[k];
    }
  }
  if (fields.statuses !== undefined) {
    out.statuses = fields.statuses;
  }
  if (fields.changes !== undefined) {
    out['system.changes'] = fields.changes.map(changeSource);
  }
  for (const k of ['value', 'units', 'expiry'] as const) {
    if (fields.duration?.[k] !== undefined) {
      out[`duration.${k}`] = fields.duration[k];
    }
  }
  return out;
}

function text(t: string) {
  return { content: [{ type: 'text', text: t }] };
}

function describeChanges(changes: EffectChange[] | undefined): string {
  if (!changes || changes.length === 0) {
    return 'no changes';
  }
  return changes.map((c) => `${c.key} ${c.type ?? 'add'} ${JSON.stringify(c.value)}`).join('; ');
}

export async function handleCreateEffect(
  args: { actor?: string; item?: string; name: string } & EffectFields,
  foundryClient: FoundryClient,
) {
  return withToolError('create effect', async () => {
    const target = resolveTarget(foundryClient, args);
    const data = fieldUpdates(args);
    delete data['system.changes'];
    if (args.changes !== undefined) {
      data.system = { changes: args.changes.map(changeSource) };
    }
    if (args.duration) {
      data.duration = Object.fromEntries(
        Object.entries(args.duration).filter(([, v]) => v !== undefined),
      );
    }
    for (const k of Object.keys(data)) {
      if (k.startsWith('duration.')) {
        delete data[k];
      }
    }
    const [created] = await foundryClient.createDocuments(
      'ActiveEffect',
      [data],
      target.parentUuid,
    );
    return text(
      `✨ **Effect Created** on ${target.label}\n**Name:** ${args.name}\n**ID:** ${str(created?._id)}\n**Changes:** ${describeChanges(args.changes)}`,
    );
  });
}

export async function handleUpdateEffect(
  args: { actor?: string; item?: string; effect: string } & EffectFields,
  foundryClient: FoundryClient,
) {
  return withToolError('update effect', async () => {
    const target = resolveTarget(foundryClient, args);
    const effect = resolveByRef(target.effects, args.effect, 'effect', 'foundry_actors get');
    const oldName = str(effect.name);
    const patch = fieldUpdates(args);
    if (Object.keys(patch).length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'Give at least one field to change');
    }
    await foundryClient.updateDocuments(
      'ActiveEffect',
      [{ _id: str(effect._id), ...patch }],
      target.parentUuid,
    );
    return text(
      `✏️ **Effect Updated** "${oldName}" on ${target.label}: ${Object.keys(patch).join(', ')}`,
    );
  });
}

export async function handleDeleteEffect(
  args: { actor?: string; item?: string; effect: string },
  foundryClient: FoundryClient,
) {
  return withToolError('delete effect', async () => {
    const target = resolveTarget(foundryClient, args);
    const effect = resolveByRef(target.effects, args.effect, 'effect', 'foundry_actors get');
    await foundryClient.deleteDocuments('ActiveEffect', [str(effect._id)], target.parentUuid);
    return text(
      `🗑️ **Effect Deleted** "${str(effect.name)}" from ${target.label}. Undo with foundry_history_edit undo.`,
    );
  });
}

export async function handleListEffects(
  args: { actor?: string; item?: string },
  foundryClient: FoundryClient,
) {
  return withToolError('list effects', async () => {
    const target = resolveTarget(foundryClient, args);
    if (target.effects.length === 0) {
      return text(`✨ No effects on ${target.label}.`);
    }
    const rows = target.effects.map((e) => {
      const changes = (isRec(e.system) && Array.isArray(e.system.changes) ? e.system.changes : [])
        .filter(isRec)
        .map((c) => `${str(c.key)} ${str(c.type)} ${JSON.stringify(c.value)}`)
        .join('; ');
      const statuses =
        Array.isArray(e.statuses) && e.statuses.length > 0
          ? ` · statuses ${e.statuses.join(', ')}`
          : '';
      return `- **${str(e.name)}** \`${str(e._id)}\`${e.disabled === true ? ' · disabled' : ''}${statuses}${changes ? ` — ${changes}` : ''}`;
    });
    return text(`✨ **Effects on ${target.label}** (${rows.length})\n${rows.join('\n')}`);
  });
}
