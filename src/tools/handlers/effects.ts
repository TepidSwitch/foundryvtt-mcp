/**
 * @fileoverview Active-effect evaluation for dnd5e actors
 *
 * FoundryVTT applies active effects (magic-item bonuses, fighting styles, spell
 * effects, conditions) on top of an actor's source data at load time; the world
 * snapshot only has the source. This module applies the numeric, unambiguous
 * subset and reports what it could not evaluate, so sheets built from the
 * result are closer to what the player sees without pretending to be exact.
 *
 * Supported: ability scores, AC bonus and AC calculation, movement, senses,
 * max-HP adjustments and damage/condition trait lists. Not evaluated: dice or
 * formula values ("+1d4", "@abilities.int.mod"), roll-mode changes, item and
 * activity overrides, and macro/module keys.
 *
 * FoundryVTT v14 stores changes at `effect.system.changes` with a string
 * `type`; older data uses `effect.changes` with a numeric `mode`. Both are read.
 */

import type { WorldActor, WorldItem } from '../../foundry/types.js';
import { at, buildSheet, isRec, itemSys, itemsOf, type Sheet, str, toNum } from './dnd5e.js';

type Rec = Record<string, unknown>;

const MODE_TYPES: Record<number, string> = {
  0: 'custom',
  1: 'multiply',
  2: 'add',
  3: 'downgrade',
  4: 'upgrade',
  5: 'override',
};

export interface EffectChange {
  key: string;
  type: string;
  value: unknown;
  priority: number;
  effectName: string;
}

export interface ActiveEffectInfo {
  name: string;
  statuses: string[];
  source: 'actor' | string;
  changes: EffectChange[];
}

export interface EffectSummary {
  /** Effects currently on the actor (conditions, concentration, spell effects). */
  current: ActiveEffectInfo[];
  /** Human-readable list of the changes that were applied. */
  applied: string[];
  /** Count of changes that could not be evaluated (dice, formulas, roll modes). */
  unresolved: number;
}

export interface EffectiveSheet extends Sheet {
  /** The actor with numeric effect changes applied to `system`. */
  actor: WorldActor;
  effects: EffectSummary;
}

// ---------------------------------------------------------------------------
// Reading effects
// ---------------------------------------------------------------------------

function changesOf(effect: Rec, effectName: string): EffectChange[] {
  const raw = at(effect, 'system', 'changes') ?? effect.changes;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isRec).map((c) => ({
    key: str(c.key),
    type: typeof c.type === 'string' ? c.type : (MODE_TYPES[Number(c.mode)] ?? 'add'),
    value: c.value,
    priority: typeof c.priority === 'number' ? c.priority : 20,
    effectName,
  }));
}

/** dnd5e suppresses item effects for unequipped or un-attuned gear. */
function isSuppressed(item: WorldItem): boolean {
  const sys = itemSys(item);
  if (typeof sys.equipped === 'boolean' && sys.equipped === false) {
    return true;
  }
  return str(sys.attunement) === 'required' && sys.attuned !== true;
}

function readEffects(effects: unknown, source: string): ActiveEffectInfo[] {
  if (!Array.isArray(effects)) {
    return [];
  }
  return effects
    .filter(isRec)
    .filter((e) => e.disabled !== true && str(e.type, 'base') !== 'enchantment')
    .map((e) => {
      const name = str(e.name) || str(e.label) || 'Unnamed effect';
      return {
        name,
        statuses: Array.isArray(e.statuses) ? e.statuses.map(String) : [],
        source,
        changes: changesOf(e, name),
      };
    });
}

/** Effects currently on the actor itself: conditions, concentration, cast spell effects. */
export function currentEffects(actor: WorldActor): ActiveEffectInfo[] {
  return readEffects(actor.effects, 'actor');
}

/**
 * Passive item effects: `transfer` effects on items that are not suppressed.
 * (Spell and activity effects have `transfer: false` and only apply once cast,
 * at which point they appear on the actor itself.)
 */
