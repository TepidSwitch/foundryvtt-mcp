import { describe, expect, it } from 'vitest';
import { fakeFoundry } from '../../../test-utils/fake-foundry.js';
import { handleDamage, handleHeal, handleRequestRest, handleSetTempHp } from '../rest-healing.js';

const A1 = 'ACTOR1AAAAAAAAAA';
const A2 = 'ACTOR2AAAAAAAAAA';
const SC = 'SCENE1AAAAAAAAAA';
const TK = 'TOKEN1AAAAAAAAAA';

function actor(id: string, name: string, hp: Record<string, number>) {
  return {
    _id: id,
    name,
    type: 'character',
    items: [],
    effects: [],
    system: { attributes: { hp } },
  };
}

function setup(opts: { linked?: boolean } = {}) {
  return fakeFoundry({
    world: {
      actors: [
        actor(A1, 'Aria', { value: 10, max: 20, temp: 5 }),
        actor(A2, 'Bram', { value: 4, max: 12, temp: 0 }),
      ],
      users: [
        { _id: 'U1', name: 'Pat', role: 1, character: A1 },
        { _id: 'U2', name: 'GM', role: 4 },
      ],
      scenes: [
        {
          _id: SC,
          name: 'S',
          tokens: [
            {
              _id: TK,
              name: 'Goblin',
              actorId: A2,
              actorLink: opts.linked === true,
              delta: { _id: TK, system: { attributes: { hp: { value: 3 } } } },
            },
          ],
        },
      ],
    },
  });
}

const hpOfActor = (f: ReturnType<typeof setup>, id: string) =>
  (f.world.actors?.find((a) => a._id === id)?.system as { attributes: { hp: unknown } }).attributes
    .hp;
const tokenDelta = (f: ReturnType<typeof setup>) =>
  (f.world.scenes?.[0]?.tokens as Array<{ delta: Record<string, unknown> }>)[0]?.delta;
const writes = (f: ReturnType<typeof setup>) => f.sent.filter((s) => s.action !== 'get');

const out = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? '';

describe('request_rest', () => {
  it('posts a request card for the party', async () => {
    const f = setup();
    await handleRequestRest({ type: 'long' }, f.client);
    expect(f.world.messages?.[0]).toMatchObject({
      type: 'request',
      author: 'GMUSERAAAAAAAAAA',
      flavor: 'Long Rest (8 hours, new day)',
      system: {
        button: { icon: 'fa-solid fa-campground', label: 'Long Rest' },
        data: { newDay: true, recoverTemp: true, recoverTempMax: true, type: 'long' },
        handler: 'rest',
        targets: [{ actor: `Actor.${A1}` }],
      },
    });
  });

  it('honours explicit actors and new_day', async () => {
    const f = setup();
    await handleRequestRest({ type: 'short', actors: ['Bram'], new_day: true }, f.client);
    expect(f.world.messages?.[0]).toMatchObject({
      flavor: 'Short Rest (1 hour, new day)',
      system: { targets: [{ actor: `Actor.${A2}` }], data: { recoverTemp: false, newDay: true } },
    });
  });
});

describe('hit points', () => {
  it('damage drains temp first and clamps at 0', async () => {
    const f = setup();
    const r = await handleDamage({ target: 'Aria', amount: 8, type: 'fire' }, f.client);
    expect(hpOfActor(f, A1)).toMatchObject({ value: 7, temp: 0 });
    expect(out(r)).toContain('10/20 (+5 temp) → 7/20');
    await handleDamage({ target: 'Aria', amount: 99 }, f.client);
    expect(hpOfActor(f, A1)).toMatchObject({ value: 0, temp: 0 });
  });

  it('heal clamps at max and announces', async () => {
    const f = setup();
    await handleHeal({ target: A1, amount: 50, announce: true }, f.client);
    expect(hpOfActor(f, A1)).toMatchObject({ value: 20 });
    expect(f.world.messages).toHaveLength(1);
  });

  it('heal skips the write when already full', async () => {
    const f = fakeFoundry({
      world: { actors: [actor(A1, 'Aria', { value: 20, max: 20, temp: 0 })] },
    });
    await handleHeal({ target: A1, amount: 5 }, f.client);
    expect(writes(f)).toEqual([]);
  });

  it('temp HP keeps the higher value unless forced', async () => {
    const f = setup();
    await handleSetTempHp({ target: 'Aria', amount: 3 }, f.client);
    expect(hpOfActor(f, A1)).toMatchObject({ temp: 5 });
    expect(writes(f)).toEqual([]);
    await handleSetTempHp({ target: 'Aria', amount: 3, force: true }, f.client);
    expect(hpOfActor(f, A1)).toMatchObject({ temp: 3 });
    await handleSetTempHp({ target: 'Aria', amount: 9 }, f.client);
    expect(hpOfActor(f, A1)).toMatchObject({ temp: 9 });
  });

  it('unlinked token stores HP in its delta (not dot-path keys) using the merged HP', async () => {
    const f = setup();
    const r = await handleHeal({ target: TK, amount: 2 }, f.client);
    // Regression for the live bug: dot-path keys on an ActorDelta are silently
    // not saved, so the HP must really be in the server's token.delta.
    expect(tokenDelta(f)).toMatchObject({ system: { attributes: { hp: { value: 5 } } } });
    expect(hpOfActor(f, A2)).toMatchObject({ value: 4 });
    expect(out(r)).toContain('3/12 → 5/12');
  });

  it('linked token writes to the world actor', async () => {
    const f = setup({ linked: true });
    await handleHeal({ target: TK, amount: 2 }, f.client);
    expect(hpOfActor(f, A2)).toMatchObject({ value: 6 });
    expect(tokenDelta(f)).toMatchObject({ system: { attributes: { hp: { value: 3 } } } });
  });

  it('rejects non-positive amounts', async () => {
    const f = setup();
    await expect(handleHeal({ target: 'Aria', amount: 0 }, f.client)).rejects.toThrow(/amount/);
  });
});
