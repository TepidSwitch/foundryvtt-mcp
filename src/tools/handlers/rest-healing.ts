/**
 * @fileoverview Rests and healing: dnd5e rest request cards, heal, damage, temp HP
 *
 * Rest requests are `ChatMessage` documents of type `request` whose `system`
 * matches dnd5e 6.0.5 `RequestMessageData` (the card the Group actor posts in
 * `rest()`); players press the button to rest their own character.
 *
 * HP changes write `system.attributes.hp.{value,temp}` through
 * `updateActorAttribute` (world and linked actors) or `updateTokenActorAttribute`
 * (unlinked tokens, stored on the ActorDelta), so the usual validation applies.
 * Damage `type` is informational only: resistances/vulnerabilities are NOT applied.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { type FoundryClient, mergeRecords } from '../../foundry/client.js';
import type { WorldActor } from '../../foundry/types.js';
import { resolveActor } from './character.js';
import { isRec, str } from './dnd5e.js';
import { buildEffectiveSheet } from './effects.js';
import { snapshotOf } from './refs.js';
import { withToolError } from './utils.js';

function text(t: string) {
  return { content: [{ type: 'text', text: t }] };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function postChat(
  foundryClient: FoundryClient,
  data: Record<string, unknown>,
): Promise<string> {
  const author = foundryClient.getUserId();
  if (!author) {
    throw new McpError(
      ErrorCode.InternalError,
      'Not logged in to Foundry yet - try again in a moment',
    );
  }
  const [created] = await foundryClient.createDocuments('ChatMessage', [{ ...data, author }]);
  return str(created?._id);
}

// --- request_rest -------------------------------------------------------------

/** CONFIG.DND5E.restTypes (dnd5e 6.0.5): icon, English label, normal-variant minutes, newDay default. */
const REST_TYPES = {
  short: { icon: 'fa-solid fa-utensils', label: 'Short Rest', minutes: 60, newDay: false },
  long: { icon: 'fa-solid fa-campground', label: 'Long Rest', minutes: 480, newDay: true },
} as const;
export type RestType = keyof typeof REST_TYPES;

function formatDuration(minutes: number): string {
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return `${h} ${h === 1 ? 'hour' : 'hours'}`;
  }
  return `${minutes} minutes`;
}

export async function handleRequestRest(
  args: { type: RestType; actors?: string[] | undefined; new_day?: boolean | undefined },
  foundryClient: FoundryClient,
) {
  const config = REST_TYPES[args.type];
  if (!config) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `type must be one of: ${Object.keys(REST_TYPES).join(', ')}`,
    );
  }
  return withToolError('request rest', async () => {
    const snapshot = snapshotOf(foundryClient);
    let targets: WorldActor[];
    if (args.actors && args.actors.length > 0) {
      targets = args.actors.map((ref) => resolveActor(foundryClient, ref));
    } else {
      targets = snapshot.users
        .filter((u) => u.character)
        .map((u) => snapshot.actors.find((a) => a._id === u.character))
        .filter((a): a is WorldActor => a !== undefined);
    }
    targets = targets.filter((a, i) => targets.findIndex((b) => b._id === a._id) === i);
    if (targets.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'No actors to rest: nobody in the party has an assigned character. Pass actors.',
      );
    }

    const newDay = args.new_day ?? config.newDay;
    const parts = [formatDuration(config.minutes)];
    if (newDay) {
      parts.push('new day');
    }
    const flavor = `${config.label} (${parts.join(', ')})`;
    const id = await postChat(foundryClient, {
      type: 'request',
      flavor,
      speaker: { alias: 'Game Master' },
      system: {
        button: { icon: config.icon, label: config.label },
        data: {
          newDay,
          recoverTemp: args.type === 'long',
          recoverTempMax: args.type === 'long',
          type: args.type,
        },
        handler: 'rest',
        targets: targets.map((t) => ({ actor: `Actor.${t._id}` })),
      },
    });
    return text(
      `🏕️ **${config.label} requested** (${flavor})\n**Message ID:** ${id}\n**For:** ${targets.map((t) => `${t.name} (${t._id})`).join(', ')}\nEach player presses the button on the card to rest their character.`,
    );
  });
}

// --- hit points ---------------------------------------------------------------

interface Subject {
  name: string;
  /** World actor id (linked tokens and plain actors write here). */
  actorId: string;
  /** Set only for an unlinked token: writes go to its ActorDelta. */
  token?: { sceneId: string; tokenId: string };
  /** Base actor with the token delta merged in. */
  actor: WorldActor;
}

/** Resolves a token id first, then an actor id/name/player name. */
function resolveSubject(foundryClient: FoundryClient, ref: string, sceneId?: string): Subject {
  const located = foundryClient.findToken(ref.trim(), sceneId);
  if (located) {
    const token = located.token;
    const actorId = str(token.actorId);
    const base = foundryClient.getRawActor(actorId);
    if (!base) {
      throw new McpError(ErrorCode.InvalidRequest, `Token ${ref} has no actor in the world`);
    }
    const name = str(token.name, base.name);
    if (token.actorLink === true) {
      return { name, actorId, actor: base };
    }
    const delta = isRec(token.delta) && isRec(token.delta.system) ? token.delta.system : {};
    return {
      name,
      actorId,
      token: { sceneId: located.scene._id, tokenId: str(token._id) },
      actor: { ...base, system: mergeRecords(base.system, delta) },
    };
  }
  const actor = resolveActor(foundryClient, ref);
  return { name: actor.name, actorId: actor._id, actor };
}

