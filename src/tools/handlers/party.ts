/**
 * @fileoverview Party-wide read tools
 *
 * - find_in_party: which characters have a given spell, feature or item
 * - compare_party: rank characters by a stat (HP, AC, a skill, a save, spell DC, ...)
 *
 * Both work from the cached world snapshot and use effect-adjusted sheets.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { WorldActor, WorldData, WorldItem } from '../../foundry/types.js';
import {
  ABILITIES,
  type AbilityKey,
  at,
  itemSys,
  itemsOf,
  num,
  signed,
  spellPreparation,
  toNum,
} from './dnd5e.js';
import { buildEffectiveSheet, type EffectiveSheet } from './effects.js';
import { withToolError } from './utils.js';

function snapshotOf(foundryClient: FoundryClient): WorldData {
  const snapshot = foundryClient.getWorldSnapshot();
  if (!snapshot) {
    throw new McpError(ErrorCode.InternalError, 'Not connected — no world data available');
  }
  return snapshot;
}

interface Member {
  actor: WorldActor;
  player: string | null;
}

/** Player characters (assigned first); optionally unassigned characters or every actor. */
function membersOf(
  snapshot: WorldData,
  scope: 'party' | 'all',
  includeUnassigned: boolean,
): Member[] {
  const owners = new Map(
    snapshot.users.filter((u) => u.character).map((u) => [u.character, u.name]),
  );
  if (scope === 'all') {
    return snapshot.actors.map((actor) => ({ actor, player: owners.get(actor._id) ?? null }));
  }
  return snapshot.actors
    .filter((a) => a.type === 'character' && (includeUnassigned || owners.has(a._id)))
    .map((actor) => ({ actor, player: owners.get(actor._id) ?? null }))
    .sort((a, b) => Number(b.player !== null) - Number(a.player !== null));
}

const who = (m: Member): string => `**${m.actor.name}**${m.player ? ` (${m.player})` : ''}`;

// ---------------------------------------------------------------------------
// find_in_party
// ---------------------------------------------------------------------------

function brief(item: WorldItem): string {
  const sys = itemSys(item);
  if (item.type === 'spell') {
    const level = num(sys.level);
    return `${item.name} — ${level === 0 ? 'cantrip' : `level ${level} spell`}, ${spellPreparation(item).state}`;
  }
  const bits: string[] = [item.type];
  const qty = num(sys.quantity, 1);
  if (['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container'].includes(item.type)) {
    if (qty !== 1) {
      bits.push(`×${qty}`);
    }
    if (sys.equipped === true) {
      bits.push('equipped');
    }
    if (sys.attuned === true) {
      bits.push('attuned');
    }
  }
  const max = at(sys, 'uses', 'max');
  const maxNum = typeof max === 'number' ? max : Number(max);
  if (Number.isFinite(maxNum) && maxNum > 0) {
    bits.push(`${maxNum - num(at(sys, 'uses', 'spent'))}/${maxNum} uses`);
  }
  return `${item.name} — ${bits.join(', ')}`;
}

