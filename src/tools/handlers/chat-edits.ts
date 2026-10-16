/**
 * @fileoverview Chat writes: send messages, request rolls, post item cards, draw tables
 *
 * Messages are `ChatMessage` documents created through `modifyDocument`. Roll
 * requests and item cards are dnd5e inline enrichers (`[[/check ...]]`,
 * `[[/save ...]]`, `[[/skill ...]]`, `[[/item ...]]`) in the message HTML: Foundry
 * renders them as clickable roll links that any player with a suitable actor can
 * press, no companion module needed. Syntax checked against `enrichString` and
 * `parseCheckConfig` / `parseSaveConfig` in dnd5e 6.0.5.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { WorldData } from '../../foundry/types.js';
import { resolveActor } from './character.js';
import { isRec, num, type Rec, str } from './dnd5e.js';
import { resolveByRef, snapshotOf } from './refs.js';
import { markdownToHtml } from './session-notes.js';
import { withToolError } from './utils.js';
import { rollFormula, rowText } from './world-browse.js';

/** CONST.CHAT_MESSAGE_STYLES */
const STYLES = { other: 0, ooc: 1, ic: 2, emote: 3 } as const;
export type ChatStyle = keyof typeof STYLES;

export type ContentFormat = 'html' | 'markdown' | 'text';

