/**
 * @fileoverview Headless roll-data resolver for active-effect values
 *
 * The server has no Foundry runtime and therefore no `actor.getRollData()`.
 * This resolves the common references found in effect values from raw world
 * data: `@scale.<item-identifier>.<scale-id>[.die|.number|.faces]`, `@prof`,
 * `@attributes.prof`, `@abilities.<abl>.mod`, `@details.level` and
 * `@classes.<id>.levels`. Anything else is reported as unresolved.
 */

import type { WorldActor, WorldItem } from '../../foundry/types.js';
import { at, identifierOf, isRec, itemSys, itemsOf, str, toNum } from './dnd5e.js';

type Rec = Record<string, unknown>;

export interface RollContext {
  /** Resolves a dotted path (without the leading "@"), or undefined if unknown. */
  lookup(path: string): number | string | undefined;
}

export interface ResolvedValue {
  /** A number when the result is a plain integer expression; otherwise a formula string. */
  value: number | string;
  /** True when `value` contains dice. */
  hasDice: boolean;
  /** References (with "@") that could not be resolved. */
  unresolved: string[];
}

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const REF = /@[a-zA-Z_]\w*(?:[.-][a-zA-Z_]\w*)*/g;
const DICE = /\d*d\d+/i;

function advancementEntries(item: WorldItem): Rec[] {
  const adv = itemSys(item).advancement;
  const list = Array.isArray(adv) ? adv : isRec(adv) ? Object.values(adv) : [];
  return list.filter(isRec);
}

/** The scale entry's value at `level`: the entry with the highest key <= level. */
function scaleAt(scale: unknown, level: number): Rec | undefined {
  if (!isRec(scale)) {
    return undefined;
  }
  let best = -1;
  let found: Rec | undefined;
  for (const [k, v] of Object.entries(scale)) {
    const n = Number(k);
    if (Number.isFinite(n) && n <= level && n > best && isRec(v)) {
      best = n;
      found = v;
    }
  }
  return found;
}

function levelOfItem(item: WorldItem, items: WorldItem[]): number {
  const sys = itemSys(item);
  if (item.type === 'class') {
    return toNum(sys.levels);
  }
  const parent = items.find(
    (i) => i.type === 'class' && identifierOf(i) === str(sys.classIdentifier),
  );
  return parent ? toNum(itemSys(parent).levels) : 0;
}

function resolveScale(items: WorldItem[], itemId: string, scaleId: string, part: string) {
  for (const item of items) {
    if ((item.type !== 'class' && item.type !== 'subclass') || identifierOf(item) !== itemId) {
      continue;
    }
    for (const adv of advancementEntries(item)) {
      const cfg = adv.configuration;
      if (adv.type !== 'ScaleValue' || !isRec(cfg) || str(cfg.identifier) !== scaleId) {
        continue;
      }
      const v = scaleAt(cfg.scale, levelOfItem(item, items));
      if (!v) {
        return undefined;
      }
      if (cfg.type === 'dice') {
        const faces = toNum(v.faces);
        const number = v.number == null ? '' : String(toNum(v.number));
        switch (part) {
          case 'die':
            return `d${faces}`;
          case 'number':
            return number === '' ? 1 : Number(number);
          case 'faces':
            return faces;
          default:
            return `${number}d${faces}`;
        }
      }
      const raw = v.value;
      return typeof raw === 'number' || typeof raw === 'string' ? raw : undefined;
    }
  }
  return undefined;
}

export function abilityMod(score: unknown): number {
  return Math.floor((toNum(score) - 10) / 2);
}

/** Builds a resolver from an actor; `system` overrides actor.system (e.g. effect-adjusted data). */
export function buildRollContext(actor: WorldActor, system?: unknown): RollContext {
  const sys = system ?? actor.system;
  const items = itemsOf(actor);
  const classes = items.filter((i) => i.type === 'class');
  const totalLevel = classes.reduce((s, c) => s + toNum(itemSys(c).levels), 0);
  const cr = toNum(at(sys, 'details', 'cr'));
  const prof =
    totalLevel > 0
      ? Math.ceil(totalLevel / 4) + 1
      : cr > 0
        ? Math.ceil(cr / 4) + 1
        : toNum(at(sys, 'attributes', 'prof')) || undefined;

  return {
    lookup(path) {
      const p = path.split('.');
      if (p[0] === 'prof' || path === 'attributes.prof') {
        return prof;
      }
      if (p[0] === 'details' && p[1] === 'level' && p.length === 2) {
        return totalLevel > 0 ? totalLevel : undefined;
      }
      if (
        p[0] === 'abilities' &&
        p[2] === 'mod' &&
        p.length === 3 &&
        ABILITIES.includes(p[1] ?? '')
      ) {
        const ability = at(sys, 'abilities', p[1] as string);
        return isRec(ability) ? abilityMod(ability.value) : undefined;
      }
      if (p[0] === 'classes' && p[2] === 'levels' && p.length === 3) {
        const cls = classes.find((c) => identifierOf(c) === p[1]);
        return cls ? toNum(itemSys(cls).levels) : undefined;
      }
      if (p[0] === 'scale' && p.length >= 3) {
        return resolveScale(items, p[1] as string, p[2] as string, p[3] ?? '');
      }
      return undefined;
    },
  };
}

// --- Safe integer arithmetic (no eval) --------------------------------------

function evalArithmetic(expr: string): number | null {
  const s = expr.replace(/\s+/g, '');
  let i = 0;
  const peek = () => s[i];
  function primary(): number | null {
    if (peek() === '(') {
      i++;
      const v = sum();
      if (peek() !== ')') {
        return null;
      }
      i++;
      return v;
    }
    if (peek() === '-' || peek() === '+') {
      const neg = s[i++] === '-';
      const v = primary();
      return v === null ? null : neg ? -v : v;
    }
    const m = /^\d+(?:\.\d+)?/.exec(s.slice(i));
    if (!m) {
      return null;
    }
    i += m[0].length;
    return Number(m[0]);
  }
  function product(): number | null {
    let v = primary();
    while (v !== null && (peek() === '*' || peek() === '/')) {
      const op = s[i++];
      const r = primary();
      if (r === null) {
        return null;
      }
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function sum(): number | null {
    let v = product();
    while (v !== null && (peek() === '+' || peek() === '-')) {
      const op = s[i++];
      const r = product();
      if (r === null) {
        return null;
      }
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  const v = sum();
  return v !== null && i === s.length && Number.isFinite(v) ? v : null;
}

/**
 * Substitutes references in an effect value and evaluates it when it is a
 * plain integer expression. Never throws; unknown references are listed in
 * `unresolved` and left in the returned string.
 */
export function resolveValue(raw: unknown, ctx: RollContext): ResolvedValue {
  if (typeof raw === 'number') {
    return { value: raw, hasDice: false, unresolved: [] };
  }
  const input = typeof raw === 'string' ? raw.trim() : String(raw ?? '');
  const unresolved: string[] = [];
  const substituted = input.replace(REF, (ref) => {
    const v = ctx.lookup(ref.slice(1));
    if (v === undefined) {
      unresolved.push(ref);
      return ref;
    }
    return String(v);
  });
  if (unresolved.length > 0) {
    return { value: substituted, hasDice: DICE.test(substituted), unresolved };
  }
  const hasDice = DICE.test(substituted);
  if (!hasDice) {
    const n = evalArithmetic(substituted);
    if (n !== null) {
      return { value: Number.isInteger(n) ? n : Math.floor(n), hasDice: false, unresolved };
    }
  }
  return { value: substituted.replace(/\s+/g, ' '), hasDice, unresolved };
}
