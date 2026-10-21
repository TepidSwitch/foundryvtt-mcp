import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { WorldCombat } from '../../../foundry/types.js';
import { fakeFoundry } from '../../../test-utils/fake-foundry.js';
import { handleGetCombatState } from '../combat.js';
import {
  computeNextTurn,
  handleEndCombat,
  handleNextTurn,
  handleSetInitiative,
  handleStartCombat,
} from '../combat-mutations.js';
import { getTurnOrder } from '../combat-order.js';

const COMBAT_ID = 'cccccccccccccccc'; // 16 alphanumeric chars
const COMBATANT_ID = 'dddddddddddddddd';

/** Builds a minimal WorldCombat with `n` combatants. */
const makeCombat = (overrides: Partial<WorldCombat> = {}): WorldCombat => ({
  _id: COMBAT_ID,
  active: true,
  round: 1,
  turn: 0,
  started: true,
  combatants: [
    { _id: COMBATANT_ID, name: 'Alice', initiative: 15, hidden: false, defeated: false },
    { _id: 'eeeeeeeeeeeeeeee', name: 'Bob', initiative: 10, hidden: false, defeated: false },
  ],
  ...overrides,
});

const ALICE = 'alicealicealice1';
const BOB = 'bobbobbobbobbobb';
const CHARLIE = 'charliecharlie11';

type Fake = ReturnType<typeof fakeFoundry>;
type Row = Record<string, unknown>;

const setup = (world: { combats?: WorldCombat[]; scenes?: Row[] } = {}, config: Row = {}): Fake =>
  fakeFoundry({ world, config });
const serverCombat = (f: Fake, id = COMBAT_ID) => f.world.combats?.find((c) => c._id === id);
const combatant = (f: Fake, id: string, combatId = COMBAT_ID) =>
  (serverCombat(f, combatId)?.combatants as Row[]).find((c) => c._id === id);
const writes = (f: Fake) => f.sent.filter((s) => s.action !== 'get');
const textOf = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? '';

/**
 * Stored (creation) order deliberately differs from initiative order:
 *   stored:   Bob (5), Alice (18), Charlie (12)
 *   initiative order: Alice (18), Charlie (12), Bob (5)
 * Shaped the way Foundry persists a Combat: no `started` field (it is a
 * client-side getter, so a fixture that invents it hides a dead re-anchor).
 */
const makeUnsortedCombat = (overrides: Partial<WorldCombat> = {}): WorldCombat => ({
  _id: COMBAT_ID,
  active: true,
  round: 1,
  turn: 0,
  combatants: [
    { _id: BOB, name: 'Bob', initiative: 5, hidden: false, defeated: false },
    { _id: ALICE, name: 'Alice', initiative: 18, hidden: false, defeated: false },
    { _id: CHARLIE, name: 'Charlie', initiative: 12, hidden: false, defeated: false },
  ],
  ...overrides,
});

