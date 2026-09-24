/**
 * @fileoverview dnd5e sheet derivation
 *
 * The world snapshot FoundryVTT sends is *source* data: the derived values a
 * player sees on the sheet (max HP, AC, level, proficiency, skill totals, spell
 * slots, save DC) are computed client-side by the dnd5e system and mostly are
 * not stored. This module recomputes them from the raw actor document.
 *
 * Everything here is an approximation of the system's own preparation: bonuses
 * that come from active effects, magic items and feats (e.g. Tough, +1 armor
 * enchantments applied through effects, racial darkvision) are not applied.
 * Callers surface that caveat to the user.
 */

import type { WorldActor, WorldItem } from '../../foundry/types.js';

type Rec = Record<string, unknown>;

export function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Compendium data stores some numbers as strings ("40"); accepts both. */
export function toNum(v: unknown): number {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : 0;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** Safe nested read: `at(obj, 'a', 'b')` → obj.a.b or undefined. */
export function at(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!isRec(cur)) {
      return undefined;
    }
    cur = cur[key];
  }
  return cur;
}

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type AbilityKey = (typeof ABILITIES)[number];

export const SKILLS: Record<string, { label: string; ability: AbilityKey }> = {
  acr: { label: 'Acrobatics', ability: 'dex' },
  ani: { label: 'Animal Handling', ability: 'wis' },
  arc: { label: 'Arcana', ability: 'int' },
  ath: { label: 'Athletics', ability: 'str' },
  dec: { label: 'Deception', ability: 'cha' },
  his: { label: 'History', ability: 'int' },
  ins: { label: 'Insight', ability: 'wis' },
  itm: { label: 'Intimidation', ability: 'cha' },
  inv: { label: 'Investigation', ability: 'int' },
  med: { label: 'Medicine', ability: 'wis' },
  nat: { label: 'Nature', ability: 'int' },
  prc: { label: 'Perception', ability: 'wis' },
  prf: { label: 'Performance', ability: 'cha' },
  per: { label: 'Persuasion', ability: 'cha' },
  rel: { label: 'Religion', ability: 'int' },
  slt: { label: 'Sleight of Hand', ability: 'dex' },
  ste: { label: 'Stealth', ability: 'dex' },
  sur: { label: 'Survival', ability: 'wis' },
};

export const SCHOOLS: Record<string, string> = {
  abj: 'Abjuration',
  con: 'Conjuration',
  div: 'Divination',
  enc: 'Enchantment',
  evo: 'Evocation',
  ill: 'Illusion',
  nec: 'Necromancy',
  trs: 'Transmutation',
};

export function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

export function proficiencyForLevel(level: number): number {
  return 2 + Math.floor((Math.max(level, 1) - 1) / 4);
}

