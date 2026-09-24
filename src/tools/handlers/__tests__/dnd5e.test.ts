/**
 * @fileoverview Unit tests for dnd5e sheet derivation
 *
 * The world snapshot holds raw source data only; these tests pin the derived
 * values (level, HP, AC, slots, skills) and the tolerance for the data shapes
 * that changed between dnd5e 5.0, 5.1 (spell preparation), 5.3 (senses,
 * advancement object) and 6.0 (AC calcs list).
 */

import { describe, expect, it } from 'vitest';
import type { WorldActor, WorldItem } from '../../../foundry/types.js';
import {
  abilityMod,
  buildSheet,
  computeAc,
  computeHp,
  computeSpellcasting,
  formatCr,
  htmlToText,
  parseCr,
  proficiencyForLevel,
  sensesOf,
  spellPreparation,
  totalLevel,
} from '../dnd5e.js';

const MODS = { str: -1, dex: 3, con: 2, int: 0, wis: 0, cha: 4 };

function classItem(
  name: string,
  levels: number,
  opts: {
    hd?: string;
    progression?: string;
    ability?: string;
    hp?: Record<string, number | string>;
    identifier?: string;
  } = {},
): WorldItem {
  const hpValues = opts.hp ?? {};
  return {
    _id: `cls${name}`,
    name,
    type: 'class',
    system: {
      identifier: opts.identifier ?? name.toLowerCase(),
      levels,
      hd: { denomination: opts.hd ?? 'd8' },
      spellcasting: { progression: opts.progression ?? 'none', ability: opts.ability ?? '' },
      // dnd5e >=5.3 stores advancement as an object keyed by id, not an array
      advancement: { adv1: { _id: 'adv1', type: 'HitPoints', value: hpValues } },
    },
  };
}

function actor(over: Partial<WorldActor> & { system?: Record<string, unknown> } = {}): WorldActor {
  return {
    _id: 'actor000000000001',
    name: 'Test',
    type: 'character',
    system: {
      abilities: {
        str: { value: 8 },
        dex: { value: 14, proficient: 1 },
        con: { value: 16 },
        int: { value: 10 },
        wis: { value: 9 },
        cha: { value: 20, proficient: 1 },
      },
      attributes: { hp: { value: 11, max: null, temp: 10 }, ac: { calc: 'default' } },
      skills: {},
    },
    items: [],
    ...over,
  };
}

describe('basic rules helpers', () => {
  it('computes ability modifiers', () => {
    expect(abilityMod(8)).toBe(-1);
    expect(abilityMod(10)).toBe(0);
    expect(abilityMod(20)).toBe(5);
    expect(abilityMod(9)).toBe(-1);
  });

  it('computes proficiency bonus by level', () => {
    expect([1, 4, 5, 8, 9, 12, 13, 16, 17, 20].map(proficiencyForLevel)).toEqual([
      2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    ]);
  });

  it('parses and formats CR including fractions', () => {
    expect(parseCr('1/2')).toBe(0.5);
    expect(parseCr(15)).toBe(15);
    expect(parseCr('')).toBeNull();
    expect(formatCr(0.25)).toBe('1/4');
    expect(formatCr(15)).toBe('15');
    expect(formatCr(null)).toBe('?');
  });
});

describe('computeHp', () => {
  it('derives max HP from class hit-point advancement plus CON', () => {
    // Bard 10: level 1 = 13 (max d8 + stored), levels 2-10 = 4 each, CON +2 per level
    const hp: Record<string, number> = { '1': 13 };
    for (let l = 2; l <= 10; l++) {
      hp[String(l)] = 4;
    }
    const a = actor({ items: [classItem('Bard', 10, { hp })] });
    const result = computeHp(a, 2);
    expect(result).toMatchObject({ value: 11, temp: 10, max: 13 + 36 + 20, source: 'computed' });
  });

  it('handles "max" and "avg" advancement entries', () => {
    const a = actor({
      items: [classItem('Fighter', 2, { hd: 'd10', hp: { '1': 'max', '2': 'avg' } })],
    });
    // 10 (max) + 6 (avg of d10, rounded up) + CON +2 * 2 levels
    expect(computeHp(a, 2).max).toBe(10 + 6 + 4);
  });

  it('prefers a stored max over computing', () => {
    const a = actor({
      system: { attributes: { hp: { value: 50, max: 76, temp: 0 } } },
      items: [classItem('Fighter', 9)],
    });
    expect(computeHp(a, 2)).toMatchObject({ max: 76, source: 'stored' });
  });

  it('reports unknown max for an actor with no classes and no stored max', () => {
    expect(computeHp(actor(), 0)).toMatchObject({ max: null, source: 'unknown' });
  });
});

