/**
 * @fileoverview Character-focused read tools (dnd5e)
 *
 * - resolveActor: find an actor by id, name, or the name of the player who owns it
 * - handleGetActorItems: everything an actor carries (spells, features, gear) with item ids
 * - handleGetPartyOverview: one-screen summary of every player character
 * - formatSheet: computed character / NPC sheet used by get_actor_details
 *
 * All read-only and served from the cached world snapshot.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { WorldActor, WorldItem } from '../../foundry/types.js';
import {
  ABILITIES,
  type AbilityKey,
  at,
  buildSheet,
  classesOf,
  formatCr,
  htmlToText,
  isRec,
  itemSys,
  itemsOf,
  num,
  SCHOOLS,
  type Sheet,
  sensesOf,
  signed,
  spellPreparation,
  str,
  summarizeActivities,
  toNum,
  truncate,
} from './dnd5e.js';
import { buildEffectiveSheet, type EffectiveSheet, type EffectSummary } from './effects.js';
import { withToolError } from './utils.js';

const ID_PATTERN = /^[a-zA-Z0-9]{16}$/;

const SIZES: Record<string, string> = {
  tiny: 'Tiny',
  sm: 'Small',
  med: 'Medium',
  lg: 'Large',
  huge: 'Huge',
  grg: 'Gargantuan',
};

const CAVEAT =
  '_Computed from the raw world data. Bonuses from active effects, magic items and feats (e.g. Tough, racial senses) are not applied, and only equipped armor counts toward AC._';

// ---------------------------------------------------------------------------
// Actor lookup
// ---------------------------------------------------------------------------

/**
 * Resolves a reference to an actor. Accepts a 16-char id, an exact or partial
 * actor name, or the name of a player (returns that player's character).
 */
export function resolveActor(foundryClient: FoundryClient, ref: string): WorldActor {
  const snapshot = foundryClient.getWorldSnapshot();
  if (!snapshot) {
    throw new McpError(ErrorCode.InternalError, 'Not connected — no world data available');
  }
  const query = ref.trim();
  if (!query) {
    throw new McpError(ErrorCode.InvalidParams, 'An actor id or name is required');
  }
  const actors = snapshot.actors;
  if (ID_PATTERN.test(query)) {
    const byId = actors.find((a) => a._id === query);
    if (byId) {
      return byId;
    }
  }
  const lower = query.toLowerCase();

  const user = snapshot.users.find((u) => u.name.toLowerCase() === lower);
  if (user?.character) {
    const owned = actors.find((a) => a._id === user.character);
    if (owned) {
      return owned;
    }
  }

  const describe = (list: WorldActor[]) =>
    list
      .slice(0, 8)
      .map((a) => `${a.name} (${a.type}, ${a._id})`)
      .join('; ');

  const exact = actors.filter((a) => a.name.toLowerCase() === lower);
  if (exact.length === 1 && exact[0]) {
    return exact[0];
  }
  if (exact.length > 1) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `"${ref}" matches ${exact.length} actors — use an id: ${describe(exact)}`,
    );
  }

  const partial = actors.filter((a) => a.name.toLowerCase().includes(lower));
  if (partial.length === 1 && partial[0]) {
    return partial[0];
  }
  const characters = partial.filter((a) => a.type === 'character');
  if (characters.length === 1 && characters[0]) {
    return characters[0];
  }
  if (partial.length > 1) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `"${ref}" matches ${partial.length} actors — be more specific or use an id: ${describe(partial)}`,
    );
  }
  throw new McpError(
    ErrorCode.InvalidParams,
    `No actor, or player with a character, matches "${ref}". Try foundry_actors search.`,
  );
}

function ownerNameOf(foundryClient: FoundryClient, actor: WorldActor): string | null {
  const users = foundryClient.getWorldSnapshot()?.users ?? [];
  const owner = users.find((u) => u.character === actor._id);
  return owner ? owner.name : null;
}

function caveatFor(fx: EffectSummary | null): string {
  if (!fx) {
    return CAVEAT;
  }
  return `_Computed from the raw world data with numeric active-effect changes applied. Dice and formula bonuses (Bless, Bardic Inspiration, "+1d4"), roll modifiers, and bonuses that are not effects (e.g. Tough) are not included, and only equipped armor counts toward AC.${fx.unresolved > 0 ? ` ${fx.unresolved} effect changes could not be evaluated.` : ''}_`;
}

// ---------------------------------------------------------------------------
// Sheet formatting
// ---------------------------------------------------------------------------