interface HpState {
  value: number;
  temp: number;
  max: number;
}

function hpOf(actor: WorldActor): HpState {
  const sheet = buildEffectiveSheet(actor);
  if (sheet.hp.max === null) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `${actor.name} has no determinable max HP; use foundry_actors_edit update with explicit values`,
    );
  }
  return { value: sheet.hp.value, temp: sheet.hp.temp, max: sheet.hp.max };
}

function checkAmount(amount: unknown, allowZero: boolean): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < (allowZero ? 0 : 1)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `amount must be a whole number >= ${allowZero ? 0 : 1}`,
    );
  }
  return Math.floor(amount);
}

const fmt = (h: HpState) => `${h.value}/${h.max}${h.temp ? ` (+${h.temp} temp)` : ''}`;

async function writeHp(foundryClient: FoundryClient, subject: Subject, after: HpState, b: HpState) {
  const patch: Record<string, number> = {};
  if (after.value !== b.value) {
    patch['attributes.hp.value'] = after.value;
  }
  if (after.temp !== b.temp) {
    patch['attributes.hp.temp'] = after.temp;
  }
  if (Object.keys(patch).length === 0) {
    return false;
  }
  if (subject.token) {
    await foundryClient.updateTokenActorAttribute(
      subject.token.sceneId,
      subject.token.tokenId,
      patch,
    );
  } else {
    await foundryClient.updateActorAttribute(subject.actorId, patch);
  }
  return true;
}

function ids(subject: Subject): string {
  return subject.token
    ? `token \`${subject.token.tokenId}\` on scene \`${subject.token.sceneId}\` (unlinked; base actor \`${subject.actorId}\`)`
    : `actor \`${subject.actorId}\``;
}

async function announceLine(foundryClient: FoundryClient, line: string): Promise<string> {
  const id = await postChat(foundryClient, {
    content: `<p>${escapeHtml(line)}</p>`,
    speaker: { alias: 'Game Master' },
    style: 0,
  });
  return `\n**Announced** in chat (message \`${id}\`)`;
}

export async function handleHeal(
  args: { target: string; amount: number; sceneId?: string; announce?: boolean },
  foundryClient: FoundryClient,
) {
  const amount = checkAmount(args.amount, false);
  return withToolError('heal', async () => {
    const subject = resolveSubject(foundryClient, args.target, args.sceneId);
    const before = hpOf(subject.actor);
    const after = { ...before, value: Math.min(before.max, before.value + amount) };
    const wrote = await writeHp(foundryClient, subject, after, before);
    const note = wrote ? '' : ' (already at max, nothing written)';
    let out = `💚 **${subject.name} healed ${after.value - before.value}** (requested ${amount})\n**HP:** ${fmt(before)} → ${fmt(after)}${note}\n**Document:** ${ids(subject)}`;
    if (args.announce) {
      out += await announceLine(
        foundryClient,
        `${subject.name} regains ${after.value - before.value} HP (${after.value}/${after.max}).`,
      );
    }
    return text(out);
  });
}

export async function handleDamage(
  args: { target: string; amount: number; type?: string; sceneId?: string; announce?: boolean },
  foundryClient: FoundryClient,
) {
  const amount = checkAmount(args.amount, false);
  return withToolError('damage', async () => {
    const subject = resolveSubject(foundryClient, args.target, args.sceneId);
    const before = hpOf(subject.actor);
    const absorbed = Math.min(before.temp, amount);
    const after = {
      ...before,
      temp: before.temp - absorbed,
      value: Math.max(0, before.value - (amount - absorbed)),
    };
    await writeHp(foundryClient, subject, after, before);
    const kind = args.type ? ` ${args.type}` : '';
    let out = `🩸 **${subject.name} takes ${amount}${kind} damage**${absorbed > 0 ? ` (${absorbed} absorbed by temp HP)` : ''}\n**HP:** ${fmt(before)} → ${fmt(after)}${after.value === 0 ? ' · **down (0 HP)**' : ''}\n**Document:** ${ids(subject)}\n_Raw amount applied: resistances, vulnerabilities and immunities are not calculated._`;
    if (args.announce) {
      out += await announceLine(
        foundryClient,
        `${subject.name} takes ${amount}${kind} damage (${after.value}/${after.max}${after.temp ? `, +${after.temp} temp` : ''}).`,
      );
    }
    return text(out);
  });
}

export async function handleSetTempHp(
  args: { target: string; amount: number; force?: boolean; sceneId?: string },
  foundryClient: FoundryClient,
) {
  const amount = checkAmount(args.amount, true);
  return withToolError('set temp HP', async () => {
    const subject = resolveSubject(foundryClient, args.target, args.sceneId);
    const before = hpOf(subject.actor);
    const next = args.force ? amount : Math.max(before.temp, amount);
    const after = { ...before, temp: next };
    const wrote = await writeHp(foundryClient, subject, after, before);
    const note = wrote
      ? ''
      : ` (kept: temp HP do not stack, the higher value stays; pass force to replace)`;
    return text(
      `🛡️ **${subject.name} temp HP**\n**HP:** ${fmt(before)} → ${fmt(after)}${note}\n**Document:** ${ids(subject)}`,
    );
  });
}