describe('computeAc', () => {
  const armor = (name: string, kind: string, value: number, extra: Record<string, unknown> = {}) =>
    ({
      _id: `arm${name}`,
      name,
      type: 'equipment',
      system: { equipped: true, type: { value: kind }, armor: { value, ...extra } },
    }) as WorldItem;

  it('is 10 + DEX when unarmored', () => {
    expect(computeAc(actor(), MODS)).toMatchObject({ value: 13 });
  });

  it('ignores armor that is not equipped', () => {
    const a = actor({
      items: [
        {
          ...armor('Leather', 'light', 11),
          system: { equipped: false, type: { value: 'light' }, armor: { value: 11 } },
        },
      ],
    });
    expect(computeAc(a, MODS).value).toBe(13);
  });

  it('applies armor base, caps DEX for medium armor, and adds a shield', () => {
    const a = actor({
      items: [armor('Half Plate', 'medium', 15), armor('Shield', 'shield', 2)],
    });
    // 15 + min(DEX+3, 2) + 2 shield
    expect(computeAc(a, MODS).value).toBe(19);
  });

  it('gives heavy armor no DEX bonus', () => {
    const a = actor({ items: [armor('Plate', 'heavy', 18)] });
    expect(computeAc(a, MODS).value).toBe(18);
  });

  it('computes Unarmored Defense for a barbarian', () => {
    const a = actor({ system: { attributes: { ac: { calc: 'unarmoredBarb' } } } });
    expect(computeAc(a, MODS)).toMatchObject({ value: 10 + 3 + 2 });
  });

  it('uses the stored value for natural armor', () => {
    const a = actor({ type: 'npc', system: { attributes: { ac: { calc: 'natural', flat: 19 } } } });
    expect(computeAc(a, MODS)).toMatchObject({ value: 19 });
  });

  it('picks the best of a dnd5e 6.0 `ac.calcs` list', () => {
    const a = actor({
      system: { attributes: { ac: { calc: 'default', calcs: ['default', 'unarmoredBarb'] } } },
    });
    expect(computeAc(a, MODS).value).toBe(15);
  });
});

