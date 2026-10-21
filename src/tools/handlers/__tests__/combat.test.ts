/**
 * @fileoverview Unit tests for combat handler — get_combat_state
 */

import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import type { WorldActor, WorldCombat } from '../../../foundry/types.js';
import { handleGetCombatState } from '../combat.js';

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? '';
}

type Combatant = WorldCombat['combatants'][number];

function buildCombatant(overrides: Partial<Combatant> = {}): Combatant {
  return {
    _id: 'c1',
    name: 'Goblin',
    initiative: 10,
    hidden: false,
    defeated: false,
    ...overrides,
  };
}

function buildCombat(overrides: Partial<WorldCombat> = {}): WorldCombat {
  return {
    _id: 'combat-1',
    active: true,
    round: 1,
    turn: 0,
    started: true,
    combatants: [],
    ...overrides,
  };
}

describe('handleGetCombatState', () => {
  it('returns "No active combat encounter." when no combat exists', async () => {
    const client = {
      getCombatState: vi.fn().mockReturnValue(null),
    } as unknown as FoundryClient;

    const result = await handleGetCombatState({}, client);
    const text = getText(result);

    expect(text).toBe('No active combat encounter.');
    expect(client.getCombatState).toHaveBeenCalled();
  });

  it('formats active combat with combatants sorted by initiative desc', async () => {
    const combat = buildCombat({
      round: 3,
      turn: 0,
      combatants: [
        buildCombatant({ _id: 'a', name: 'Bob', initiative: 5 }),
        buildCombatant({ _id: 'b', name: 'Alice', initiative: 18 }),
        buildCombatant({ _id: 'c', name: 'Charlie', initiative: 12 }),
      ],
    });
    const client = {
      getCombatState: vi.fn().mockReturnValue(combat),
      getRawActor: vi.fn().mockReturnValue(undefined),
    } as unknown as FoundryClient;

    const result = await handleGetCombatState({}, client);
    const text = getText(result);

    expect(text).toContain('Round 3');
    // Alice (init 18) comes first
    const aliceIdx = text.indexOf('Alice');
    const charlieIdx = text.indexOf('Charlie');
    const bobIdx = text.indexOf('Bob');
    expect(aliceIdx).toBeGreaterThan(-1);
    expect(aliceIdx).toBeLessThan(charlieIdx);
    expect(charlieIdx).toBeLessThan(bobIdx);
    expect(text).toContain('1. [18] **Alice**');
    expect(text).toContain('2. [12] **Charlie**');
    expect(text).toContain('3. [5] **Bob**');
    // turn 0 corresponds to the first combatant by sorted order (Alice)
    expect(text).toMatch(/1\. \[18\] \*\*Alice\*\*.*<-- CURRENT/);
  });

  it('renders "?" for null initiative', async () => {
    const combat = buildCombat({
      combatants: [buildCombatant({ name: 'Sneaky', initiative: null })],
    });
    const client = {
      getCombatState: vi.fn().mockReturnValue(combat),
      getRawActor: vi.fn().mockReturnValue(undefined),
    } as unknown as FoundryClient;

    const result = await handleGetCombatState({}, client);
    const text = getText(result);

    expect(text).toContain('[?] **Sneaky**');
  });

  it('marks defeated and hidden combatants with status flags', async () => {
    const combat = buildCombat({
      combatants: [
        buildCombatant({ name: 'Fallen', initiative: 10, defeated: true }),
        buildCombatant({ name: 'Lurker', initiative: 8, hidden: true }),
      ],
    });
    const client = {
      getCombatState: vi.fn().mockReturnValue(combat),
      getRawActor: vi.fn().mockReturnValue(undefined),
    } as unknown as FoundryClient;

    const result = await handleGetCombatState({}, client);
    const text = getText(result);

    expect(text).toContain('Fallen');
    expect(text).toContain('[DEFEATED]');
    expect(text).toContain('Lurker');
    expect(text).toContain('[HIDDEN]');
  });

  it('appends HP/AC from raw actor when actorId resolves', async () => {
    const combat = buildCombat({
      combatants: [buildCombatant({ name: 'Orc', initiative: 12, actorId: 'actor-99' })],
    });
    const rawActor: WorldActor = {
      _id: 'actor-99',
      name: 'Orc',
      type: 'npc',
      system: {
        attributes: {
          hp: { value: 12, max: 20 },
          ac: { calc: 'natural', flat: 14 },
        },
      },
    };
    const client = {
      getCombatState: vi.fn().mockReturnValue(combat),
      getRawActor: vi.fn().mockReturnValue(rawActor),
    } as unknown as FoundryClient;

    const result = await handleGetCombatState({}, client);
    const text = getText(result);

    expect(client.getRawActor).toHaveBeenCalledWith('actor-99');
    expect(text).toContain('HP: 12/20');
    expect(text).toContain('AC: 14');
  });

  it('names a combatant from its token, then its actor, when the combatant has no name', async () => {
    const combat = buildCombat({
      combatants: [
        buildCombatant({
          _id: 'a',
          name: undefined as unknown as string,
          initiative: 20,
          tokenId: 't1',
          sceneId: 's1',
        }),
        buildCombatant({ _id: 'b', name: '', initiative: 10, actorId: 'actor-7' }),
        buildCombatant({ _id: 'c', name: undefined as unknown as string, initiative: 5 }),
      ],
    });
    const client = {
      getCombatState: vi.fn().mockReturnValue(combat),
      findToken: vi
        .fn()
        .mockImplementation((id: string) =>
          id === 't1' ? { scene: {}, token: { _id: 't1', name: 'Warlord' } } : null,
        ),
      getRawActor: vi
        .fn()
        .mockImplementation((id: string) =>
          id === 'actor-7'
            ? { _id: 'actor-7', name: 'Sule Freescar', type: 'character', system: {} }
            : undefined,
        ),
    } as unknown as FoundryClient;

    const text = getText(await handleGetCombatState({}, client));

    expect(text).not.toContain('undefined');
    expect(text).toContain('**Warlord**');
    expect(text).toContain('**Sule Freescar**');
    expect(text).toContain('**Unknown combatant**');
  });

  it('says the encounter has not started in round 0, and names the current turn once it has', async () => {
    const notStarted = buildCombat({
      round: 0,
      turn: null,
      combatants: [buildCombatant({ name: 'Orc', initiative: 12 })],
    });
    const started = buildCombat({
      round: 2,
      turn: 1,
      combatants: [
        buildCombatant({ _id: 'a', name: 'Alice', initiative: 18 }),
        buildCombatant({ _id: 'b', name: 'Bob', initiative: 5 }),
      ],
    });
    const make = (combat: WorldCombat) =>
      ({
        getCombatState: vi.fn().mockReturnValue(combat),
        getRawActor: vi.fn().mockReturnValue(undefined),
      }) as unknown as FoundryClient;

    expect(getText(await handleGetCombatState({}, make(notStarted)))).toContain('not started');
    expect(getText(await handleGetCombatState({}, make(started)))).toContain('current turn: Bob');
  });

  it("prefers an unlinked token's own HP over the base actor", async () => {
    const combat = buildCombat({
      combatants: [
        buildCombatant({ name: 'Ushabti', actorId: 'actor-1', tokenId: 't1', sceneId: 's1' }),
      ],
    });
    const client = {
      getCombatState: vi.fn().mockReturnValue(combat),
      findToken: vi.fn().mockReturnValue({
        scene: {},
        token: { _id: 't1', delta: { system: { attributes: { hp: { value: 30 } } } } },
      }),
      getRawActor: vi.fn().mockReturnValue({
        _id: 'actor-1',
        name: 'Ushabti',
        type: 'npc',
        system: { attributes: { hp: { value: 97, max: 97 }, ac: { calc: 'natural', flat: 15 } } },
      }),
    } as unknown as FoundryClient;

    const text = getText(await handleGetCombatState({}, client));

    expect(text).toContain('HP: 30/97');
    expect(text).toContain('AC: 15');
  });

  it('omits HP/AC when raw actor lookup returns undefined', async () => {
    const combat = buildCombat({
      combatants: [buildCombatant({ name: 'Ghost', initiative: 7, actorId: 'missing-id' })],
    });
    const client = {
      getCombatState: vi.fn().mockReturnValue(combat),
      getRawActor: vi.fn().mockReturnValue(undefined),
    } as unknown as FoundryClient;

    const result = await handleGetCombatState({}, client);
    const text = getText(result);

    expect(text).toContain('Ghost');
    expect(text).not.toContain('HP:');
    expect(text).not.toContain('AC:');
  });

  it('handles empty combatant list gracefully', async () => {
    const combat = buildCombat({ round: 2, combatants: [] });
    const client = {
      getCombatState: vi.fn().mockReturnValue(combat),
      getRawActor: vi.fn().mockReturnValue(undefined),
    } as unknown as FoundryClient;

    const result = await handleGetCombatState({}, client);
    const text = getText(result);

    expect(text).toContain('Round 2');
  });
});

