import { describe, expect, it } from 'vitest';
import {
  budgetForLevel,
  buildOptions,
  type Candidate,
  crToXp,
  partyBudget,
  XP_BUDGET_BY_LEVEL,
} from '../encounter.js';

const c = (name: string, cr: number): Candidate => ({
  uuid: `Compendium.p.Actor.${name}`,
  name,
  cr,
  xp: crToXp(cr) as number,
});

describe('tables', () => {
  it('has 20 levels with increasing low <= moderate <= high', () => {
    expect(XP_BUDGET_BY_LEVEL).toHaveLength(20);
    for (const [lo, mid, hi] of XP_BUDGET_BY_LEVEL) {
      expect(lo).toBeLessThanOrEqual(mid);
      expect(mid).toBeLessThanOrEqual(hi);
    }
  });
  it('matches known values', () => {
    expect(budgetForLevel(1, 'low')).toBe(50);
    expect(budgetForLevel(5, 'moderate')).toBe(750);
    expect(budgetForLevel(20, 'high')).toBe(22000);
    expect(budgetForLevel(0, 'low')).toBe(50);
    expect(budgetForLevel(99, 'low')).toBe(6400);
  });
  it('sums per character', () => {
    expect(partyBudget([3, 3, 4, 4], 'moderate')).toBe(225 * 2 + 375 * 2);
    expect(partyBudget([], 'high')).toBe(0);
  });
  it('maps CR to XP', () => {
    expect(crToXp(0)).toBe(10);
    expect(crToXp(0.125)).toBe(25);
    expect(crToXp(0.25)).toBe(50);
    expect(crToXp(0.5)).toBe(100);
    expect(crToXp(1)).toBe(200);
    expect(crToXp(17)).toBe(18000);
    expect(crToXp(30)).toBe(155000);
    expect(crToXp(31)).toBeNull();
    expect(crToXp(null)).toBeNull();
    expect(crToXp(0.3)).toBeNull();
  });
});

describe('buildOptions', () => {
  const pool = [c('Goblin', 0.25), c('Ogre', 2), c('Troll', 5), c('Orc', 0.5), c('Wolf', 0.25)];

  it('never exceeds the budget or creature cap', () => {
    for (const budget of [50, 300, 750, 2000, 5000]) {
      for (const max of [1, 3, 6]) {
        for (const o of buildOptions(pool, budget, max)) {
          expect(o.totalXp).toBeLessThanOrEqual(budget);
          expect(o.creatureCount).toBeLessThanOrEqual(max);
        }
      }
    }
  });
  it('returns a boss, a leader group and a swarm for a roomy budget', () => {
    const kinds = buildOptions(pool, 1000, 6).map((o) => o.kind);
    expect(kinds).toEqual(['boss', 'leader', 'swarm']);
  });
  it('boss option uses the priciest fitting creature plus filler', () => {
    const [boss] = buildOptions(pool, 2000, 6);
    expect(boss?.entries[0]?.candidate.name).toBe('Troll');
    expect(boss?.totalXp).toBeLessThanOrEqual(2000);
  });
  it('is deterministic and seed picks among equal-XP creatures', () => {
    const a = JSON.stringify(buildOptions(pool, 400, 6));
    expect(JSON.stringify(buildOptions(pool, 400, 6))).toBe(a);
    const pick = (seed: number) =>
      buildOptions(pool, 200, 6, seed).find((o) => o.kind === 'swarm')?.entries[0]?.candidate.name;
    expect(pick(7)).toBe(pick(7));
    // Live finding: a rotation by `seed % size` kept small seeds on the first
    // names alphabetically. Small seeds must spread across the equal-XP group.
    const picks = new Set(Array.from({ length: 20 }, (_, i) => pick(i + 1)));
    expect(picks.size).toBeGreaterThan(1);
  });
  it('returns nothing when nothing fits', () => {
    expect(buildOptions(pool, 20, 6)).toEqual([]);
    expect(buildOptions([], 1000, 6)).toEqual([]);
    expect(buildOptions(pool, 1000, 0)).toEqual([]);
  });
  it('collapses duplicate options', () => {
    const only = buildOptions([c('Goblin', 0.25)], 100, 6);
    expect(only.length).toBe(1);
  });
});

describe('legacy and family rules', () => {
  it('drops "(Legacy)" only when a current twin exists', async () => {
    const { dropLegacyDuplicates } = await import('../encounter.js');
    const list = [
      { name: 'Ogre' },
      { name: 'Ogre (Legacy)' },
      { name: 'Hydra (Legacy)' },
      { name: 'Wolf' },
    ];
    expect(dropLegacyDuplicates(list).map((i) => i.name)).toEqual([
      'Ogre',
      'Hydra (Legacy)',
      'Wolf',
    ]);
    expect(dropLegacyDuplicates(list, true)).toHaveLength(4);
  });
  it('never picks two variants of one base creature in an option', () => {
    const pool = [c('Ogre', 2), c('Ogre (Legacy)', 2), c('Wolf', 0.25)];
    for (const o of buildOptions(pool, 1000, 6)) {
      const bases = o.entries.map((e) => e.candidate.name.replace(/ \(.*\)/, ''));
      expect(new Set(bases).size).toBe(bases.length);
    }
  });
  it('allows distinct statblocks that share a word', () => {
    const pool = [c('Troll', 5), c('Aberrant Cultist', 2), c('Cultist', 0.125)];
    const leader = buildOptions(pool, 3000, 6).find((o) => o.kind === 'leader');
    expect(leader?.entries.map((e) => e.candidate.name)).toEqual(['Aberrant Cultist', 'Cultist']);
  });
});