describe('computeSpellcasting', () => {
  it('gives a 10th-level full caster the right slots and save DC', () => {
    const a = actor({
      system: {
        attributes: { spellcasting: 'cha' },
        spells: {
          spell1: { value: 4 },
          spell2: { value: 3 },
          spell3: { value: 1 },
          spell4: { value: 2 },
          spell5: { value: 1 },
        },
      },
      items: [classItem('Bard', 10, { progression: 'full', ability: 'cha' })],
    });
    const sc = computeSpellcasting(a, MODS, 4);
    expect(sc.slots.map((s) => s.max)).toEqual([4, 3, 3, 3, 2]);
    expect(sc.slots.map((s) => s.value)).toEqual([4, 3, 1, 2, 1]);
    expect(sc.dc).toBe(8 + 4 + 4);
    expect(sc.attack).toBe(8);
  });

  it('computes warlock pact slots separately', () => {
    const a = actor({ items: [classItem('Warlock', 10, { progression: 'pact', ability: 'cha' })] });
    const sc = computeSpellcasting(a, MODS, 4);
    expect(sc.slots).toEqual([]);
    expect(sc.pact).toMatchObject({ max: 2, level: 5 });
  });

  it('rounds a lone half caster up and an artificer up', () => {
    const artificer = actor({
      items: [classItem('Artificer', 9, { progression: 'artificer', ability: 'int' })],
    });
    // caster level ceil(9/2) = 5 → 4/3/2
    expect(computeSpellcasting(artificer, MODS, 4).slots.map((s) => s.max)).toEqual([4, 3, 2]);
    const paladin = actor({
      items: [classItem('Paladin', 5, { progression: 'half', ability: 'cha' })],
    });
    // single half caster: ceil(5/2) = 3 → 4/2
    expect(computeSpellcasting(paladin, MODS, 3).slots.map((s) => s.max)).toEqual([4, 2]);
  });

  it('rounds half casters down when multiclassed', () => {
    const a = actor({
      items: [
        classItem('Wizard', 5, { progression: 'full', ability: 'int' }),
        classItem('Paladin', 5, { progression: 'half', ability: 'cha' }),
      ],
    });
    // caster level 5 + floor(5/2) = 7 → 4/3/3/1
    expect(computeSpellcasting(a, MODS, 4).slots.map((s) => s.max)).toEqual([4, 3, 3, 1]);
  });

  it('reads third-caster progression from a subclass', () => {
    const fighter = classItem('Fighter', 7, { identifier: 'fighter' });
    const eldritchKnight: WorldItem = {
      _id: 'sub1',
      name: 'Eldritch Knight',
      type: 'subclass',
      system: {
        classIdentifier: 'fighter',
        spellcasting: { progression: 'third', ability: 'int' },
      },
    };
    const a = actor({ items: [fighter, eldritchKnight] });
    // ceil(7/3) = 3 → 4/2
    expect(computeSpellcasting(a, MODS, 3).slots.map((s) => s.max)).toEqual([4, 2]);
  });
});

describe('totalLevel and buildSheet', () => {
  it('sums levels across classes', () => {
    const a = actor({ items: [classItem('Fighter', 3), classItem('Rogue', 2)] });
    expect(totalLevel(a)).toBe(5);
  });

  it('computes save and skill totals with proficiency and expertise', () => {
    const a = actor({
      system: {
        abilities: {
          str: { value: 8 },
          dex: { value: 14, proficient: 1 },
          con: { value: 16 },
          int: { value: 10 },
          wis: { value: 9 },
          cha: { value: 20, proficient: 1 },
        },
        attributes: { hp: { value: 1, max: null }, ac: { calc: 'default' } },
        skills: {
          acr: { value: 1, ability: 'dex' },
          prf: { value: 2, ability: 'cha' },
          ani: { value: 0.5, ability: 'wis' },
        },
      },
      items: [classItem('Bard', 10, { progression: 'full', ability: 'cha' })],
    });
    const sheet = buildSheet(a);
    expect(sheet.level).toBe(10);
    expect(sheet.prof).toBe(4);
    expect(sheet.saves.dex).toEqual({ total: 2 + 4, proficient: true });
    expect(sheet.saves.str).toEqual({ total: -1, proficient: false });
    const skill = (k: string) => sheet.skills.find((s) => s.key === k);
    expect(skill('acr')?.total).toBe(2 + 4);
    expect(skill('prf')?.total).toBe(5 + 8); // expertise doubles proficiency
    expect(skill('ani')?.total).toBe(-1 + 2); // half proficiency floors: floor(4*0.5)
    expect(skill('prc')?.passive).toBe(9); // untrained: 10 + WIS(-1)
  });

  it('applies Jack of All Trades to untrained skills', () => {
    const a = actor({
      flags: { dnd5e: { jackOfAllTrades: true } },
      items: [classItem('Bard', 10)],
    });
    expect(buildSheet(a).skills.find((s) => s.key === 'ath')?.total).toBe(-1 + 2);
  });

  it('uses CR for an NPC proficiency bonus', () => {
    const a = actor({
      type: 'npc',
      system: {
        details: { cr: 15 },
        attributes: { hp: { value: 212, max: 212 }, ac: { calc: 'natural', flat: 19 } },
        abilities: {},
      },
    });
    expect(buildSheet(a).prof).toBe(5);
  });
});

