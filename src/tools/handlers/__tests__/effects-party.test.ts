/**
 * @fileoverview Unit tests for active-effect evaluation and the party-wide tools
 */

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import type { WorldActor, WorldData, WorldItem } from '../../../foundry/types.js';
import { sheetFor } from '../character.js';
import { applyEffects, buildEffectiveSheet } from '../effects.js';
import { handleCompareParty, handleFindInParty } from '../party.js';

const text = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content[0]?.text ?? '';

type Change = { key: string; type: string; value: unknown; priority?: number };

/** A v14-style effect: changes live at system.changes. */
function effect(name: string, changes: Change[], over: Record<string, unknown> = {}) {
  return {
    _id: `fx${name}`.slice(0, 16),
    name,
    type: 'base',
    disabled: false,
    transfer: false,
    statuses: [] as string[],
    system: { changes: changes.map((c) => ({ priority: 20, ...c })) },
    ...over,
  };
}

function classItem(name: string, levels: number, spent = 0): WorldItem {
  return {
    _id: `cls${name}`,
    name,
    type: 'class',
    system: {
      identifier: name.toLowerCase(),
      levels,
      hd: { denomination: 'd10', spent },
      spellcasting: { progression: 'none' },
      advancement: { a: { type: 'HitPoints', value: { '1': 10 } } },
    },
  };
}

function actor(over: Partial<WorldActor> & Record<string, unknown> = {}): WorldActor {
  return {
    _id: 'aaaaaaaaaaaaaaaa',
    name: 'Fighter',
    type: 'character',
    system: {
      abilities: {
        str: { value: 16 },
        dex: { value: 14 },
        con: { value: 14 },
        int: { value: 10 },
        wis: { value: 10 },
        cha: { value: 10 },
      },
      attributes: {
        hp: { value: 30, max: null, temp: 0 },
        ac: { calc: 'default' },
        movement: { walk: 30, fly: 0, units: 'ft' },
        senses: { darkvision: 0, units: 'ft' },
      },
      traits: { dr: { value: [] } },
      skills: {},
    },
    items: [classItem('Fighter', 5)],
    effects: [],
    ...over,
  } as WorldActor;
}

const gear = (name: string, system: Record<string, unknown>, effects: unknown[]): WorldItem =>
  ({
    _id: `it${name}`.slice(0, 16),
    name,
    type: 'equipment',
    system,
    effects,
  }) as unknown as WorldItem;