describe('computeNextTurn', () => {
  it('advances to the next combatant mid-combat', () => {
    const combat = makeCombat({ turn: 0, round: 1 });
    expect(computeNextTurn(combat)).toEqual({ turn: 1, round: 1 });
  });

  it('wraps to turn 0 of the next round after the last combatant', () => {
    const combat = makeCombat({ turn: 1, round: 1 });
    expect(computeNextTurn(combat)).toEqual({ turn: 0, round: 2 });
  });

  it('treats a null turn as turn 0', () => {
    const combat = makeCombat({ turn: null, round: 3 });
    expect(computeNextTurn(combat)).toEqual({ turn: 1, round: 3 });
  });

  it('throws when the combat has no combatants', () => {
    const combat = makeCombat({ combatants: [] });
    expect(() => computeNextTurn(combat)).toThrow(/no combatants/);
  });

  describe('skipDefeated', () => {
    /** Combat with three combatants; defeated flags set via the `defeated` array. */
    const makeTrio = (turn: number | null, round: number, defeated: [boolean, boolean, boolean]) =>
      makeCombat({
        turn,
        round,
        combatants: [
          {
            _id: 'aaaaaaaaaaaaaaaa',
            name: 'A',
            initiative: 20,
            hidden: false,
            defeated: defeated[0],
          },
          {
            _id: 'bbbbbbbbbbbbbbbb',
            name: 'B',
            initiative: 15,
            hidden: false,
            defeated: defeated[1],
          },
          {
            _id: 'gggggggggggggggg',
            name: 'C',
            initiative: 10,
            hidden: false,
            defeated: defeated[2],
          },
        ],
      });

    it('skips a defeated mid-list combatant', () => {
      // turn 0 (A), B defeated -> should land on C (index 2)
      const combat = makeTrio(0, 1, [false, true, false]);
      expect(computeNextTurn(combat, true)).toEqual({ turn: 2, round: 1 });
    });

    it('does not skip when skipDefeated is false (regression guard)', () => {
      const combat = makeTrio(0, 1, [false, true, false]);
      expect(computeNextTurn(combat, false)).toEqual({ turn: 1, round: 1 });
    });

    it('wraps past a trailing defeated combatant into the next round', () => {
      // turn 1 (B), C defeated -> no eligible left this round -> round 2, first alive (A)
      const combat = makeTrio(1, 1, [false, false, true]);
      expect(computeNextTurn(combat, true)).toEqual({ turn: 0, round: 2 });
    });

    it('advances to the lone survivor when all but one are defeated', () => {
      // turn 0 (A), B and C defeated -> no eligible left this round -> round 2, first alive (A)
      const combat = makeTrio(0, 1, [false, true, true]);
      expect(computeNextTurn(combat, true)).toEqual({ turn: 0, round: 2 });
    });

    it('wraps the round to the next non-defeated combatant when the leader is defeated', () => {
      // turn 2 (C), A defeated -> round 2, first alive is B (index 1)
      const combat = makeTrio(2, 1, [true, false, false]);
      expect(computeNextTurn(combat, true)).toEqual({ turn: 1, round: 2 });
    });

    it('falls back to turn 0 when every combatant is defeated', () => {
      const combat = makeTrio(0, 1, [true, true, true]);
      expect(computeNextTurn(combat, true)).toEqual({ turn: 0, round: 2 });
    });
  });
});

describe('next_turn', () => {
  it('advances the active combat and reports the new round/turn/combatant', async () => {
    const f = setup({ combats: [makeCombat({ turn: 0, round: 1 })] });
    const text = textOf(await handleNextTurn({}, f.client));
    expect(text).toContain('Combat Turn Advanced');
    expect(text).toContain('**Round:** 1');
    expect(text).toContain('Bob');
    expect(serverCombat(f)).toMatchObject({ turn: 1, round: 1 });
  });

  it('wraps into the next round', async () => {
    const f = setup({ combats: [makeCombat({ turn: 1, round: 1 })] });
    await handleNextTurn({}, f.client);
    expect(serverCombat(f)).toMatchObject({ turn: 0, round: 2 });
  });

  it('raises McpError when there is no active combat', async () => {
    const f = setup();
    await expect(handleNextTurn({}, f.client)).rejects.toThrow(McpError);
    expect(writes(f)).toEqual([]);
  });

  it('propagates the write-disabled guard error', async () => {
    const f = setup({ combats: [makeCombat()] }, { writeEnabled: false });
    await expect(handleNextTurn({}, f.client)).rejects.toThrow(/FOUNDRY_WRITE_ENABLED/);
    expect(serverCombat(f)?.turn).toBe(0);
  });

  const threeWithBobDefeated = (overrides: Partial<WorldCombat> = {}) =>
    makeCombat({
      turn: 0,
      round: 1,
      combatants: [
        { _id: COMBATANT_ID, name: 'Alice', initiative: 15, hidden: false, defeated: false },
        { _id: 'eeeeeeeeeeeeeeee', name: 'Bob', initiative: 10, hidden: false, defeated: true },
        { _id: 'ffffffffffffffff', name: 'Cara', initiative: 5, hidden: false, defeated: false },
      ],
      ...overrides,
    });

  it('skips a defeated combatant when skipDefeated arg is true', async () => {
    const f = setup({ combats: [threeWithBobDefeated()] });
    await handleNextTurn({ skipDefeated: true }, f.client);
    // Bob (index 1) is defeated, so the turn advances to Cara (index 2).
    expect(serverCombat(f)).toMatchObject({ turn: 2, round: 1 });
  });

  it('falls back to the combat skipDefeated setting when no arg is given', async () => {
    const f = setup({ combats: [threeWithBobDefeated({ settings: { skipDefeated: true } })] });
    await handleNextTurn({}, f.client);
    expect(serverCombat(f)).toMatchObject({ turn: 2, round: 1 });
  });

  it('names the same combatant get_combat_state marks as CURRENT (initiative order)', async () => {
    const f = setup({ combats: [makeUnsortedCombat({ turn: 0 })] });
    const text = textOf(await handleNextTurn({}, f.client));
    // Alice (18) -> Charlie (12), NOT whoever is at stored index 1.
    expect(text).toContain('**Now acting:** Charlie');
    expect(serverCombat(f)).toMatchObject({ turn: 1, round: 1 });
    // The client's cache received its own write; the read tool must agree.
    const state = textOf(await handleGetCombatState({}, f.client));
    const line = state.split('\n').find((l) => l.includes('<-- CURRENT')) ?? '';
    expect(/\*\*(.+?)\*\*/.exec(line)?.[1]).toBe('Charlie');
  });
});

