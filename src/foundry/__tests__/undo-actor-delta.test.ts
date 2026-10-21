import { describe, expect, it } from 'vitest';
import { fakeFoundry } from '../../test-utils/fake-foundry.js';
import { handleDamage, handleHeal, handleSetTempHp } from '../../tools/handlers/rest-healing.js';

const A = 'ACTOR1AAAAAAAAAA';
const SC = 'SCENE1AAAAAAAAAA';
const TK = 'TOKEN1AAAAAAAAAA';

function setup(delta?: Record<string, unknown>) {
  return fakeFoundry({
    world: {
      actors: [
        {
          _id: A,
          name: 'Bram',
          type: 'npc',
          items: [],
          effects: [],
          system: { attributes: { hp: { value: 12, max: 12, temp: 0 } } },
        },
      ],
      scenes: [
        {
          _id: SC,
          name: 'S',
          tokens: [
            { _id: TK, name: 'Goblin', actorId: A, actorLink: false, ...(delta ? { delta } : {}) },
          ],
        },
      ],
    },
  });
}

const deltaHp = (f: ReturnType<typeof setup>) =>
  (
    f.world.scenes?.[0]?.tokens as Array<{ delta?: { system?: { attributes?: { hp?: unknown } } } }>
  )[0]?.delta?.system?.attributes?.hp as Record<string, number> | undefined;

describe('undo of ActorDelta writes (live-found bug 4)', () => {
  it('damage then undo on a token with no hp override restores the base value', async () => {
    const f = setup();
    await handleDamage({ target: TK, amount: 3 }, f.client);
    expect(deltaHp(f)).toMatchObject({ value: 9 });
    await f.client.undoWrite();
    // Nested restore to the base actor's value, never dot-path keys (bug 1).
    expect(f.sent.at(-1)).toMatchObject({
      type: 'ActorDelta',
      action: 'update',
      operation: {
        parentUuid: `Scene.${SC}.Token.${TK}`,
        updates: [{ _id: TK, system: { attributes: { hp: { value: 12 } } } }],
      },
    });
    expect(deltaHp(f)).toMatchObject({ value: 12 });
  });

  it('damage then undo on a token with an hp override restores that override', async () => {
    const f = setup({ _id: TK, system: { attributes: { hp: { value: 7 } } } });
    await handleDamage({ target: TK, amount: 3 }, f.client);
    expect(deltaHp(f)).toMatchObject({ value: 4 });
    await f.client.undoWrite();
    expect(deltaHp(f)).toMatchObject({ value: 7 });
  });

  it('heal then undo restores the previous hp', async () => {
    const f = setup({ _id: TK, system: { attributes: { hp: { value: 3 } } } });
    await handleHeal({ target: TK, amount: 4 }, f.client);
    expect(deltaHp(f)).toMatchObject({ value: 7 });
    await f.client.undoWrite();
    expect(deltaHp(f)).toMatchObject({ value: 3 });
  });

  it('set_temp_hp then undo restores the base temp value', async () => {
    const f = setup();
    await handleSetTempHp({ target: TK, amount: 5 }, f.client);
    expect(deltaHp(f)).toMatchObject({ temp: 5 });
    await f.client.undoWrite();
    expect(deltaHp(f)).toMatchObject({ temp: 0 });
  });
});