function text(t: string) {
  return { content: [{ type: 'text', text: t }] };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Message HTML from caller content. `text` (default) is escaped; enrichers survive escaping. */
function toHtml(content: string, format: ContentFormat | undefined): string {
  if (format === 'html') {
    return content;
  }
  if (format === 'markdown') {
    return markdownToHtml(content);
  }
  return `<p>${escapeHtml(content).replace(/\n/g, '<br>')}</p>`;
}

function whisperIds(snapshot: WorldData, refs: string[] | undefined): string[] | undefined {
  if (!refs || refs.length === 0) {
    return undefined;
  }
  return refs.map((ref) => {
    const lower = ref.toLowerCase();
    const user = snapshot.users.find((u) => u._id === ref || u.name.toLowerCase() === lower);
    if (!user) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No user matches "${ref}". Users: ${snapshot.users.map((u) => u.name).join(', ')}`,
      );
    }
    return user._id;
  });
}

interface MessageOptions {
  speaker?: string | undefined;
  alias?: string | undefined;
  whisper?: string[] | undefined;
  style?: ChatStyle | undefined;
  flavor?: string | undefined;
}

function buildMessage(
  foundryClient: FoundryClient,
  content: string,
  options: MessageOptions,
): { data: Rec; who: string } {
  const snapshot = snapshotOf(foundryClient);
  // The socket does not fill in the author for us; the message is rejected without one.
  const author = foundryClient.getUserId();
  if (!author) {
    throw new McpError(
      ErrorCode.InternalError,
      'Not logged in to Foundry yet - try again in a moment',
    );
  }
  const data: Rec = { content, author };
  let who = options.alias ?? 'Game Master';
  if (options.speaker) {
    const actor = resolveActor(foundryClient, options.speaker);
    data.speaker = { actor: actor._id, alias: options.alias ?? actor.name };
    data.style = STYLES.ic;
    who = options.alias ?? actor.name;
  } else {
    data.speaker = { alias: who };
  }
  if (options.style) {
    data.style = STYLES[options.style];
  }
  if (options.flavor !== undefined) {
    data.flavor = options.flavor;
  }
  const whisper = whisperIds(snapshot, options.whisper);
  if (whisper) {
    data.whisper = whisper;
  }
  return { data, who };
}

async function post(foundryClient: FoundryClient, data: Rec): Promise<string> {
  const [created] = await foundryClient.createDocuments('ChatMessage', [data]);
  return str(created?._id);
}

function audience(options: MessageOptions): string {
  return options.whisper?.length
    ? `whispered to ${options.whisper.join(', ')}`
    : 'visible to everyone';
}

// ---------------------------------------------------------------------------

export async function handleSendChat(
  args: { content: string; format?: ContentFormat } & MessageOptions,
  foundryClient: FoundryClient,
) {
  return withToolError('send chat message', async () => {
    const { data, who } = buildMessage(foundryClient, toHtml(args.content, args.format), args);
    const id = await post(foundryClient, data);
    return text(`💬 **Message Sent** as ${who}, ${audience(args)}\n**ID:** ${id}`);
  });
}

// --- request_roll -----------------------------------------------------------

export type RollKind = 'check' | 'skill' | 'save' | 'tool' | 'concentration';

const TOKEN = /^[a-z0-9][a-z0-9 '-]*$/i;

/** "Sleight of Hand" → "sleight-of-hand" (the enricher slugifies names). */
function slug(value: string, what: string): string {
  const v = value.trim();
  if (!TOKEN.test(v)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${what} "${value}" must be a plain name like "perception" or "dex"`,
    );
  }
  return v.toLowerCase().replace(/['\s]+/g, '-');
}

function joined(values: string[] | undefined, what: string): string {
  return (values ?? []).map((v) => slug(v, what)).join('/');
}

/** Builds the dnd5e enricher for a roll request. Exported for tests. */
export function buildRollEnricher(args: {
  kind: RollKind;
  ability?: string[] | undefined;
  skill?: string[] | undefined;
  tool?: string[] | undefined;
  dc?: number | undefined;
}): string {
  const parts: string[] = [];
  const ability = joined(args.ability, 'ability');
  const skill = joined(args.skill, 'skill');
  const tool = joined(args.tool, 'tool');
  switch (args.kind) {
    case 'check':
      if (!ability && !skill && !tool) {
        throw new McpError(ErrorCode.InvalidParams, 'A check needs ability, skill or tool');
      }
      if (ability) {
        parts.push(`ability=${ability}`);
      }
      if (skill) {
        parts.push(`skill=${skill}`);
      }
      if (tool) {
        parts.push(`tool=${tool}`);
      }
      break;
    case 'skill':
      if (!skill) {
        throw new McpError(ErrorCode.InvalidParams, 'A skill roll needs skill');
      }
      parts.push(`skill=${skill}`);
      if (ability) {
        parts.push(`ability=${ability}`);
      }
      break;
    case 'tool':
      if (!tool) {
        throw new McpError(ErrorCode.InvalidParams, 'A tool roll needs tool');
      }
      parts.push(`tool=${tool}`);
      if (ability) {
        parts.push(`ability=${ability}`);
      }
      break;
    case 'save':
      if (!ability) {
        throw new McpError(ErrorCode.InvalidParams, 'A saving throw needs ability');
      }
      parts.push(`ability=${ability}`);
      break;
    case 'concentration':
      break;
  }
  if (args.dc !== undefined) {
    if (!Number.isFinite(args.dc)) {
      throw new McpError(ErrorCode.InvalidParams, 'dc must be a number');
    }
    parts.push(`dc=${args.dc}`);
  }
  return `[[/${args.kind}${parts.length ? ` ${parts.join(' ')}` : ''}]]`;
}

export async function handleRequestRoll(
  args: {
    kind: RollKind;
    ability?: string[];
    skill?: string[];
    tool?: string[];
    dc?: number;
    prompt?: string;
  } & MessageOptions,
  foundryClient: FoundryClient,
) {
  return withToolError('request roll', async () => {
    const enricher = buildRollEnricher(args);
    const html = `${args.prompt ? `<p>${escapeHtml(args.prompt)}</p>` : ''}<p>${enricher}</p>`;
    const { data } = buildMessage(foundryClient, html, args);
    const id = await post(foundryClient, data);
    return text(
      `🎯 **Roll Requested** ${enricher}, ${audience(args)}\nPlayers click the link in chat to roll with their own character.\n**ID:** ${id}`,
    );
  });
}

// --- use item ---------------------------------------------------------------

export async function handleUseItem(
  args: { actor: string; item: string; activity?: string; prompt?: string } & MessageOptions,
  foundryClient: FoundryClient,
) {
  return withToolError('post item card', async () => {
    const actor = resolveActor(foundryClient, args.actor);
    const items = (Array.isArray(actor.items) ? actor.items : []) as unknown as Rec[];
    const item = resolveByRef(items, args.item, `item on ${actor.name}`, 'foundry_actors items');
    const activity = args.activity?.trim();
    if (activity && /["\]]/.test(activity)) {
      throw new McpError(ErrorCode.InvalidParams, 'activity must not contain quotes or ]');
    }
    const uuid = `Actor.${actor._id}.Item.${str(item._id)}`;
    const enricher = `[[/item ${uuid}${activity ? ` activity="${activity}"` : ''}]]`;
    const html = `${args.prompt ? `<p>${escapeHtml(args.prompt)}</p>` : ''}<p>${enricher}</p>`;
    const { data } = buildMessage(foundryClient, html, {
      ...args,
      speaker: args.speaker ?? actor._id,
    });
    const id = await post(foundryClient, data);
    return text(
      `🎴 **Item Card Posted** ${str(item.name)}${activity ? ` (${activity})` : ''} for ${actor.name}\nThe owner clicks the link in chat to use it.\n**ID:** ${id}`,
    );
  });
}

// --- draw table -------------------------------------------------------------

export async function handleDrawTable(
  args: { table: string } & MessageOptions,
  foundryClient: FoundryClient,
) {
  return withToolError('draw from table', async () => {
    const snapshot = snapshotOf(foundryClient);
    const table = resolveByRef(
      snapshot.tables as Rec[],
      args.table,
      'world roll table',
      'foundry_world browse kind="tables"',
    );
    const results = (Array.isArray(table.results) ? table.results : []).filter(isRec);
    const rolled = rollFormula(str(table.formula));
    if (!rolled) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Cannot roll "${str(table.formula)}" locally; use a table with a plain dice formula like 1d20`,
      );
    }
    const hit = results.find(
      (r) =>
        Array.isArray(r.range) &&
        rolled.total >= num(r.range[0]) &&
        rolled.total <= num(r.range[1]),
    );
    if (!hit) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Rolled ${rolled.total} on "${str(table.name)}" but no row covers it; check the table's ranges`,
      );
    }
    const html = `<h3>${escapeHtml(str(table.name))}</h3><p><strong>${escapeHtml(rolled.detail)} → ${rolled.total}</strong></p><p>${escapeHtml(rowText(hit))}</p>`;
    const { data } = buildMessage(foundryClient, html, args);
    const id = await post(foundryClient, data);
    return text(
      `🎲 **Drew from ${str(table.name)}**: ${rolled.detail} → **${rolled.total}**: ${rowText(hit)}\nPosted to chat, ${audience(args)}.\n**ID:** ${id}`,
    );
  });
}