describe('handleGetCombatState — turn order (#214)', () => {
  const makeClient = (combat: WorldCombat) =>
    ({
      getCombatState: vi.fn().mockReturnValue(combat),
      getRawActor: vi.fn().mockReturnValue(undefined),
    }) as unknown as FoundryClient;

  it('does not reorder the cached combatants array (a read must not mutate the cache)', async () => {
    const combat = buildCombat({
      turn: 0,
      combatants: [
        buildCombatant({ _id: 'c-bob', name: 'Bob', initiative: 5 }),
        buildCombatant({ _id: 'c-alice', name: 'Alice', initiative: 18 }),
        buildCombatant({ _id: 'c-charlie', name: 'Charlie', initiative: 12 }),
      ],
    });
    const storedOrder = combat.combatants.map((c) => c.name);

    await handleGetCombatState({}, makeClient(combat));

    expect(combat.combatants.map((c) => c.name)).toEqual(storedOrder);
  });

  it('marks the combatant at combat.turn in INITIATIVE order as CURRENT', async () => {
    // Stored (creation) order deliberately differs from initiative order.
    const combat = buildCombat({
      turn: 1,
      combatants: [
        buildCombatant({ _id: 'c-bob', name: 'Bob', initiative: 5 }),
        buildCombatant({ _id: 'c-alice', name: 'Alice', initiative: 18 }),
        buildCombatant({ _id: 'c-charlie', name: 'Charlie', initiative: 12 }),
      ],
    });

    const text = getText(await handleGetCombatState({}, makeClient(combat)));

    // Sorted order is Alice (18), Charlie (12), Bob (5) -> turn 1 is Charlie.
    expect(text).toMatch(/2\. \[12\] \*\*Charlie\*\*.*<-- CURRENT/);
    expect(text).not.toMatch(/\*\*Alice\*\*.*<-- CURRENT/);
    expect(text).not.toMatch(/\*\*Bob\*\*.*<-- CURRENT/);
  });

  it('orders un-rolled (null) initiative last, breaking ties by document id', async () => {
    const combat = buildCombat({
      turn: 0,
      combatants: [
        buildCombatant({ _id: 'c-zed', name: 'Zed', initiative: null }),
        buildCombatant({ _id: 'c-ann', name: 'Ann', initiative: null }),
        buildCombatant({ _id: 'c-rex', name: 'Rex', initiative: 3 }),
      ],
    });

    const text = getText(await handleGetCombatState({}, makeClient(combat)));

    expect(text).toContain('1. [3] **Rex**');
    expect(text).toContain('2. [?] **Ann**');
    expect(text).toContain('3. [?] **Zed**');
  });
});
