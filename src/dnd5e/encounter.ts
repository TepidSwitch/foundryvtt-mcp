/**
 * @fileoverview Encounter budget tables and pure option selection (2024 rules)
 *
 * Numeric tables are rules facts, checked against the dnd5e 6.0.5 system
 * source (CONFIG.DND5E.CR_EXP_LEVELS and CONFIG.DND5E.ENCOUNTER_DIFFICULTY).
 * The 2024 DMG sums monster XP directly (no group multiplier) and compares the
 * total with the sum of the party's per-character budgets.
 *
 * Note: dnd5e's High column for levels 18-20 (14200, 17200, 22000) differs from
 * a commonly circulated list (13200, 15800, 19600); the system source is used.
 */

export type Difficulty = 'low' | 'moderate' | 'high';
export const DIFFICULTIES: readonly Difficulty[] = ['low', 'moderate', 'high'];

/** Per-character XP budget, index 0 = level 1. [low, moderate, high]. */
export const XP_BUDGET_BY_LEVEL: ReadonlyArray<readonly [number, number, number]> = [
  [50, 75, 100],
  [100, 150, 200],
  [150, 225, 400],
  [250, 375, 500],
  [500, 750, 1100],
  [600, 1000, 1400],
  [750, 1300, 1700],
  [1000, 1700, 2100],
  [1300, 2000, 2600],
  [1600, 2300, 3100],
  [1900, 2900, 4100],
  [2200, 3700, 4700],
  [2600, 4200, 5400],
  [2900, 4900, 6200],
  [3300, 5400, 7800],
  [3800, 6100, 9800],
  [4500, 7200, 11700],
  [5000, 8700, 14200],
  [5500, 10700, 17200],
  [6400, 13200, 22000],
];

/** XP for fractional challenge ratings; whole CRs are in CR_XP_WHOLE. */
const CR_XP_FRACTIONAL: Record<string, number> = { '0.125': 25, '0.25': 50, '0.5': 100 };

/** XP for CR 0..30 (dnd5e CR_EXP_LEVELS). */
const CR_XP_WHOLE: readonly number[] = [
  10, 200, 450, 700, 1100, 1800, 2300, 2900, 3900, 5000, 5900, 7200, 8400, 10000, 11500, 13000,
  15000, 18000, 20000, 22000, 25000, 33000, 41000, 50000, 62000, 75000, 90000, 105000, 120000,
  135000, 155000,
];

/** XP a creature of this CR is worth, or null for an unknown/out-of-range CR. */
export function crToXp(cr: number | null | undefined): number | null {
  if (cr === null || cr === undefined || !Number.isFinite(cr) || cr < 0 || cr > 30) {
    return null;
  }
  if (Number.isInteger(cr)) {
    return CR_XP_WHOLE[cr] ?? null;
  }
  return CR_XP_FRACTIONAL[String(cr)] ?? null;
}

/** Budget for one character level (clamped to 1-20) at a difficulty. */
export function budgetForLevel(level: number, difficulty: Difficulty): number {
  const idx = Math.min(20, Math.max(1, Math.round(level))) - 1;
  const row = XP_BUDGET_BY_LEVEL[idx] as readonly [number, number, number];
  return row[DIFFICULTIES.indexOf(difficulty)] as number;
}

/** Party budget: the sum of each member's budget. */
export function partyBudget(levels: number[], difficulty: Difficulty): number {
  return levels.reduce((sum, l) => sum + budgetForLevel(l, difficulty), 0);
}

export interface Candidate {
  /** Opaque key (e.g. Compendium UUID). */
  uuid: string;
  name: string;
  cr: number;
  xp: number;
}

const LEGACY_SUFFIX = /\s*\(legacy\)\s*$/i;

export function isLegacyName(name: string): boolean {
  return LEGACY_SUFFIX.test(name);
}

/**
 * Family key for near-duplicate detection: the name without parenthetical
 * qualifiers such as "(Legacy)" or "(Variant)", lowercased. "Cultist" and
 * "Aberrant Cultist" are different families (different statblocks); "Goblin"
 * and "Goblin (Legacy)" are the same one.
 */