export async function handleFindInParty(
  args: { query?: string; type?: string; scope?: string; include_unassigned?: boolean },
  foundryClient: FoundryClient,
) {
  const { query, type, scope = 'party', include_unassigned = false } = args;
  if (!query || typeof query !== 'string') {
    throw new McpError(
      ErrorCode.InvalidParams,
      'query (an item, spell or feature name) is required',
    );
  }
  if (scope !== 'party' && scope !== 'all') {
    throw new McpError(ErrorCode.InvalidParams, 'scope must be "party" or "all"');
  }
  return withToolError('find in party', async () => {
    const snapshot = snapshotOf(foundryClient);
    const q = query.toLowerCase();
    const typeFilter = type?.toLowerCase();
    const members = membersOf(snapshot, scope, include_unassigned);

    const found: string[] = [];
    let holders = 0;
    for (const m of members) {
      const hits = itemsOf(m.actor).filter(
        (i) => i.name.toLowerCase().includes(q) && (!typeFilter || i.type === typeFilter),
      );
      if (hits.length > 0) {
        holders++;
        found.push(`${who(m)}\n${hits.map((i) => `  - ${brief(i)}`).join('\n')}`);
      }
    }
    const without = members.length - holders;
    return {
      content: [
        {
          type: 'text',
          text: `🔎 **"${query}"**${typeFilter ? ` (type ${typeFilter})` : ''} — ${holders} of ${members.length} ${scope === 'all' ? 'actors' : 'characters'} have it

${found.join('\n\n') || 'Nobody has a matching item.'}${holders > 0 && without > 0 && scope === 'party' ? `\n\n_${without} characters have no match._` : ''}`,
        },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// compare_party
// ---------------------------------------------------------------------------

interface StatReading {
  value: number;
  text: string;
  /** true when a lower value should sort first (e.g. HP percentage: most hurt first) */
  ascending?: boolean;
}

const STAT_HELP =
  'hp, ac, initiative, speed, level, proficiency, spell_dc, spell_attack, passive_perception, passive_investigation, passive_insight, ability:<str|dex|con|int|wis|cha>, save:<ability>, skill:<name> (e.g. skill:stealth)';

function abilityKey(s: string): AbilityKey | null {
  const k = s.toLowerCase().slice(0, 3);
  return (ABILITIES as readonly string[]).includes(k) ? (k as AbilityKey) : null;
}

export function readStat(sheet: EffectiveSheet, stat: string): StatReading | null {
  const s = stat.toLowerCase().trim();
  const passive = (key: string): StatReading => {
    const v = sheet.skills.find((x) => x.key === key)?.passive ?? 10;
    return { value: v, text: String(v) };
  };
  switch (s) {
    case 'hp': {
      const max = sheet.hp.max;
      const text = max === null ? `${sheet.hp.value}/?` : `${sheet.hp.value}/${max}`;
      return {
        value: max ? sheet.hp.value / max : sheet.hp.value,
        text: `${text}${max ? ` (${Math.round((sheet.hp.value / max) * 100)}%)` : ''}${sheet.hp.temp ? ` +${sheet.hp.temp} temp` : ''}`,
        ascending: true,
      };
    }
    case 'ac':
      return { value: sheet.ac.value ?? 0, text: `${sheet.ac.value ?? '?'} (${sheet.ac.detail})` };
    case 'initiative': {
      const bonus = Number(at(sheet.actor.system, 'attributes', 'init', 'bonus')) || 0;
      const v = sheet.mods.dex + bonus;
      return { value: v, text: signed(v) };
    }
    case 'speed': {
      const v = toNum(at(sheet.actor.system, 'attributes', 'movement', 'walk'));
      return { value: v, text: `${v} ft` };
    }
    case 'level':
      return { value: sheet.level, text: String(sheet.level) };
    case 'proficiency':
      return { value: sheet.prof, text: signed(sheet.prof) };
    case 'spell_dc':
      return sheet.spellcasting.dc === null
        ? null
        : { value: sheet.spellcasting.dc, text: String(sheet.spellcasting.dc) };
    case 'spell_attack':
      return sheet.spellcasting.attack === null
        ? null
        : { value: sheet.spellcasting.attack, text: signed(sheet.spellcasting.attack) };
    case 'passive_perception':
      return passive('prc');
    case 'passive_investigation':
      return passive('inv');
    case 'passive_insight':
      return passive('ins');
    default:
  }

  const [kind, rest] = s.split(':');
  if (!rest) {
    return null;
  }
  if (kind === 'ability') {
    const k = abilityKey(rest);
    return k
      ? { value: sheet.scores[k], text: `${sheet.scores[k]} (${signed(sheet.mods[k])})` }
      : null;
  }
  if (kind === 'save') {
    const k = abilityKey(rest);
    return k ? { value: sheet.saves[k].total, text: signed(sheet.saves[k].total) } : null;
  }
  if (kind === 'skill') {
    const skill = sheet.skills.find(
      (x) => x.key === rest || x.label.toLowerCase().includes(rest.replace(/[_-]/g, ' ')),
    );
    return skill
      ? {
          value: skill.total,
          text: `${signed(skill.total)}${skill.mult >= 2 ? ' (expertise)' : skill.mult > 0 ? ' (proficient)' : ''}`,
        }
      : null;
  }
  return null;
}

export async function handleCompareParty(
  args: { stat?: string; scope?: string; include_unassigned?: boolean },
  foundryClient: FoundryClient,
) {
  const { stat, scope = 'party', include_unassigned = false } = args;
  if (!stat || typeof stat !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, `stat is required. Options: ${STAT_HELP}`);
  }
  if (scope !== 'party' && scope !== 'all') {
    throw new McpError(ErrorCode.InvalidParams, 'scope must be "party" or "all"');
  }
  return withToolError('compare party', async () => {
    const snapshot = snapshotOf(foundryClient);
    const members = membersOf(snapshot, scope, include_unassigned);
    const rows = members
      .map((m) => ({ m, sheet: buildEffectiveSheet(m.actor) }))
      .map(({ m, sheet }) => ({ m, reading: readStat(sheet, stat) }));

    const valid = rows.filter((r) => r.reading !== null) as Array<{
      m: Member;
      reading: StatReading;
    }>;
    if (valid.length === 0 && rows.length > 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown or inapplicable stat "${stat}". Options: ${STAT_HELP}`,
      );
    }
    const ascending = valid[0]?.reading.ascending === true;
    valid.sort((a, b) =>
      ascending ? a.reading.value - b.reading.value : b.reading.value - a.reading.value,
    );
    const skipped = rows.length - valid.length;

    return {
      content: [
        {
          type: 'text',
          text: `📊 **${stat}** — ${ascending ? 'most hurt first' : 'highest first'}

${valid.map((r, i) => `${i + 1}. ${who(r.m)} — ${r.reading.text}`).join('\n')}${skipped > 0 ? `\n\n_${skipped} without this stat (e.g. non-casters for spell_dc)._` : ''}

_Effect-adjusted where numeric; dice/formula bonuses are not included._`,
        },
      ],
    };
  });
}