export function passiveEffects(actor: WorldActor): ActiveEffectInfo[] {
  const out: ActiveEffectInfo[] = [];
  for (const item of itemsOf(actor)) {
    if (isSuppressed(item)) {
      continue;
    }
    const transferring = (Array.isArray(item.effects) ? item.effects : []).filter(
      (e) => (e as unknown as Rec).transfer === true,
    );
    out.push(...readEffects(transferring, item.name));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Applying effects
// ---------------------------------------------------------------------------

/** Parses a plain number or a signed numeric string ("+5"); null for dice/formulas. */
function parseNumeric(v: unknown): number | null {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === 'string' && /^[+-]?\d+(\.\d+)?$/.test(v.trim())) {
    return Number(v.trim());
  }
  return null;
}

function combine(current: number, type: string, n: number): number | null {
  switch (type) {
    case 'add':
      return current + n;
    case 'multiply':
      return current * n;
    case 'upgrade':
      return Math.max(current, n);
    case 'downgrade':
      return Math.min(current, n);
    case 'override':
      return n;
    default:
      return null;
  }
}

const ABILITY_KEY = /^system\.abilities\.(str|dex|con|int|wis|cha)\.value$/;
const MOVEMENT_KEY = /^system\.attributes\.movement\.(walk|fly|swim|climb|burrow)$/;
const SENSE_KEY = /^system\.attributes\.senses\.(?:ranges\.)?([a-z]+)$/;
const TRAIT_KEY = /^system\.traits\.(dr|di|dv|ci)\.value$/;
const MOVE_MODES = ['walk', 'fly', 'swim', 'climb', 'burrow'];

function sign(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

function describe(name: string, what: string, type: string, n: number): string {
  const amount =
    type === 'override'
      ? `= ${n}`
      : type === 'multiply'
        ? `×${n}`
        : type === 'add'
          ? sign(n)
          : `${type} ${n}`;
  return `${name}: ${what} ${amount}`;
}

/** Applies one change to the cloned system data. Returns a description, or null if unsupported. */
function applyChange(system: Rec, change: EffectChange): string | null {
  const { key, type, value, effectName } = change;

  // Reference to the actor's own walk speed, e.g. Spider Climb / Alter Self
  const movement = at(system, 'attributes', 'movement');
  const walk = isRec(movement) ? toNum(movement.walk) : 0;
  const n = value === '@attributes.movement.walk' ? walk : parseNumeric(value);

  const abilityMatch = key.match(ABILITY_KEY);
  const movementMatch = key.match(MOVEMENT_KEY);
  const senseMatch = key.match(SENSE_KEY);
  const traitMatch = key.match(TRAIT_KEY);

  if (abilityMatch && n !== null) {
    const ability = at(system, 'abilities', abilityMatch[1] as string);
    if (!isRec(ability)) {
      return null;
    }
    const next = combine(toNum(ability.value), type, n);
    if (next === null) {
      return null;
    }
    ability.value = next;
    return describe(effectName, `${(abilityMatch[1] as string).toUpperCase()} score`, type, n);
  }

  if (key === 'system.attributes.ac.bonus' && type === 'add' && n !== null) {
    const ac = at(system, 'attributes', 'ac');
    if (!isRec(ac)) {
      return null;
    }
    ac.bonus = (parseNumeric(ac.bonus) ?? 0) + n;
    return describe(effectName, 'AC', 'add', n);
  }

  if (key === 'system.attributes.ac.calc' && type === 'override' && typeof value === 'string') {
    const ac = at(system, 'attributes', 'ac');
    if (!isRec(ac)) {
      return null;
    }
    ac.calc = value;
    return `${effectName}: AC calculation ${value}`;
  }

  if (movementMatch && n !== null && isRec(movement)) {
    const mode = movementMatch[1] as string;
    const next = combine(toNum(movement[mode]), type, n);
    if (next === null) {
      return null;
    }
    movement[mode] = next;
    return describe(effectName, `${mode} speed`, type, n);
  }

  // "all" movement modes: custom "+10" / "*2"
  if (
    key === 'system.attributes.movement.all' &&
    type === 'custom' &&
    typeof value === 'string' &&
    isRec(movement)
  ) {
    const mul = value.trim().match(/^\*\s*(\d+(?:\.\d+)?)$/);
    const add = parseNumeric(value.trim().replace(/^\+\s*/, '+'));
    for (const mode of MOVE_MODES) {
      const cur = toNum(movement[mode]);
      if (cur > 0) {
        movement[mode] = mul ? cur * Number(mul[1]) : add !== null ? cur + add : cur;
      }
    }
    if (mul || add !== null) {
      return `${effectName}: all speeds ${mul ? `×${mul[1]}` : sign(add as number)}`;
    }
    return null;
  }

  if (senseMatch && n !== null && senseMatch[1] !== 'units' && senseMatch[1] !== 'special') {
    const senses = at(system, 'attributes', 'senses');
    if (!isRec(senses)) {
      return null;
    }
    const bucket = isRec(senses.ranges) ? senses.ranges : senses;
    const sense = senseMatch[1] as string;
    const next = combine(toNum(bucket[sense]), type, n);
    if (next === null) {
      return null;
    }
    bucket[sense] = next;
    return describe(effectName, sense, type, n);
  }

  if (key === 'system.attributes.hp.tempmax' && type === 'add' && n !== null) {
    const hp = at(system, 'attributes', 'hp');
    if (!isRec(hp)) {
      return null;
    }
    hp.tempmax = toNum(hp.tempmax) + n;
    return describe(effectName, 'max HP', 'add', n);
  }

  if (traitMatch && typeof value === 'string' && (type === 'add' || type === 'override')) {
    const trait = at(system, 'traits', traitMatch[1] as string);
    if (!isRec(trait)) {
      return null;
    }
    const list = Array.isArray(trait.value) ? trait.value.map(String) : [];
    if (!list.includes(value)) {
      list.push(value);
    }
    trait.value = list;
    const label = {
      dr: 'resistance',
      di: 'immunity',
      dv: 'vulnerability',
      ci: 'condition immunity',
    }[traitMatch[1] as string];
    return `${effectName}: ${label} ${value}`;
  }

  return null;
}

export interface AppliedEffects {
  actor: WorldActor;
  summary: EffectSummary;
}

/**
 * Returns a copy of the actor whose `system` has the supported numeric effect
 * changes applied. The input actor is not modified.
 */
export function applyEffects(actor: WorldActor): AppliedEffects {
  const current = currentEffects(actor);
  const all = [...passiveEffects(actor), ...current];
  const changes = all
    .flatMap((e) => e.changes)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.priority - b.c.priority || a.i - b.i)
    .map(({ c }) => c);

  const system = structuredClone(actor.system) as Rec;
  const applied: string[] = [];
  let unresolved = 0;
  for (const change of changes) {
    if (!change.key.startsWith('system.')) {
      // items.*, flags.*, ATL.*, macro.*, StatusEffect… — not evaluated
      if (change.key !== 'name' && change.key !== '') {
        unresolved++;
      }
      continue;
    }
    const description = applyChange(system, change);
    if (description) {
      applied.push(description);
    } else {
      unresolved++;
    }
  }
  return { actor: { ...actor, system }, summary: { current, applied, unresolved } };
}

/** Builds a sheet from the effect-adjusted actor and attaches the effect summary. */
export function buildEffectiveSheet(actor: WorldActor): EffectiveSheet {
  const { actor: effective, summary } = applyEffects(actor);
  return { ...buildSheet(effective), actor: effective, effects: summary };
}