function listTrait(actor: WorldActor, key: string): string {
  const t = at(actor.system, 'traits', key);
  const value = at(t, 'value');
  const custom = str(at(t, 'custom'));
  const parts = Array.isArray(value) ? value.map(String) : [];
  if (custom) {
    parts.push(custom);
  }
  return parts.join(', ');
}

function itemNameOf(actor: WorldActor, type: string): string {
  return itemsOf(actor).find((i) => i.type === type)?.name ?? '';
}

export function formatSheet(
  actor: WorldActor,
  sheet: Sheet,
  playerName: string | null,
  opts: { compendium?: boolean } = {},
): string {
  const sys = actor.system;
  const isNpc = actor.type === 'npc';
  const lines: string[] = [];

  if (isNpc) {
    const typeVal = str(at(sys, 'details', 'type', 'value'));
    const size = SIZES[str(at(sys, 'traits', 'size'))] ?? '';
    lines.push(`🎭 **${actor.name}** (NPC) — \`${actor._id}\``);
    lines.push(
      `${[size, typeVal, str(at(sys, 'details', 'alignment'))].filter(Boolean).join(' ')} · CR ${formatCr(sheet.cr)}`,
    );
  } else {
    const cls = sheet.classes
      .map((c) => `${c.name} ${c.levels}${c.subclass ? ` (${c.subclass})` : ''}`)
      .join(' / ');
    lines.push(
      `🎭 **${actor.name}** — ${cls || 'no class'} (level ${sheet.level})${playerName ? ` — played by ${playerName}` : ''}`,
    );
    lines.push(`id \`${actor._id}\``);
    const bits = [
      itemNameOf(actor, 'race'),
      itemNameOf(actor, 'background'),
      str(at(sys, 'details', 'alignment')),
    ].filter(Boolean);
    if (bits.length > 0) {
      lines.push(bits.join(' · '));
    }
  }

  // Core stats
  const hp = sheet.hp;
  const hpText =
    hp.max === null
      ? `${hp.value}/?`
      : `${hp.value}/${hp.max}${hp.source === 'computed' ? '*' : ''}`;
  const speed = at(sys, 'attributes', 'movement');
  const moves: string[] = [];
  if (isRec(speed)) {
    // walk first, then the other modes in stored order
    const entries = Object.entries(speed).sort(
      ([a], [b]) => Number(b === 'walk') - Number(a === 'walk'),
    );
    for (const [k, v] of entries) {
      const n = toNum(v);
      if (n > 0 && k !== 'units') {
        moves.push(k === 'walk' ? `${n} ft` : `${k} ${n} ft`);
      }
    }
  }
  const initBonus = Number(at(sys, 'attributes', 'init', 'bonus')) || 0;
  lines.push('');
  lines.push(
    `**HP** ${hpText}${hp.temp ? ` (+${hp.temp} temp)` : ''} · **AC** ${sheet.ac.value ?? '?'} (${sheet.ac.detail}) · **Init** ${signed(sheet.mods.dex + initBonus)} · **Speed** ${moves.join(', ') || '—'} · **Prof** ${signed(sheet.prof)}`,
  );

  const ab = ABILITIES.map((k: AbilityKey) => {
    const save = sheet.saves[k];
    return `${k.toUpperCase()} ${sheet.scores[k]} (${signed(sheet.mods[k])})${save.proficient ? ` save ${signed(save.total)}*` : ''}`;
  });
  lines.push(`**Abilities** ${ab.join(' · ')}`);

  const trained = sheet.skills
    .filter((s) => s.mult > 0)
    .map((s) => `${s.label} ${signed(s.total)}${s.mult >= 2 ? ' (expertise)' : ''}`);
  if (trained.length > 0) {
    lines.push(`**Skills** ${trained.join(', ')}`);
  }
  const passive = (key: string) => sheet.skills.find((s) => s.key === key)?.passive ?? 10;
  lines.push(
    `**Passive** Perception ${passive('prc')} · Investigation ${passive('inv')} · Insight ${passive('ins')}`,
  );

  const senses = sensesOf(actor).map((s) => `${s.name} ${s.range} ft`);
  const specialSenses = str(at(sys, 'attributes', 'senses', 'special'));
  if (specialSenses) {
    senses.push(specialSenses);
  }
  if (senses.length > 0) {
    lines.push(`**Senses** ${senses.join(', ')}`);
  }
  const languages = listTrait(actor, 'languages');
  if (languages) {
    lines.push(`**Languages** ${languages}`);
  }
  for (const [key, label] of [
    ['dr', 'Resistances'],
    ['di', 'Damage immunities'],
    ['dv', 'Vulnerabilities'],
    ['ci', 'Condition immunities'],
  ] as const) {
    const v = listTrait(actor, key);
    if (v) {
      lines.push(`**${label}** ${v}`);
    }
  }
  if (!isNpc) {
    const profs = [
      ['Weapons', listTrait(actor, 'weaponProf')],
      ['Armor', listTrait(actor, 'armorProf')],
      ['Tools', listTrait(actor, 'toolProf')],
    ]
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`);
    if (profs.length > 0) {
      lines.push(`**Proficiencies** ${profs.join(' · ')}`);
    }
  }

  // Spellcasting
  const sc = sheet.spellcasting;
  const spellCount = itemsOf(actor).filter((i) => i.type === 'spell').length;
  // NPCs default `attributes.spellcasting` to an ability even when they cast nothing.
  if (
    sc.ability &&
    (sc.slots.length > 0 || sc.pact || sc.casterLevel > 0 || (isNpc && spellCount > 0))
  ) {
    const slotText = sc.slots.map((s) => `L${s.level} ${s.value}/${s.max}`).join(' · ');
    lines.push('');
    lines.push(
      `**Spellcasting** ${sc.ability.toUpperCase()} · save DC ${sc.dc} · attack ${signed(sc.attack ?? 0)}${slotText ? ` · slots ${slotText}` : ''}${sc.pact ? ` · pact slots ${sc.pact.value}/${sc.pact.max} (level ${sc.pact.level})` : ''}`,
    );
    if (spellCount > 0 && !opts.compendium) {
      lines.push(`${spellCount} spells — use foundry_actors items with type "spell" for the list.`);
    }
  }

  // Hit dice, death saves, active effects
  if (!isNpc) {
    const dice = sheet.classes
      .filter((c) => c.hitDie > 0)
      .map((c) => `${Math.max(c.levels - c.hdSpent, 0)}/${c.levels} d${c.hitDie}`);
    if (dice.length > 0) {
      lines.push(`**Hit dice** ${dice.join(', ')}`);
    }
    if (hp.value === 0) {
      const death = at(sys, 'attributes', 'death');
      lines.push(
        `**Death saves** ${num(at(death, 'success'))} successes · ${num(at(death, 'failure'))} failures`,
      );
    }
  }
  const fx = 'effects' in sheet ? (sheet as EffectiveSheet).effects : null;
  if (fx) {
    if (fx.current.length > 0) {
      lines.push(`**Active effects** ${fx.current.map((e) => e.name).join(' · ')}`);
    }
    if (fx.applied.length > 0) {
      lines.push(`**Effect bonuses applied** ${fx.applied.join('; ')}`);
    }
  }

  // Resources / misc
  if (!isNpc) {
    const cur = at(sys, 'currency');
    if (isRec(cur)) {
      const money = ['pp', 'gp', 'ep', 'sp', 'cp']
        .filter((k) => num(cur[k]) > 0)
        .map((k) => `${num(cur[k])} ${k}`);
      lines.push(`**Currency** ${money.join(', ') || 'none'}`);
    }
    const exhaustion = num(at(sys, 'attributes', 'exhaustion'));
    const extras = [
      exhaustion > 0 ? `Exhaustion ${exhaustion}` : '',
      at(sys, 'attributes', 'inspiration') === true ? 'Inspiration' : '',
      `XP ${num(at(sys, 'details', 'xp', 'value'))}`,
    ].filter(Boolean);
    lines.push(extras.join(' · '));
  }
  if (!opts.compendium) {
    lines.push(
      `Items: ${itemsOf(actor).length} (use foundry_actors items for spells, features and gear).`,
    );
  }
  lines.push('');
  lines.push(
    caveatFor(fx) +
      (hp.source === 'computed' ? ' HP marked * is computed from class hit dice.' : ''),
  );
  return lines.join('\n');
}

export function sheetFor(foundryClient: FoundryClient, actor: WorldActor): string {
  const effective = buildEffectiveSheet(actor);
  return formatSheet(effective.actor, effective, ownerNameOf(foundryClient, actor));
}

/** One-line class/level or CR label used in search results. */
export function actorLabel(actor: WorldActor): string {
  if (actor.type === 'npc') {
    const sheet = buildSheet(actor);
    return `CR ${formatCr(sheet.cr)}`;
  }
  const classes = classesOf(actor);
  return classes.length > 0 ? classes.map((c) => `${c.name} ${c.levels}`).join('/') : 'no class';
}

// ---------------------------------------------------------------------------
// get_actor_items
// ---------------------------------------------------------------------------

const INVENTORY_TYPES = ['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container'];

function componentsOf(sys: Record<string, unknown>): string {
  const props = Array.isArray(sys.properties) ? sys.properties.map(String) : [];
  const parts: string[] = [];
  if (props.includes('vocal')) {
    parts.push('V');
  }
  if (props.includes('somatic')) {
    parts.push('S');
  }
  if (props.includes('material')) {
    parts.push('M');
  }
  return parts.join(',');
}

function activationOf(sys: Record<string, unknown>): string {
  const type = str(at(sys, 'activation', 'type'));
  const value = at(sys, 'activation', 'value');
  if (!type) {
    return '';
  }
  return typeof value === 'number' && value > 1 ? `${value} ${type}` : type;
}

function rangeOf(sys: Record<string, unknown>): string {
  const r = at(sys, 'range');
  if (!isRec(r)) {
    return '';
  }
  const value = r.value;
  const units = str(r.units);
  if (units === 'self' || units === 'touch') {
    return units;
  }
  return value ? `${value} ${units || 'ft'}` : units;
}

function durationOf(sys: Record<string, unknown>): string {
  const d = at(sys, 'duration');
  if (!isRec(d)) {
    return '';
  }
  const units = str(d.units);
  if (units === 'inst') {
    return 'instantaneous';
  }
  return d.value ? `${d.value} ${units}` : units;
}

function usesOf(sys: Record<string, unknown>): string {
  const max = at(sys, 'uses', 'max');
  const spent = num(at(sys, 'uses', 'spent'));
  const maxNum = typeof max === 'number' ? max : Number(max);
  if (!Number.isFinite(maxNum) || maxNum <= 0) {
    return '';
  }
  return `${maxNum - spent}/${maxNum} uses`;
}

function formatSpell(item: WorldItem, details: boolean): string {
  const sys = itemSys(item);
  const prep = spellPreparation(item);
  const props = Array.isArray(sys.properties) ? sys.properties.map(String) : [];
  const meta = [
    SCHOOLS[str(sys.school)] ?? str(sys.school),
    activationOf(sys),
    rangeOf(sys),
    durationOf(sys),
    componentsOf(sys),
    props.includes('concentration') ? 'concentration' : '',
    props.includes('ritual') ? 'ritual' : '',
    prep.state,
    str(sys.sourceClass) ? `${str(sys.sourceClass)} list` : '',
    usesOf(sys),
  ].filter(Boolean);
  let out = `- **${item.name}** \`${item._id}\` — ${meta.join(' · ')}`;
  if (details) {
    out += detailBlock(item);
  }
  return out;
}

function detailBlock(item: WorldItem): string {
  const sys = itemSys(item);
  const desc = truncate(htmlToText(at(sys, 'description', 'value')), 700);
  const acts = summarizeActivities(item);
  return `${acts ? `\n  - Activities: ${acts}` : ''}${desc ? `\n  - ${desc.replace(/\n+/g, ' ')}` : ''}`;
}

const WEAPON_PROPERTIES: Record<string, string> = {
  amm: 'ammunition',
  fin: 'finesse',
  fir: 'firearm',
  foc: 'focus',
  hvy: 'heavy',
  lgt: 'light',
  lod: 'loading',
  rch: 'reach',
  rel: 'reload',
  ret: 'returning',
  spc: 'special',
  thr: 'thrown',
  two: 'two-handed',
  ver: 'versatile',
  mgc: 'magical',
  ada: 'adamantine',
  sil: 'silvered',
};

function diceOf(d: unknown): string {
  if (!isRec(d)) {
    return '';
  }
  const custom = at(d, 'custom', 'enabled') === true ? str(at(d, 'custom', 'formula')) : '';
  const dice =
    custom ||
    (num(d.number) && num(d.denomination) ? `${num(d.number)}d${num(d.denomination)}` : '');
  if (!dice) {
    return '';
  }
  const bonus = str(d.bonus);
  const types = Array.isArray(d.types) ? d.types.join('/') : '';
  const text = `${dice}${bonus ? `+${bonus}` : ''}${types ? ` ${types}` : ''}`;
  // Foundry formula variables only resolve in-app: show them as e.g. "STR mod".
  return text.replace(/@abilities\.(\w+)\.mod/g, (_m, a: string) => `${a.toUpperCase()} mod`);
}

/** Damage, range, properties and mastery for a weapon (dnd5e 5.x `system.damage.base`). */
function weaponSummary(sys: Record<string, unknown>): string {
  const parts: string[] = [];
  const base = diceOf(at(sys, 'damage', 'base'));
  if (base) {
    const versatile = diceOf(at(sys, 'damage', 'versatile'));
    parts.push(`${base}${versatile ? ` (versatile ${versatile})` : ''}`);
  }
  const magic = num(sys.magicalBonus);
  if (magic) {
    parts.push(`+${magic}`);
  }
  const range = at(sys, 'range');
  if (isRec(range) && num(range.value) > 0) {
    parts.push(
      `range ${num(range.value)}${num(range.long) ? `/${num(range.long)}` : ''} ${str(range.units, 'ft')}`,
    );
  }
  const props = Array.isArray(sys.properties)
    ? sys.properties.map((p) => WEAPON_PROPERTIES[String(p)] ?? String(p))
    : [];
  if (props.length > 0) {
    parts.push(props.join(', '));
  }
  if (str(sys.mastery)) {
    parts.push(`mastery: ${str(sys.mastery)}`);
  }
  return parts.join(' · ');
}

function formatGenericItem(item: WorldItem, all: WorldItem[], details: boolean): string {
  const sys = itemSys(item);
  const bits: string[] = [];
  const qty = num(sys.quantity, 1);
  if (['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container'].includes(item.type)) {
    if (qty !== 1) {
      bits.push(`×${qty}`);
    }
    if (sys.equipped === true) {
      bits.push('equipped');
    }
    const attune =
      sys.attuned === true
        ? 'attuned'
        : str(sys.attunement) === 'required'
          ? 'requires attunement'
          : '';
    if (attune) {
      bits.push(attune);
    }
    const rarity = str(sys.rarity);
    if (rarity && rarity !== 'common') {
      bits.push(rarity);
    }
    const containerId = str(sys.container);
    if (containerId) {
      const parent = all.find((i) => i._id === containerId);
      if (parent) {
        bits.push(`in ${parent.name}`);
      }
    }
  }
  const typeLabel = str(at(sys, 'type', 'label')) || str(at(sys, 'type', 'value'));
  if (item.type === 'feat' && typeLabel) {
    bits.push(typeLabel);
  }
  const uses = usesOf(sys);
  if (uses) {
    bits.push(uses);
  }
  if (item.type === 'weapon') {
    const summary = weaponSummary(sys);
    if (summary) {
      bits.push(summary);
    }
    const acts = summary ? '' : summarizeActivities(item);
    if (acts) {
      bits.push(acts);
    }
  }
  let out = `- **${item.name}** \`${item._id}\`${bits.length > 0 ? ` — ${bits.join(' · ')}` : ''}`;
  if (details) {
    out += detailBlock(item);
  }
  return out;
}

export async function handleGetActorItems(
  args: {
    actor?: string;
    type?: string;
    query?: string;
    details?: boolean;
  },
  foundryClient: FoundryClient,
) {
  const { actor: ref, type, query, details = false } = args;
  if (!ref || typeof ref !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'actor (id, name or player name) is required');
  }

  return withToolError('get actor items', async () => {
    const actor = resolveActor(foundryClient, ref);
    const all = itemsOf(actor);
    const typeFilter = type?.toLowerCase();
    let items = all;
    if (typeFilter === 'inventory' || typeFilter === 'gear') {
      items = all.filter((i) => INVENTORY_TYPES.includes(i.type));
    } else if (typeFilter && typeFilter !== 'all') {
      items = all.filter((i) => i.type === typeFilter);
    }
    if (query) {
      const q = query.toLowerCase();
      items = items.filter((i) => i.name.toLowerCase().includes(q));
    }

    const counts = new Map<string, number>();
    for (const i of all) {
      counts.set(i.type, (counts.get(i.type) ?? 0) + 1);
    }
    const summary = [...counts.entries()].map(([t, n]) => `${t} ${n}`).join(', ');

    const sections: string[] = [];
    const spells = items.filter((i) => i.type === 'spell');
    if (spells.length > 0) {
      const byLevel = new Map<number, WorldItem[]>();
      for (const s of spells) {
        const lvl = num(itemSys(s).level);
        byLevel.set(lvl, [...(byLevel.get(lvl) ?? []), s]);
      }
      for (const lvl of [...byLevel.keys()].sort((a, b) => a - b)) {
        const list = (byLevel.get(lvl) ?? []).sort((a, b) => a.name.localeCompare(b.name));
        sections.push(
          `**${lvl === 0 ? 'Cantrips' : `Level ${lvl} spells`}** (${list.length})\n${list.map((s) => formatSpell(s, details)).join('\n')}`,
        );
      }
    }
    const others = items.filter((i) => i.type !== 'spell');
    const groups = new Map<string, WorldItem[]>();
    for (const i of others) {
      groups.set(i.type, [...(groups.get(i.type) ?? []), i]);
    }
    for (const [t, list] of groups) {
      list.sort((a, b) => a.name.localeCompare(b.name));
      sections.push(
        `**${t[0]?.toUpperCase()}${t.slice(1)}** (${list.length})\n${list.map((i) => formatGenericItem(i, all, details)).join('\n')}`,
      );
    }

    const filters = [type ? `type=${type}` : '', query ? `query="${query}"` : ''].filter(Boolean);
    return {
      content: [
        {
          type: 'text',
          text: `🎒 **${actor.name}** — items${filters.length > 0 ? ` (${filters.join(', ')})` : ''}
\`${actor._id}\` · ${all.length} total: ${summary || 'none'}

${sections.join('\n\n') || 'No items matched.'}

_Item ids can be used with foundry_items_edit update_on_actor / remove_from_actor. Pass details=true for descriptions._`,
        },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// get_party_overview
// ---------------------------------------------------------------------------

export async function handleGetPartyOverview(
  _args: Record<string, unknown>,
  foundryClient: FoundryClient,
) {
  return withToolError('get party overview', async () => {
    const snapshot = foundryClient.getWorldSnapshot();
    if (!snapshot) {
      throw new McpError(ErrorCode.InternalError, 'Not connected — no world data available');
    }
    const players = snapshot.users.filter((u) => u.character);
    const assigned = new Set(players.map((u) => u.character));

    const row = (actor: WorldActor, player: string | null) => {
      const s = buildEffectiveSheet(actor);
      const notes = s.effects.current.map((e) => e.name);
      const cls = s.classes.map((c) => `${c.name} ${c.levels}`).join('/') || 'no class';
      const hp = s.hp.max === null ? `${s.hp.value}/?` : `${s.hp.value}/${s.hp.max}`;
      const spell = s.spellcasting.dc ? ` · DC ${s.spellcasting.dc}` : '';
      const passive = (k: string) => s.skills.find((x) => x.key === k)?.passive ?? 10;
      return `- **${actor.name}**${player ? ` (${player})` : ''} — ${cls} · HP ${hp}${s.hp.temp ? `+${s.hp.temp}` : ''} · AC ${s.ac.value ?? '?'} · PP ${passive('prc')}/Inv ${passive('inv')}/Ins ${passive('ins')}${spell}${notes.length > 0 ? ` · ⚠ ${notes.join(', ')}` : ''} · \`${actor._id}\``;
    };

    const lines: string[] = [];
    for (const user of players) {
      const actor = snapshot.actors.find((a) => a._id === user.character);
      if (actor) {
        lines.push(row(actor, user.name));
      }
    }
    const orphans = snapshot.actors.filter((a) => a.type === 'character' && !assigned.has(a._id));
    const gm = snapshot.users.filter((u) => u.role >= 3).map((u) => u.name);

    const avgLevel =
      players.length > 0
        ? (
            players.reduce((sum, u) => {
              const a = snapshot.actors.find((x) => x._id === u.character);
              return sum + (a ? buildSheet(a).level : 0);
            }, 0) / players.length
          ).toFixed(1)
        : '?';

    return {
      content: [
        {
          type: 'text',
          text: `🧙 **Party Overview** — ${lines.length} player characters · average level ${avgLevel}${gm.length > 0 ? ` · GM: ${gm.join(', ')}` : ''}

${lines.join('\n') || 'No users have an assigned character.'}
${
  orphans.length > 0
    ? `\n**Characters with no assigned player** (retired/unused?)\n${orphans.map((a) => row(a, null)).join('\n')}\n`
    : ''
}
_PP/Inv/Ins = passive Perception/Investigation/Insight. HP max is computed from class hit dice when the world stores none. See foundry_actors get for a full sheet._`,
        },
      ],
    };
  });
}