/** CR may be a number, a numeric string, or a fraction string ("1/2"). */
export function parseCr(cr: unknown): number | null {
  if (typeof cr === 'number') {
    return cr;
  }
  if (typeof cr === 'string' && cr.trim() !== '') {
    if (cr.includes('/')) {
      const [a, b] = cr.split('/').map(Number);
      return a !== undefined && b ? a / b : null;
    }
    const n = Number(cr);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function formatCr(cr: number | null): string {
  if (cr === null) {
    return '?';
  }
  if (cr > 0 && cr < 1) {
    return `1/${Math.round(1 / cr)}`;
  }
  return String(cr);
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export function itemsOf(actor: WorldActor): WorldItem[] {
  return Array.isArray(actor.items) ? actor.items : [];
}

export function itemSys(item: WorldItem): Rec {
  return isRec(item.system) ? item.system : {};
}

export function identifierOf(item: WorldItem): string {
  return str(itemSys(item).identifier);
}

export interface ClassInfo {
  name: string;
  identifier: string;
  levels: number;
  subclass: string | null;
  hitDie: number;
  /** Hit dice already spent (class `hd.spent`). */
  hdSpent: number;
  progression: string;
  ability: string;
  item: WorldItem;
}

function parseDie(v: unknown): number {
  if (typeof v === 'string') {
    const n = Number(v.replace(/^d/i, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return typeof v === 'number' ? v : 0;
}

export function classesOf(actor: WorldActor): ClassInfo[] {
  const items = itemsOf(actor);
  const subclasses = items.filter((i) => i.type === 'subclass');
  return items
    .filter((i) => i.type === 'class')
    .map((item) => {
      const sys = itemSys(item);
      const identifier = str(sys.identifier);
      const sub = subclasses.find((s) => str(itemSys(s).classIdentifier) === identifier);
      const hd = sys.hd;
      const denom = isRec(hd) ? hd.denomination : hd;
      let progression = str(at(sys, 'spellcasting', 'progression'), 'none');
      if ((progression === 'none' || progression === '') && sub) {
        progression = str(at(itemSys(sub), 'spellcasting', 'progression'), 'none');
      }
      return {
        name: item.name,
        identifier,
        levels: num(sys.levels, 1),
        subclass: sub ? sub.name : null,
        hitDie: parseDie(denom),
        hdSpent: num(isRec(hd) ? hd.spent : 0),
        progression,
        ability:
          str(at(sys, 'spellcasting', 'ability')) ||
          str(sub && at(itemSys(sub), 'spellcasting', 'ability')),
        item,
      };
    });
}

export function totalLevel(actor: WorldActor): number {
  return classesOf(actor).reduce((sum, c) => sum + c.levels, 0);
}

// ---------------------------------------------------------------------------
// HP, AC
// ---------------------------------------------------------------------------

export interface HpInfo {
  value: number;
  max: number | null;
  temp: number;
  /** stored = value present on the document; computed = derived from class levels */
  source: 'stored' | 'computed' | 'unknown';
}

export function computeHp(actor: WorldActor, conMod: number): HpInfo {
  const hp = at(actor.system, 'attributes', 'hp');
  const value = num(at(hp, 'value'));
  const temp = num(at(hp, 'temp'));
  const stored = at(hp, 'max');
  if (typeof stored === 'number') {
    return { value, max: stored + num(at(hp, 'tempmax')), temp, source: 'stored' };
  }
  const classes = classesOf(actor);
  if (classes.length === 0) {
    return { value, max: null, temp, source: 'unknown' };
  }
  let total = 0;
  const level = classes.reduce((s, c) => s + c.levels, 0);
  for (const c of classes) {
    const advancement = at(c.item, 'system', 'advancement');
    const advList = isRec(advancement) ? Object.values(advancement) : [];
    const hpAdv = advList.find((a) => isRec(a) && a.type === 'HitPoints');
    const values = isRec(hpAdv) && isRec(hpAdv.value) ? hpAdv.value : {};
    for (let lvl = 1; lvl <= c.levels; lvl++) {
      const v = values[String(lvl)];
      if (typeof v === 'number') {
        total += v;
      } else if (v === 'max') {
        total += c.hitDie;
      } else if (c.hitDie > 0) {
        // 'avg' or unset level: use the fixed average (rounded up)
        total += Math.floor(c.hitDie / 2) + 1;
      }
    }
  }
  total += conMod * level;
  const bonuses = at(hp, 'bonuses');
  total += Number(at(bonuses, 'level')) * level || 0;
  total += Number(at(bonuses, 'overall')) || 0;
  total += num(at(hp, 'tempmax'));
  return { value, max: Math.max(total, 1), temp, source: 'computed' };
}

export interface AcInfo {
  value: number | null;
  detail: string;
}

/**
 * Computes AC. dnd5e ≤5.3 stores a single `ac.calc`; 6.0 stores a list in
 * `ac.calcs` and the sheet picks the best one the actor qualifies for, so every
 * listed calculation is evaluated and the highest wins.
 */
export function computeAc(actor: WorldActor, mods: Record<AbilityKey, number>): AcInfo {
  const ac = at(actor.system, 'attributes', 'ac');
  const listed = at(ac, 'calcs');
  const calcs =
    Array.isArray(listed) && listed.length > 0
      ? listed.filter((c): c is string => typeof c === 'string')
      : [str(at(ac, 'calc'), 'default')];
  if (!calcs.includes('default') && Array.isArray(listed)) {
    calcs.push('default');
  }
  let best: AcInfo | null = null;
  for (const calc of calcs) {
    const info = computeAcForCalc(actor, calc, mods);
    if (!best || (info.value ?? -1) > (best.value ?? -1)) {
      best = info;
    }
  }
  if (best && best.value !== null) {
    // `ac.bonus` is a formula string in the source; only plain numbers are evaluated.
    const raw = at(ac, 'bonus');
    const text = typeof raw === 'string' ? raw.trim() : '';
    const bonus = typeof raw === 'number' ? raw : /^[+-]?\d+$/.test(text) ? Number(text) : 0;
    if (bonus !== 0) {
      best = { value: best.value + bonus, detail: `${best.detail} ${signed(bonus)} bonus` };
    }
  }
  return best ?? { value: null, detail: 'unknown' };
}

function computeAcForCalc(
  actor: WorldActor,
  calc: string,
  mods: Record<AbilityKey, number>,
): AcInfo {
  const ac = at(actor.system, 'attributes', 'ac');
  const flat = at(ac, 'flat');
  if (calc === 'natural' || calc === 'flat') {
    return typeof flat === 'number'
      ? { value: flat, detail: calc === 'natural' ? 'natural armor' : 'flat' }
      : { value: null, detail: 'natural armor (no value stored)' };
  }
  if (calc === 'custom') {
    return {
      value: typeof flat === 'number' ? flat : null,
      detail: `custom formula "${str(at(ac, 'formula'))}" (not evaluated)`,
    };
  }

  const equipped = itemsOf(actor).filter(
    (i) => i.type === 'equipment' && itemSys(i).equipped === true,
  );
  const armor = equipped.find((i) =>
    ['light', 'medium', 'heavy'].includes(str(at(itemSys(i), 'type', 'value'))),
  );
  const shield = equipped.find((i) => str(at(itemSys(i), 'type', 'value')) === 'shield');
  const parts: string[] = [];
  let value: number;

  if (armor) {
    const kind = str(at(itemSys(armor), 'type', 'value'));
    const base = num(at(itemSys(armor), 'armor', 'value'), 10);
    const magic = num(at(itemSys(armor), 'armor', 'magicalBonus'));
    const capRaw = at(itemSys(armor), 'armor', 'dex');
    const cap =
      typeof capRaw === 'number'
        ? capRaw
        : kind === 'medium'
          ? 2
          : kind === 'heavy'
            ? 0
            : Number.POSITIVE_INFINITY;
    value = base + magic + Math.min(mods.dex, cap);
    parts.push(armor.name);
  } else {
    switch (calc) {
      case 'unarmoredBarb':
        value = 10 + mods.dex + mods.con;
        parts.push('Unarmored Defense (Barbarian)');
        break;
      case 'unarmoredMonk':
        value = 10 + mods.dex + mods.wis;
        parts.push('Unarmored Defense (Monk)');
        break;
      case 'mage':
        value = 13 + mods.dex;
        parts.push('Mage Armor');
        break;
      case 'draconic':
        value = 13 + mods.dex;
        parts.push('Draconic Resilience');
        break;
      default:
        value = 10 + mods.dex;
        parts.push('unarmored');
    }
  }
  if (shield) {
    value +=
      num(at(itemSys(shield), 'armor', 'value'), 2) +
      num(at(itemSys(shield), 'armor', 'magicalBonus'));
    parts.push(shield.name);
  }
  return { value, detail: parts.join(' + ') };
}

// ---------------------------------------------------------------------------
// Spellcasting
// ---------------------------------------------------------------------------

// Multiclass spellcaster table (PHB): slots by caster level 1-20, levels 1-9.
const SLOT_TABLE: number[][] = [
  [2],
  [3],
  [4, 2],
  [4, 3],
  [4, 3, 2],
  [4, 3, 3],
  [4, 3, 3, 1],
  [4, 3, 3, 2],
  [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 2, 1, 1],
];

function pactSlots(level: number): { count: number; level: number } {
  const lvl = level >= 9 ? 5 : level >= 7 ? 4 : level >= 5 ? 3 : level >= 3 ? 2 : 1;
  const count = level >= 17 ? 4 : level >= 11 ? 3 : level >= 2 ? 2 : 1;
  return { count, level: lvl };
}

export interface SlotInfo {
  level: number;
  value: number;
  max: number;
}

export interface SpellcastingInfo {
  ability: AbilityKey | null;
  dc: number | null;
  attack: number | null;
  casterLevel: number;
  slots: SlotInfo[];
  pact: { value: number; max: number; level: number } | null;
}

export function computeSpellcasting(
  actor: WorldActor,
  mods: Record<AbilityKey, number>,
  prof: number,
): SpellcastingInfo {
  const classes = classesOf(actor);
  const sys = actor.system;
  let casterLevel = 0;
  let pactLevels = 0;
  // Half/third casters round up when they are the only leveled caster and down
  // when multiclassed (matches the system's own rule and the PHB tables).
  const leveledCasters = classes.filter((c) =>
    ['full', 'half', 'artificer', 'third'].includes(c.progression),
  );
  const single = leveledCasters.length === 1;
  for (const c of classes) {
    switch (c.progression) {
      case 'full':
        casterLevel += c.levels;
        break;
      case 'half':
        casterLevel += single ? Math.ceil(c.levels / 2) : Math.floor(c.levels / 2);
        break;
      case 'artificer':
        casterLevel += Math.ceil(c.levels / 2);
        break;
      case 'third':
        casterLevel += single ? Math.ceil(c.levels / 3) : Math.floor(c.levels / 3);
        break;
      case 'pact':
        pactLevels += c.levels;
        break;
      default:
    }
  }

  const abilityRaw =
    str(at(sys, 'attributes', 'spellcasting')) || classes.find((c) => c.ability)?.ability || '';
  const ability = (ABILITIES as readonly string[]).includes(abilityRaw)
    ? (abilityRaw as AbilityKey)
    : null;

  const slots: SlotInfo[] = [];
  const row = casterLevel > 0 ? (SLOT_TABLE[Math.min(casterLevel, 20) - 1] ?? []) : [];
  for (let lvl = 1; lvl <= 9; lvl++) {
    const max = row[lvl - 1] ?? 0;
    const value = num(at(sys, 'spells', `spell${lvl}`, 'value'));
    if (max > 0 || value > 0) {
      slots.push({ level: lvl, value, max: Math.max(max, value) });
    }
  }

  let pact: SpellcastingInfo['pact'] = null;
  if (pactLevels > 0) {
    const p = pactSlots(pactLevels);
    pact = { value: num(at(sys, 'spells', 'pact', 'value')), max: p.count, level: p.level };
  }

  return {
    ability,
    dc: ability ? 8 + prof + mods[ability] : null,
    attack: ability ? prof + mods[ability] : null,
    casterLevel,
    slots,
    pact,
  };
}

/**
 * Spell preparation state, tolerant of both data shapes:
 *  - dnd5e ≥5.1 (migrated): `system.method` + numeric `system.prepared` (0/1/2)
 *  - older / not yet migrated in the database: `system.preparation.{mode,prepared}`
 */
export function spellPreparation(item: WorldItem): { method: string; state: string } {
  const sys = itemSys(item);
  const legacyMode = str(at(sys, 'preparation', 'mode'));
  const method = str(sys.method) || legacyMode;
  let state: string;
  if (typeof sys.prepared === 'number') {
    state =
      sys.prepared === 2 ? 'always prepared' : sys.prepared === 1 ? 'prepared' : 'not prepared';
  } else if (legacyMode === 'always') {
    state = 'always prepared';
  } else if (at(sys, 'preparation', 'prepared') === true) {
    state = 'prepared';
  } else {
    state = 'not prepared';
  }
  if (num(sys.level) === 0) {
    state = 'cantrip';
  } else if (['innate', 'atwill', 'ritual'].includes(method)) {
    state = method === 'atwill' ? 'at will' : method;
  } else if (method === 'pact') {
    state = state === 'not prepared' ? 'pact magic' : `pact magic, ${state}`;
  }
  return { method, state };
}

/** Senses in feet, tolerant of the ≤5.2 flat shape and the ≥5.3 `senses.ranges` shape. */
export function sensesOf(actor: WorldActor): Array<{ name: string; range: number }> {
  const raw = at(actor.system, 'attributes', 'senses');
  const ranges = isRec(at(raw, 'ranges')) ? (at(raw, 'ranges') as Rec) : isRec(raw) ? raw : {};
  const out: Array<{ name: string; range: number }> = [];
  for (const [name, v] of Object.entries(ranges)) {
    const n = toNum(v);
    if (n > 0 && name !== 'units') {
      out.push({ name, range: n });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Full sheet
// ---------------------------------------------------------------------------

export interface Sheet {
  name: string;
  type: string;
  level: number;
  cr: number | null;
  prof: number;
  mods: Record<AbilityKey, number>;
  scores: Record<AbilityKey, number>;
  saves: Record<AbilityKey, { total: number; proficient: boolean }>;
  skills: Array<{ key: string; label: string; total: number; passive: number; mult: number }>;
  hp: HpInfo;
  ac: AcInfo;
  classes: ClassInfo[];
  spellcasting: SpellcastingInfo;
}

export function buildSheet(actor: WorldActor): Sheet {
  const sys = actor.system;
  const isNpc = actor.type === 'npc';
  const scores = {} as Record<AbilityKey, number>;
  const mods = {} as Record<AbilityKey, number>;
  for (const k of ABILITIES) {
    scores[k] = num(at(sys, 'abilities', k, 'value'), 10);
    mods[k] = abilityMod(scores[k]);
  }
  const level = totalLevel(actor);
  const cr = isNpc ? parseCr(at(sys, 'details', 'cr')) : null;
  const prof = isNpc
    ? proficiencyForLevel(Math.max(1, cr === null ? 1 : Math.max(1, Math.ceil(cr))))
    : proficiencyForLevel(level);
  // NPC prof by CR: 2 + floor((CR-1)/4), with CR<1 → 2. proficiencyForLevel(ceil(CR)) matches that.
  const profBonus =
    isNpc && typeof at(sys, 'attributes', 'prof') === 'number'
      ? num(at(sys, 'attributes', 'prof'))
      : prof;

  const saves = {} as Sheet['saves'];
  for (const k of ABILITIES) {
    const p = num(at(sys, 'abilities', k, 'proficient'));
    const bonus = Number(at(sys, 'abilities', k, 'bonuses', 'save')) || 0;
    saves[k] = { total: mods[k] + Math.floor(p * profBonus) + bonus, proficient: p > 0 };
  }

  const jack = at(actor.flags, 'dnd5e', 'jackOfAllTrades') === true;
  const skills: Sheet['skills'] = Object.entries(SKILLS).map(([key, def]) => {
    const entry = at(sys, 'skills', key);
    const ability = (str(at(entry, 'ability')) as AbilityKey) || def.ability;
    const mult = num(at(entry, 'value'));
    const bonus = Number(at(entry, 'bonuses', 'check')) || 0;
    const profPart = mult > 0 ? Math.floor(mult * profBonus) : jack ? Math.floor(profBonus / 2) : 0;
    const total = (mods[ability] ?? 0) + profPart + bonus;
    const passiveBonus = Number(at(entry, 'bonuses', 'passive')) || 0;
    return { key, label: def.label, total, passive: 10 + total + passiveBonus, mult };
  });

  const hp = computeHp(actor, mods.con);
  const ac = computeAc(actor, mods);
  return {
    name: actor.name,
    type: actor.type,
    level,
    cr,
    prof: profBonus,
    mods,
    scores,
    saves,
    skills,
    hp,
    ac,
    classes: classesOf(actor),
    spellcasting: computeSpellcasting(actor, mods, profBonus),
  };
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
  '&rsquo;': "'",
  '&lsquo;': "'",
  '&ldquo;': '"',
  '&rdquo;': '"',
  '&mdash;': '—',
  '&ndash;': '–',
};

/** Converts FoundryVTT HTML (descriptions, journals) to plain text. */
export function htmlToText(html: unknown): string {
  if (typeof html !== 'string' || html === '') {
    return '';
  }
  return (
    html
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, '')
      .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e)
      // Foundry enrichers (run after entity decoding: "&amp;Reference[..]" is common)
      .replace(/@Embed\[[^\]]*\]/g, '')
      .replace(/[@&][A-Za-z]+\[[^\]]*\]\{([^}]*)\}/g, '$1')
      .replace(/@UUID\[\.?([^\]]*)\]/g, (_m, id: string) =>
        id.replace(/^mm/, '').replace(/0+$/, ''),
      )
      .replace(/&Reference\[([^\]\s=]+)[^\]]*\]/g, '$1')
      // 2024 stat-block enrichers that only resolve inside Foundry
      .replace(/\[\[\/item\s+\.?([^\]\s]+)\s*\]\]/gi, (_m, id: string) =>
        id.replace(/^mm/, '').replace(/0+$/, ''),
      )
      .replace(/\[\[\/attack[^\]]*\]\]/gi, '[attack roll]')
      .replace(/\[\[\/damage[^\]]*\]\]/gi, '[damage]')
      .replace(/\[\[\/?[a-z]+\s+([^\]]*?)\]\]\{([^}]*)\}/gi, '$2')
      .replace(/\[\[\/?[a-z]+\s+([^\]]*?)\]\]/gi, '$1')
      .replace(/\[\[([^\]]*?)\]\]/g, '$1')
      // dnd5e activity variables that only resolve inside Foundry
      .replace(/@save\.dc\.value\s+activity=\w+/g, '[save DC]')
      .replace(/@target\.affects\.type\s+activity=\w+/g, 'target')
      .replace(/@target\.template\.size\s+activity=\w+/g, '[size]')
      .replace(/@[a-zA-Z]+(?:\.[a-zA-Z]+)+(?:\s+activity=\w+)?/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** One-line summary of an item's activities (damage, save, heal). */
export function summarizeActivities(item: WorldItem): string {
  const activities = itemSys(item).activities;
  if (!isRec(activities)) {
    return '';
  }
  const out: string[] = [];
  for (const act of Object.values(activities)) {
    if (!isRec(act)) {
      continue;
    }
    const type = str(act.type);
    const bits: string[] = [];
    const parts = at(act, 'damage', 'parts');
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (!isRec(p)) {
          continue;
        }
        const custom = str(at(p, 'custom', 'formula'));
        const dice =
          custom ||
          (num(p.number) && num(p.denomination)
            ? `${num(p.number)}d${num(p.denomination)}${p.bonus ? `+${str(p.bonus)}` : ''}`
            : str(p.bonus));
        const types = Array.isArray(p.types) ? p.types.join('/') : '';
        if (dice) {
          bits.push(`${dice}${types ? ` ${types}` : ''}`);
        }
      }
    }
    const heal = at(act, 'healing');
    if (isRec(heal) && (num(heal.number) || heal.bonus)) {
      bits.push(
        `heal ${num(heal.number)}d${num(heal.denomination)}${heal.bonus ? `+${str(heal.bonus)}` : ''}`,
      );
    }
    const saveAbility = at(act, 'save', 'ability');
    if (Array.isArray(saveAbility) && saveAbility.length > 0) {
      bits.push(`${saveAbility.join('/').toUpperCase()} save`);
    }
    if (type) {
      out.push(bits.length > 0 ? `${type}: ${bits.join(', ')}` : type);
    }
  }
  return out.join(' | ');
}