describe('start_combat', () => {
  const SCENE_ID = 'ssssssssssssssss';
  const TOKEN_A = 'tokenaaaaaaaaaaa';
  const TOKEN_B = 'tokenbbbbbbbbbbb';
  const makeScene = (active: boolean, tokens: Row[]) => ({
    _id: SCENE_ID,
    name: 'Battlefield',
    active,
    tokens,
  });

  it('seeds combatants from explicit tokenIds, resolving actorId from the token', async () => {
    const f = setup({
      scenes: [makeScene(true, [{ _id: TOKEN_A, actorId: 'actoraaaaaaaaaaa' }, { _id: TOKEN_B }])],
    });
    const text = textOf(await handleStartCombat({ tokenIds: [TOKEN_A] }, f.client));
    expect(text).toContain('Combat Started');
    expect(f.world.combats).toHaveLength(1);
    const created = f.world.combats?.[0] as Row;
    expect(created).toMatchObject({ scene: SCENE_ID, active: true });
    expect(created.combatants).toMatchObject([
      { tokenId: TOKEN_A, sceneId: SCENE_ID, actorId: 'actoraaaaaaaaaaa' },
    ]);
  });

  it('defaults to every token on the active scene when tokenIds is omitted', async () => {
    const f = setup({
      scenes: [makeScene(true, [{ _id: TOKEN_A, actorId: 'actoraaaaaaaaaaa' }, { _id: TOKEN_B }])],
    });
    await handleStartCombat({}, f.client);
    const combatants = (f.world.combats?.[0] as Row).combatants as Row[];
    expect(combatants.map((c) => c.tokenId)).toEqual([TOKEN_A, TOKEN_B]);
    expect(combatants[0]?.actorId).toBe('actoraaaaaaaaaaa');
  });

  it('honours an explicit sceneId and creates an empty combat for an empty scene', async () => {
    const f = setup({
      scenes: [makeScene(false, []), { _id: 'othersssssssssss', name: 'Other', active: true }],
    });
    await handleStartCombat({ sceneId: SCENE_ID }, f.client);
    expect(f.world.combats?.[0]).toMatchObject({ scene: SCENE_ID });
    expect((f.world.combats?.[0] as Row).combatants ?? []).toEqual([]);
  });

  it('deactivates the combat that was active (live-found server side effect)', async () => {
    const f = setup({
      combats: [makeCombat()],
      scenes: [makeScene(true, [{ _id: TOKEN_A }])],
    });
    await handleStartCombat({}, f.client);
    expect(f.world.combats?.map((c) => c.active)).toEqual([false, true]);
    expect(f.client.getCombatState()?._id).toBe(f.world.combats?.[1]?._id);
  });

  it('raises McpError when no scene can be resolved', async () => {
    const f = setup();
    await expect(handleStartCombat({}, f.client)).rejects.toThrow(McpError);
    expect(writes(f)).toEqual([]);
  });

  it('raises McpError when a requested token is not on the scene', async () => {
    const f = setup({ scenes: [makeScene(true, [{ _id: TOKEN_A }])] });
    await expect(handleStartCombat({ tokenIds: [TOKEN_B] }, f.client)).rejects.toThrow(McpError);
    expect(writes(f)).toEqual([]);
  });

  it('rejects malformed ids and disabled writes before sending anything', async () => {
    const f = setup();
    await expect(f.client.startCombat('short', [])).rejects.toThrow(/Invalid sceneId/);
    await expect(
      f.client.startCombat(SCENE_ID, [{ tokenId: 'short', sceneId: SCENE_ID }]),
    ).rejects.toThrow(/Invalid tokenId/);
    const off = setup({}, { writeEnabled: false });
    await expect(off.client.startCombat(SCENE_ID, [])).rejects.toThrow(/FOUNDRY_WRITE_ENABLED/);
    expect(writes(f)).toEqual([]);
    expect(writes(off)).toEqual([]);
  });
});