describe('applyEffects', () => {
  it('applies transfer effects from feats (fighting style +1 AC, +10 speed)', () => {
    const a = actor({
      items: [
        classItem('Fighter', 5),
        {
          _id: 'ft1',
          name: 'Defense',
          type: 'feat',
          system: {},
          effects: [
            effect('Defense', [{ key: 'system.attributes.ac.bonus', type: 'add', value: 1 }], {
              transfer: true,
            }),
          ],
        },
        {
          _id: 'ft2',
          name: 'Fast Movement',
          type: 'feat',
          system: {},
          effects: [
            effect(
              'Fast Movement',
              [{ key: 'system.attributes.movement.walk', type: 'add', value: 10 }],
              { transfer: true },
            ),
          ],
        },
      ] as WorldItem[],
    });
    const { actor: out, summary } = applyEffects(a);
    expect(out.system).toMatchObject({ attributes: { ac: { bonus: 1 }, movement: { walk: 40 } } });
    expect(summary.applied).toEqual(['Defense: AC +1', 'Fast Movement: walk speed +10']);
    // the input actor is not mutated
    expect(a.system).toMatchObject({ attributes: { movement: { walk: 30 } } });
  });

  it('ignores disabled, non-transfer, unequipped and un-attuned item effects', () => {
    const bonus = [{ key: 'system.attributes.ac.bonus', type: 'add', value: 2 }];
    const a = actor({
      items: [
        classItem('Fighter', 5),
        gear('Disabled Ring', { equipped: true }, [
          effect('r', bonus, { transfer: true, disabled: true }),
        ]),
        gear('Spell-ish', { equipped: true }, [effect('s', bonus, { transfer: false })]),
        gear('Stowed Cloak', { equipped: false }, [effect('c', bonus, { transfer: true })]),
        gear('Unattuned Boots', { equipped: true, attunement: 'required', attuned: false }, [
          effect('b', bonus, { transfer: true }),
        ]),
      ] as WorldItem[],
    });
    expect(applyEffects(a).summary.applied).toEqual([]);
  });

  it('applies gear once it is equipped and attuned', () => {
    const a = actor({
      items: [
        classItem('Fighter', 5),
        gear('Cloak of Protection', { equipped: true, attunement: 'required', attuned: true }, [
          effect(
            'Cloak of Protection',
            [{ key: 'system.attributes.ac.bonus', type: 'add', value: '+1' }],
            { transfer: true },
          ),
        ]),
      ] as WorldItem[],
    });
    expect(applyEffects(a).summary.applied).toEqual(['Cloak of Protection: AC +1']);
  });

  it('applies effects that are on the actor now (a cast Shield spell)', () => {
    const a = actor({
      effects: [
        effect('Shield', [{ key: 'system.attributes.ac.bonus', type: 'add', value: '+5' }]),
      ],
    });
    expect(applyEffects(a).actor.system).toMatchObject({ attributes: { ac: { bonus: 5 } } });
  });

  it('handles upgrade/override/multiply and the "all speeds" custom change', () => {
    const a = actor({
      effects: [
        effect('Fly', [{ key: 'system.attributes.movement.fly', type: 'upgrade', value: 60 }]),
        effect('Spider Climb', [
          {
            key: 'system.attributes.movement.climb',
            type: 'upgrade',
            value: '@attributes.movement.walk',
          },
        ]),
        effect('Longstrider', [
          { key: 'system.attributes.movement.all', type: 'custom', value: '+10' },
        ]),
      ],
    });
    const m = applyEffects(a).actor.system as { attributes: { movement: Record<string, number> } };
    // fly 0→60, climb → walk (30), then +10 to every non-zero mode
    expect(m.attributes.movement).toMatchObject({ walk: 40, fly: 70, climb: 40 });
  });

  it('adds ability score changes, resistances, senses and max HP', () => {
    const a = actor({
      effects: [
        effect('Belt', [{ key: 'system.abilities.str.value', type: 'upgrade', value: 21 }]),
        effect('Resistance', [{ key: 'system.traits.dr.value', type: 'add', value: 'fire' }]),
        effect('Darkvision', [
          { key: 'system.attributes.senses.darkvision', type: 'upgrade', value: 60 },
        ]),
        effect('Aid', [{ key: 'system.attributes.hp.tempmax', type: 'add', value: 5 }]),
      ],
    });
    const s = applyEffects(a).actor.system as Record<string, any>;
    expect(s.abilities.str.value).toBe(21);
    expect(s.traits.dr.value).toEqual(['fire']);
    expect(s.attributes.senses.darkvision).toBe(60);
    expect(s.attributes.hp.tempmax).toBe(5);
  });

  it('resolves formula bonuses and counts non-system changes as unresolved', () => {
    const a = actor({
      effects: [
        effect('Bless', [{ key: 'system.bonuses.abilities.save', type: 'add', value: '+1d4' }]),
        effect('Evasive', [
          { key: 'system.abilities.dex.bonuses.save', type: 'add', value: '@abilities.int.mod' },
        ]),
        effect('Light', [{ key: 'ATL.light.dim', type: 'override', value: 20 }]),
      ],
    });
    const { summary } = applyEffects(a);
    expect(summary.applied).toEqual(['Bless: saves +1d4', 'Evasive: DEX saves +0']);
    expect(summary.unresolved).toBe(1);
  });

  it('reads the legacy `changes` array with numeric modes', () => {
    const a = actor({
      effects: [
        {
          _id: 'legacyeffect0001',
          name: 'Old Haste',
          disabled: false,
          changes: [{ key: 'system.attributes.ac.bonus', mode: 2, value: '+2', priority: 20 }],
        },
      ] as unknown as WorldActor['effects'],
    });
    expect(applyEffects(a).summary.applied).toEqual(['Old Haste: AC +2']);
  });

  it('skips enchantment effects (they modify items, not the actor)', () => {
    const a = actor({
      effects: [
        effect('Enchant', [{ key: 'system.attributes.ac.bonus', type: 'add', value: 9 }], {
          type: 'enchantment',
        }),
      ],
    });
    expect(applyEffects(a).summary.applied).toEqual([]);
  });
});

describe('buildEffectiveSheet', () => {
  it('reflects an AC bonus and effect-driven speed in the sheet', () => {
    const a = actor({
      effects: [
        effect('Shield', [{ key: 'system.attributes.ac.bonus', type: 'add', value: '+5' }]),
        effect('Concentrating: Bless', [], { statuses: ['concentrating'] }),
      ],
    });
    const sheet = buildEffectiveSheet(a);
    // 10 + DEX(+2) + 5
    expect(sheet.ac.value).toBe(17);
    expect(sheet.ac.detail).toContain('+5 bonus');
    expect(sheet.effects.current.map((e) => e.name)).toEqual(['Shield', 'Concentrating: Bless']);
  });
});

// --- party tools ---------------------------------------------------------