describe('spellPreparation', () => {
  const spell = (system: Record<string, unknown>): WorldItem => ({
    _id: 's1',
    name: 'Test',
    type: 'spell',
    system,
  });

  it('reads the legacy preparation.mode shape (data not yet migrated)', () => {
    expect(
      spellPreparation(spell({ level: 3, preparation: { mode: 'always', prepared: false } })).state,
    ).toBe('always prepared');
    expect(
      spellPreparation(spell({ level: 3, preparation: { mode: 'prepared', prepared: true } }))
        .state,
    ).toBe('prepared');
    expect(
      spellPreparation(spell({ level: 3, preparation: { mode: 'prepared', prepared: false } }))
        .state,
    ).toBe('not prepared');
  });

  it('reads the dnd5e 5.1+ method + numeric prepared shape', () => {
    expect(spellPreparation(spell({ level: 2, method: 'spell', prepared: 2 })).state).toBe(
      'always prepared',
    );
    expect(spellPreparation(spell({ level: 2, method: 'spell', prepared: 1 })).state).toBe(
      'prepared',
    );
    expect(spellPreparation(spell({ level: 2, method: 'spell', prepared: 0 })).state).toBe(
      'not prepared',
    );
  });

  it('labels cantrips, innate, at-will and pact spells', () => {
    expect(spellPreparation(spell({ level: 0 })).state).toBe('cantrip');
    expect(spellPreparation(spell({ level: 1, method: 'innate', prepared: 0 })).state).toBe(
      'innate',
    );
    expect(spellPreparation(spell({ level: 1, method: 'atwill' })).state).toBe('at will');
    expect(spellPreparation(spell({ level: 5, method: 'pact', prepared: 0 })).state).toBe(
      'pact magic',
    );
  });
});

describe('sensesOf', () => {
  it('reads the flat (<=5.2) shape', () => {
    const a = actor({
      system: { attributes: { senses: { darkvision: 60, blindsight: 0, units: 'ft' } } },
    });
    expect(sensesOf(a)).toEqual([{ name: 'darkvision', range: 60 }]);
  });

  it('reads the senses.ranges (>=5.3) shape', () => {
    const a = actor({
      system: {
        attributes: { senses: { ranges: { darkvision: 120, tremorsense: 30 }, units: 'ft' } },
      },
    });
    expect(sensesOf(a)).toEqual([
      { name: 'darkvision', range: 120 },
      { name: 'tremorsense', range: 30 },
    ]);
  });
});

describe('htmlToText', () => {
  it('strips tags, keeps paragraph breaks and resolves enrichers', () => {
    const html =
      '<p>Deal <strong>2d6</strong> &amp; roll [[/r 1d4]] to @UUID[Item.x]{Bless}.</p><p>Second</p>';
    expect(htmlToText(html)).toBe('Deal 2d6 & roll 1d4 to Bless.\nSecond');
  });

  it('cleans 2024 monster stat-block enrichers that only resolve inside Foundry', () => {
    expect(
      htmlToText(
        '<p>The [[lookup @name lowercase]]{monster} makes three [[/item .mmRend0000000000]] attacks.</p>',
      ),
    ).toBe('The monster makes three Rend attacks.');
    expect(htmlToText('<p>[[/attack extended]]. [[/damage average extended]].</p>')).toBe(
      '[attack roll]. [damage].',
    );
    expect(
      htmlToText(
        '<p>DC [[lookup @save.dc.value activity=bDqgmtLG3zcVuqdi]], each [[lookup @target.affects.type activity=bDqgmtLG3zcVuqdi]]</p>',
      ),
    ).toBe('DC [save DC], each target');
  });

  it('resolves entity-encoded reference enrichers and drops embeds', () => {
    expect(
      htmlToText('<p>Wisdom (&amp;Reference[prc]{Perception}) checks @Embed[Compendium.x.y]</p>'),
    ).toBe('Wisdom (Perception) checks');
  });

  it('returns an empty string for non-strings', () => {
    expect(htmlToText(undefined)).toBe('');
  });
});