describe('end_combat', () => {
  it('ends the active combat and reports the encounter id', async () => {
    const f = setup({ combats: [makeCombat()] });
    const text = textOf(await handleEndCombat({}, f.client));
    expect(text).toContain('Combat Ended');
    expect(text).toContain(COMBAT_ID);
    expect(f.world.combats).toEqual([]);
  });

  it('raises McpError when there is no active combat', async () => {
    const f = setup();
    await expect(handleEndCombat({}, f.client)).rejects.toThrow(McpError);
    expect(writes(f)).toEqual([]);
  });

  it('rejects a Socket.IO connection that is not active', async () => {
    const f = setup({ combats: [makeCombat()] });
    (f.client as unknown as { socket: unknown }).socket = null;
    await expect(f.client.endCombat(COMBAT_ID)).rejects.toThrow(/Socket\.IO connection/);
  });
});

describe('set_initiative', () => {
  it('sets initiative on the active combat by default', async () => {
    const f = setup({ combats: [makeCombat()] });
    const text = textOf(
      await handleSetInitiative({ combatantId: COMBATANT_ID, initiative: 18 }, f.client),
    );
    expect(text).toContain('Initiative Set');
    expect(combatant(f, COMBATANT_ID)?.initiative).toBe(18);
  });

  it('honours an explicit combatId even when no combat is active', async () => {
    const f = setup({ combats: [makeCombat({ active: false })] });
    await handleSetInitiative(
      { combatantId: COMBATANT_ID, initiative: 5, combatId: COMBAT_ID },
      f.client,
    );
    expect(combatant(f, COMBATANT_ID)?.initiative).toBe(5);
  });

  it('rejects a missing combatantId', async () => {
    const f = setup({ combats: [makeCombat()] });
    await expect(handleSetInitiative({ combatantId: '', initiative: 5 }, f.client)).rejects.toThrow(
      McpError,
    );
    expect(writes(f)).toEqual([]);
  });

  it('rejects a non-finite initiative, at the handler and at the client', async () => {
    const f = setup({ combats: [makeCombat()] });
    await expect(
      handleSetInitiative({ combatantId: COMBATANT_ID, initiative: Number.NaN }, f.client),
    ).rejects.toThrow(McpError);
    await expect(
      f.client.setCombatantInitiative(COMBAT_ID, COMBATANT_ID, Number.POSITIVE_INFINITY),
    ).rejects.toThrow(/Invalid initiative/);
    expect(writes(f)).toEqual([]);
  });

  it('raises McpError when no active combat and no combatId', async () => {
    const f = setup();
    await expect(
      handleSetInitiative({ combatantId: COMBATANT_ID, initiative: 5 }, f.client),
    ).rejects.toThrow(McpError);
    expect(writes(f)).toEqual([]);
  });

  it('rejects malformed ids and combat updates when writes are disabled', async () => {
    const f = setup({ combats: [makeCombat()] });
    await expect(f.client.updateCombat('short', { turn: 1 })).rejects.toThrow(/Invalid combatId/);
    await expect(f.client.setCombatantInitiative(COMBAT_ID, 'short', 5)).rejects.toThrow(
      /Invalid combatantId/,
    );
    const off = setup({ combats: [makeCombat()] }, { writeEnabled: false });
    await expect(off.client.updateCombat(COMBAT_ID, { turn: 1 })).rejects.toThrow(
      /FOUNDRY_WRITE_ENABLED/,
    );
    expect(writes(f)).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// #214: `Combat#turn` indexes the INITIATIVE-sorted turn order, not the stored
// (creation) order of `combat.combatants`.
// --------------------------------------------------------------------------
describe('initiative-ordered turn semantics (#214)', () => {
  describe('getTurnOrder', () => {
    it('sorts by initiative descending without mutating the source array', () => {
      const combat = makeUnsortedCombat();
      const stored = combat.combatants.map((c) => c.name);

      expect(getTurnOrder(combat).map((c) => c.name)).toEqual(['Alice', 'Charlie', 'Bob']);
      expect(combat.combatants.map((c) => c.name)).toEqual(stored);
    });

    it('places un-rolled (null) initiative last and breaks ties by document id', () => {
      const combat = makeCombat({
        combatants: [
          {
            _id: 'zzzzzzzzzzzzzzzz',
            name: 'Zed',
            initiative: null,
            hidden: false,
            defeated: false,
          },
          {
            _id: 'aaaaaaaaaaaaaaaa',
            name: 'Ann',
            initiative: null,
            hidden: false,
            defeated: false,
          },
          { _id: 'mmmmmmmmmmmmmmmm', name: 'Mia', initiative: 7, hidden: false, defeated: false },
          { _id: 'bbbbbbbbbbbbbbbb', name: 'Ben', initiative: 7, hidden: false, defeated: false },
        ],
      });

      expect(getTurnOrder(combat).map((c) => c.name)).toEqual(['Ben', 'Mia', 'Ann', 'Zed']);
    });
  });

  it('computeNextTurn indexes the initiative order, not the stored order', () => {
    const combat = makeUnsortedCombat({ turn: 0 });
    // turn 0 is Alice (18); the next turn is Charlie (12) at sorted index 1.
    const next = computeNextTurn(combat);
    expect(next).toEqual({ turn: 1, round: 1 });
    expect(getTurnOrder(combat)[next.turn]?.name).toBe('Charlie');
  });

  it('computeNextTurn evaluates skipDefeated against the initiative order', () => {
    // Alice (18, DEFEATED) is the current turn; the next live combatant is
    // Charlie at sorted index 1. Indexing stored order would test Alice's
    // `defeated` flag at index 1 and wrongly skip to index 2 (Charlie's slot
    // in stored order is 2, but the current combatant there is Bob).
    const combat = makeUnsortedCombat({ turn: 0 });
    const alice = combat.combatants.find((c) => c.name === 'Alice');
    if (!alice) {
      throw new Error('fixture missing Alice');
    }
    alice.defeated = true;

    const next = computeNextTurn(combat, true);
    expect(next).toEqual({ turn: 1, round: 1 });
    expect(getTurnOrder(combat)[next.turn]?.name).toBe('Charlie');
  });

  it('computeNextTurn wraps to the first live combatant in initiative order', () => {
    // Stored order: Bob (5), Alice (18, defeated), Charlie (12).
    // Initiative order: Alice (defeated), Charlie, Bob -> first alive is Charlie (1).
    const combat = makeUnsortedCombat({ turn: 2 });
    const alice = combat.combatants.find((c) => c.name === 'Alice');
    if (!alice) {
      throw new Error('fixture missing Alice');
    }
    alice.defeated = true;

    const next = computeNextTurn(combat, true);
    expect(next).toEqual({ turn: 1, round: 2 });
    expect(getTurnOrder(combat)[next.turn]?.name).toBe('Charlie');
  });
});

// --------------------------------------------------------------------------
// #214 follow-up: changing any initiative re-sorts the turn order underneath
// the stored `turn` index. Foundry's `Combat#setupTurns` re-points `turn` at the
// combatant that was acting; set_initiative must do the same.
// --------------------------------------------------------------------------
describe('set_initiative re-anchors Combat#turn', () => {
  const run = async (combat: WorldCombat, args: Row) => {
    const f = setup({ combats: [combat] });
    const result = await handleSetInitiative(args as never, f.client);
    return { f, text: textOf(result) };
  };

  it('keeps the same combatant acting after the order is reshuffled (no `started` field)', async () => {
    const combat = makeUnsortedCombat({ turn: 0 });
    expect('started' in combat).toBe(false);
    const { f } = await run(combat, { combatantId: ALICE, initiative: 1 });
    // Order is now Charlie (12), Bob (5), Alice (1): Alice, still acting, is index 2.
    expect(combatant(f, ALICE)?.initiative).toBe(1);
    expect(serverCombat(f)?.turn).toBe(2);
    expect(getTurnOrder(f.client.getCombatState() as WorldCombat).map((c) => c.name)).toEqual([
      'Charlie',
      'Bob',
      'Alice',
    ]);

    // And the next turn wraps from Alice to Charlie in round 2.
    const next = textOf(await handleNextTurn({}, f.client));
    expect(next).toContain('**Now acting:** Charlie');
    expect(serverCombat(f)).toMatchObject({ turn: 0, round: 2 });
  });

  it('reports the still-acting combatant in the tool output', async () => {
    const { text } = await run(makeUnsortedCombat({ turn: 0 }), {
      combatantId: ALICE,
      initiative: 1,
    });
    expect(text).toContain('**Initiative Set**');
    expect(text).toContain('Alice');
    expect(text).toContain('turn 3 of 3');
  });

  it('leaves `turn` alone when the combat has no combatants', async () => {
    const f = setup({ combats: [makeUnsortedCombat({ turn: 0, combatants: [] })] });
    await expect(
      handleSetInitiative({ combatantId: ALICE, initiative: 1 }, f.client),
    ).rejects.toThrow();
    expect(writes(f).filter((w) => w.type === 'Combat')).toEqual([]);
  });

  it('follows the acting combatant when another combatant slides under the stored turn', async () => {
    // Charlie is acting (initiative index 1). Bob jumps to 20 -> Bob, Alice, Charlie.
    const { f } = await run(makeUnsortedCombat({ turn: 1 }), { combatantId: BOB, initiative: 20 });
    expect(serverCombat(f)?.turn).toBe(2);
  });

  it('leaves `turn` alone when the acting combatant keeps its index', async () => {
    const { f } = await run(makeUnsortedCombat({ turn: 0 }), {
      combatantId: ALICE,
      initiative: 17,
    });
    expect(combatant(f, ALICE)?.initiative).toBe(17);
    expect(writes(f).filter((w) => w.type === 'Combat')).toEqual([]);
    expect(serverCombat(f)?.turn).toBe(0);
  });

  it('leaves `turn` alone when no combatant is acting yet (turn null)', async () => {
    const { f } = await run(makeUnsortedCombat({ turn: null }), {
      combatantId: ALICE,
      initiative: 1,
    });
    expect(combatant(f, ALICE)?.initiative).toBe(1);
    expect(serverCombat(f)?.turn).toBeNull();
  });

  it('leaves `turn` alone before the encounter has started (round 0)', async () => {
    // Pre-roll setup: started-ness is derived from `round`, as core derives it.
    const { f } = await run(makeUnsortedCombat({ round: 0, turn: 0 }), {
      combatantId: ALICE,
      initiative: 1,
    });
    expect(combatant(f, ALICE)?.initiative).toBe(1);
    expect(serverCombat(f)?.turn).toBe(0);
  });

  it('leaves `turn` alone when the stored index resolves to no combatant', async () => {
    const { f } = await run(makeUnsortedCombat({ turn: 9 }), { combatantId: ALICE, initiative: 1 });
    expect(combatant(f, ALICE)?.initiative).toBe(1);
    expect(serverCombat(f)?.turn).toBe(9);
  });

  it('does not re-anchor a combat other than the active one', async () => {
    const other = { ...makeUnsortedCombat({ turn: 0 }), _id: 'ffffffffffff0000', active: false };
    const f = setup({ combats: [makeUnsortedCombat({ turn: 0 }), other] });
    await handleSetInitiative(
      { combatantId: ALICE, initiative: 1, combatId: 'ffffffffffff0000' },
      f.client,
    );
    expect(combatant(f, ALICE, 'ffffffffffff0000')?.initiative).toBe(1);
    expect(serverCombat(f)?.turn).toBe(0);
    expect(serverCombat(f, 'ffffffffffff0000')?.turn).toBe(0);
  });

  it('re-anchors when the active combat is named explicitly', async () => {
    const { f } = await run(makeUnsortedCombat({ turn: 0 }), {
      combatantId: ALICE,
      initiative: 1,
      combatId: COMBAT_ID,
    });
    expect(serverCombat(f)?.turn).toBe(2);
  });
});