const fighter = actor({ _id: 'fighterfighter01', name: 'Fighter' });
const wizard = actor({
  _id: 'wizardwizardwiz1',
  name: 'Wizard',
  system: {
    ...(fighter.system as object),
    abilities: { ...(fighter.system as any).abilities, int: { value: 18 }, dex: { value: 16 } },
    attributes: {
      hp: { value: 5, max: 25, temp: 0 },
      ac: { calc: 'default' },
      movement: { walk: 30 },
    },
    skills: { ste: { value: 2, ability: 'dex' } },
  },
  items: [
    {
      ...classItem('Wizard', 5),
      system: {
        ...classItem('Wizard', 5).system,
        hd: { denomination: 'd6', spent: 2 },
        spellcasting: { progression: 'full', ability: 'int' },
      },
    },
    {
      _id: 'spellcounter0001',
      name: 'Counterspell',
      type: 'spell',
      system: { level: 3, preparation: { mode: 'prepared', prepared: true } },
    },
    {
      _id: 'potion000000001a',
      name: 'Potion of Healing',
      type: 'consumable',
      system: { quantity: 3 },
    },
  ] as WorldItem[],
});
const rogueNoOwner = actor({ _id: 'rogueroguerogue1', name: 'Retired Rogue' });

const snapshot = {
  actors: [fighter, wizard, rogueNoOwner],
  users: [
    { _id: 'u1', name: 'Alex', role: 2, color: '#fff', character: 'fighterfighter01' },
    { _id: 'u2', name: 'Jen', role: 2, color: '#fff', character: 'wizardwizardwiz1' },
  ],
} as unknown as WorldData;
const client = { getWorldSnapshot: () => snapshot } as unknown as FoundryClient;

describe('handleFindInParty', () => {
  it('lists who has a spell or item with details', async () => {
    const out = text(await handleFindInParty({ query: 'counterspell' }, client));
    expect(out).toContain('1 of 2 characters');
    expect(out).toContain('Wizard');
    expect(out).toContain('(Jen)');
    expect(out).toContain('level 3 spell, prepared');
    expect(out).not.toContain('Retired Rogue');
  });

  it('shows quantities and honours the type filter', async () => {
    expect(text(await handleFindInParty({ query: 'potion' }, client))).toContain('×3');
    expect(text(await handleFindInParty({ query: 'potion', type: 'spell' }, client))).toContain(
      'Nobody has a matching item',
    );
  });

  it('can include unassigned characters and rejects bad input', async () => {
    const out = text(await handleFindInParty({ query: 'fighter', scope: 'all' }, client));
    expect(out).toContain('of 3 actors');
    await expect(handleFindInParty({}, client)).rejects.toThrow(McpError);
    await expect(handleFindInParty({ query: 'x', scope: 'galaxy' }, client)).rejects.toThrow(
      McpError,
    );
  });
});

describe('handleCompareParty', () => {
  it('ranks by HP with the most hurt first', async () => {
    const out = text(await handleCompareParty({ stat: 'hp' }, client));
    expect(out.indexOf('Wizard')).toBeLessThan(out.indexOf('Fighter'));
    expect(out).toContain('most hurt first');
    expect(out).toContain('5/25 (20%)');
  });

  it('ranks by a skill and reports expertise', async () => {
    const out = text(await handleCompareParty({ stat: 'skill:stealth' }, client));
    expect(out.indexOf('Wizard')).toBeLessThan(out.indexOf('Fighter'));
    expect(out).toContain('(expertise)');
  });

  it('skips characters without the stat and rejects unknown stats', async () => {
    const out = text(await handleCompareParty({ stat: 'spell_dc' }, client));
    expect(out).toContain('Wizard');
    expect(out).toContain('1 without this stat');
    await expect(handleCompareParty({ stat: 'charisma-ish' }, client)).rejects.toThrow(McpError);
  });
});

describe('sheet output', () => {
  it('shows hit dice, active effects and applied bonuses', () => {
    const a = actor({
      items: [classItem('Fighter', 5, 2)],
      effects: [
        effect('Shield', [{ key: 'system.attributes.ac.bonus', type: 'add', value: '+5' }]),
        effect('Concentrating: Bless', [], { statuses: ['concentrating'] }),
      ],
    });
    const out = sheetFor(client, a);
    expect(out).toContain('**Hit dice** 3/5 d10');
    expect(out).toContain('**Active effects** Shield · Concentrating: Bless');
    expect(out).toContain('**Effect bonuses applied** Shield: AC +5');
    expect(out).toContain('active-effect changes applied');
  });

  it('shows death saves at 0 HP', () => {
    const a = actor();
    (a.system as any).attributes.hp.value = 0;
    (a.system as any).attributes.death = { success: 2, failure: 1 };
    expect(sheetFor(client, a)).toContain('**Death saves** 2 successes · 1 failures');
  });
});
