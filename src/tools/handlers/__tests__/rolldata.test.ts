/**
 * @fileoverview Tests for the headless roll-data resolver and formula/roll-mode effects
 */

import { describe, expect, it } from 'vitest';
import type { WorldActor, WorldItem } from '../../../foundry/types.js';
import { sheetFor } from '../character.js';
import { applyEffects } from '../effects.js';
import { buildRollContext, resolveValue } from '../rolldata.js';

const barbarian: WorldItem = {
  _id: 'cls1',
  name: 'Barbarian',
  type: 'class',
  system: {
    identifier: 'barbarian',
    levels: 10,
    hd: { denomination: 'd12', spent: 0 },
    advancement: {
      a: {
        type: 'ScaleValue',
        configuration: {
          identifier: 'rage-damage',
          type: 'number',
          scale: { '1': { value: 2 }, '9': { value: 3 }, '16': { value: 4 } },
        },
      },
      b: {
        type: 'ScaleValue',
        configuration: {
          identifier: 'brutal-strike',
          type: 'dice',
          scale: { '9': { number: 1, faces: 10, modifiers: [] } },
        },
      },
    },
  },
};
const berserker: WorldItem = {
  _id: 'sub1',
  name: 'Berserker',
  type: 'subclass',
  system: {
    identifier: 'berserker',
    classIdentifier: 'barbarian',
    advancement: [
      {
        type: 'ScaleValue',
        configuration: {
          identifier: 'frenzy',
          type: 'number',
          scale: { '3': { value: 1 }, '11': { value: 2 } },
        },
      },
    ],
  },
};

function actor(effects: unknown[] = []): WorldActor {
  return {
    _id: 'aaaaaaaaaaaaaaaa',
    name: 'Dande',
    type: 'character',
    system: {
      abilities: {
        str: { value: 18 },
        dex: { value: 14 },
        con: { value: 14 },
        int: { value: 10 },
        wis: { value: 10 },
        cha: { value: 10 },
      },
      attributes: { hp: { value: 50, max: 50 }, ac: {}, movement: { walk: 30 } },
      details: {},
      traits: { dr: { value: [] } },
    },
    items: [barbarian, berserker],
    effects,
  } as unknown as WorldActor;
}

const fx = (name: string, changes: Array<Record<string, unknown>>) => ({
  _id: `fx${name}`.slice(0, 16),
  name,
  type: 'base',
  disabled: false,
  statuses: [],
  system: { changes: changes.map((c) => ({ priority: 20, type: 'add', ...c })) },
});

describe('resolveValue', () => {
  const ctx = buildRollContext(actor());

  it('resolves a number scale at the class level', () => {
    expect(resolveValue('@scale.barbarian.rage-damage', ctx)).toMatchObject({
      value: 3,
      hasDice: false,
    });
  });
  it('resolves dice scales and their parts', () => {
    expect(resolveValue('@scale.barbarian.brutal-strike', ctx).value).toBe('1d10');
    expect(resolveValue('@scale.barbarian.brutal-strike.die', ctx).value).toBe('d10');
    expect(resolveValue('@scale.barbarian.brutal-strike.faces', ctx).value).toBe(10);
    expect(resolveValue('@scale.barbarian.brutal-strike.number', ctx).value).toBe(1);
  });
  it('resolves subclass scales using the parent class level', () => {
    expect(resolveValue('@scale.berserker.frenzy', ctx).value).toBe(1);
  });
  it('resolves prof, ability mods, level and class levels and evaluates arithmetic', () => {
    expect(resolveValue('@prof', ctx).value).toBe(4);
    expect(resolveValue('@attributes.prof', ctx).value).toBe(4);
    expect(resolveValue('@abilities.str.mod + 2', ctx).value).toBe(6);
    expect(resolveValue('@details.level', ctx).value).toBe(10);
    expect(resolveValue('@classes.barbarian.levels', ctx).value).toBe(10);
    expect(resolveValue('2 + 4', ctx).value).toBe(6);
  });
  it('keeps dice as a formula string', () => {
    expect(resolveValue('1d4 + @abilities.str.mod', ctx)).toMatchObject({
      value: '1d4 + 4',
      hasDice: true,
    });
  });
  it('reports unknown references without throwing', () => {
    const r = resolveValue('@scale.rogue.sneak-attack + @nonsense.x', ctx);
    expect(r.unresolved).toEqual(['@scale.rogue.sneak-attack', '@nonsense.x']);
  });
  it('picks the level-1 scale below the next threshold', () => {
    const low = buildRollContext({
      ...actor(),
      items: [{ ...barbarian, system: { ...(barbarian.system as object), levels: 5 } }],
    } as WorldActor);
    expect(resolveValue('@scale.barbarian.rage-damage', low).value).toBe(2);
  });
});

describe('formula and roll-mode effects', () => {
  const rage = fx('Rage', [
    { key: 'system.bonuses.mwak.damage', value: '@scale.barbarian.rage-damage' },
    { key: 'system.traits.dr.value', value: 'piercing' },
    { key: 'system.abilities.str.save.roll.mode', value: '1' },
    { key: 'system.abilities.str.check.roll.mode', value: '1' },
    { key: 'macro.tokenMagic', type: 'custom', value: 'outline' },
  ]);
  const bless = fx('Bless', [
    { key: 'system.bonuses.abilities.save', value: '+1d4' },
    { key: 'system.bonuses.mwak.attack', value: '1d4' },
  ]);

  it('applies resolved bonuses and grouped roll modes', () => {
    const { summary } = applyEffects(
      actor([rage, bless, fx('Feral', [{ key: 'system.attributes.init.roll.mode', value: 1 }])]),
    );
    expect(summary.applied).toContain('Rage: melee weapon damage +3');
    expect(summary.applied).toContain('Rage: advantage on STR checks and saves');
    expect(summary.applied).toContain('Bless: saves +1d4');
    expect(summary.applied).toContain('Bless: melee weapon attack +1d4');
    expect(summary.applied).toContain('Feral: advantage on initiative');
    expect(summary.unresolved).toBe(1); // macro.tokenMagic
  });

  it('counts unresolvable references instead of showing them', () => {
    const { summary } = applyEffects(
      actor([fx('X', [{ key: 'system.bonuses.mwak.damage', value: '@scale.rogue.sneak-attack' }])]),
    );
    expect(summary.applied).toEqual([]);
    expect(summary.unresolved).toBe(1);
  });

  it('shows them on the sheet with the new footer', () => {
    const out = sheetFor(
      { getWorldSnapshot: () => ({ users: [] }) } as never,
      actor([rage, bless]),
    );
    console.log(
      out
        .split('\n')
        .filter((l) => /Effect bonuses|Computed/.test(l))
        .join('\n'),
    );
    expect(out).toContain('Rage: melee weapon damage +3');
    expect(out).toContain('advantage on STR checks and saves');
    expect(out).toContain('Bless: saves +1d4');
    expect(out).not.toContain('Dice and formula bonuses');
  });
});
