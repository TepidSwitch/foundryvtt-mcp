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
    const swarm0 = buildOptions(pool, 200, 6, 0).find((o) => o.kind === 'swarm');
    const swarm1 = buildOptions(pool, 200, 6, 1).find((o) => o.kind === 'swarm');
    expect(swarm0?.entries[0]?.candidate.name).not.toBe(swarm1?.entries[0]?.candidate.name);
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