export function baseName(name: string): string {
  return name
    .replace(/\s*\([^)]*\)/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Prefers 2024 statblocks: drops "X (Legacy)" when a non-legacy "X" exists.
 * A legacy entry with no current counterpart is kept. No-op when `keepLegacy`.
 */
export function dropLegacyDuplicates<T extends { name: string }>(
  items: T[],
  keepLegacy = false,
): T[] {
  if (keepLegacy) {
    return items;
  }
  const current = new Set(items.filter((i) => !isLegacyName(i.name)).map((i) => baseName(i.name)));
  return items.filter((i) => !isLegacyName(i.name) || !current.has(baseName(i.name)));
}

export interface EncounterEntry {
  candidate: Candidate;
  count: number;
}

export interface EncounterOption {
  kind: 'boss' | 'leader' | 'swarm';
  label: string;
  entries: EncounterEntry[];
  totalXp: number;
  creatureCount: number;
}

const byXpDescThenName = (a: Candidate, b: Candidate) =>
  b.xp - a.xp || a.name.localeCompare(b.name) || a.uuid.localeCompare(b.uuid);

/** Candidates sorted by xp desc, then name; among equal XP, `seed` rotates the winner. */
function sorted(candidates: Candidate[], seed: number): Candidate[] {
  const list = [...candidates].sort(byXpDescThenName);
  if (seed === 0) {
    return list;
  }
  // Shuffle within each equal-XP group with a seeded PRNG. A plain rotation by
  // `seed % size` kept small seeds on the alphabetically first names (seen live).
  const random = mulberry32(Math.trunc(seed));
  const out: Candidate[] = [];
  for (let i = 0; i < list.length; ) {
    let j = i;
    while (j < list.length && list[j]?.xp === list[i]?.xp) {
      j++;
    }
    const group = list.slice(i, j);
    for (let k = group.length - 1; k > 0; k--) {
      const r = Math.floor(random() * (k + 1));
      [group[k], group[r]] = [group[r] as Candidate, group[k] as Candidate];
    }
    out.push(...group);
    i = j;
  }
  return out;
}

/** Small deterministic PRNG (mulberry32): the same seed gives the same picks. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function finish(
  kind: EncounterOption['kind'],
  label: string,
  entries: EncounterEntry[],
): EncounterOption {
  return {
    kind,
    label,
    entries,
    totalXp: entries.reduce((s, e) => s + e.candidate.xp * e.count, 0),
    creatureCount: entries.reduce((s, e) => s + e.count, 0),
  };
}

/** Adds copies of the priciest candidate that still fits `remaining` and `slots`. */
function fill(
  pool: Candidate[],
  remaining: number,
  slots: number,
  exclude: Set<string>,
): EncounterEntry[] {
  const pick = pool.find((c) => !exclude.has(baseName(c.name)) && c.xp <= remaining);
  if (!pick || slots < 1) {
    return [];
  }
  const count = Math.min(slots, Math.floor(remaining / pick.xp));
  return [{ candidate: pick, count }];
}

/**
 * Builds up to three options, never exceeding `budget` or `maxCreatures`:
 * a boss (one big creature plus filler), a leader with lesser followers, and a
 * swarm of one creature type. Deterministic for the same inputs and seed.
 */
export function buildOptions(
  candidates: Candidate[],
  budget: number,
  maxCreatures: number,
  seed = 0,
): EncounterOption[] {
  const pool = sorted(
    candidates.filter((c) => c.xp > 0 && c.xp <= budget),
    seed,
  );
  if (pool.length === 0 || maxCreatures < 1) {
    return [];
  }
  const options: EncounterOption[] = [];

  // Boss: the priciest creature that fits, then filler with what is left.
  const boss = pool[0] as Candidate;
  const bossEntries: EncounterEntry[] = [{ candidate: boss, count: 1 }];
  bossEntries.push(
    ...fill(pool, budget - boss.xp, maxCreatures - 1, new Set([baseName(boss.name)])),
  );
  options.push(finish('boss', 'Boss', bossEntries));

  // Dedupe rule (all options): within one option a creature family (baseName)
  // appears as one pick only, so a variant or legacy twin never doubles up
  // with its sibling; distinct statblocks like Cultist / Aberrant Cultist are fine.
  // Leader + followers: leader at most half the budget, followers fill the rest.
  const leader = pool.find((c) => c.xp <= budget / 2 && baseName(c.name) !== baseName(boss.name));
  if (leader && maxCreatures >= 2) {
    const rest = budget - leader.xp;
    const follower = pool.find(
      (c) => c.xp <= leader.xp / 2 && c.xp <= rest && baseName(c.name) !== baseName(leader.name),
    );
    if (follower) {
      const count = Math.min(maxCreatures - 1, Math.floor(rest / follower.xp));
      options.push(
        finish('leader', 'Leader and minions', [
          { candidate: leader, count: 1 },
          { candidate: follower, count },
        ]),
      );
    }
  }

  // Swarm: one type, as many as fit; priciest type that still allows a real group.
  const wanted = Math.min(maxCreatures, 4);
  const swarm = pool.find((c) => Math.floor(budget / c.xp) >= wanted);
  if (swarm && wanted >= 2) {
    const count = Math.min(maxCreatures, Math.floor(budget / swarm.xp));
    options.push(finish('swarm', 'Swarm', [{ candidate: swarm, count }]));
  }

  // Drop options that repeat another one's creatures.
  const seen = new Set<string>();
  return options.filter((o) => {
    const key = o.entries
      .map((e) => `${e.candidate.uuid}x${e.count}`)
      .sort()
      .join('|');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
