import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
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

function client(opts: { linked?: boolean } = {}) {
  const actors = [
    actor(A1, 'Aria', { value: 10, max: 20, temp: 5 }),
    actor(A2, 'Bram', { value: 4, max: 12, temp: 0 }),
  ];
  const token = {
    _id: TK,
    name: 'Goblin',
    actorId: A2,
    actorLink: opts.linked === true,
    delta: { system: { attributes: { hp: { value: 3 } } } },
  };
  const m = {
    getWorldSnapshot: () => ({
      actors,
      users: [
        { _id: 'U1', name: 'Pat', role: 1, character: A1 },
        { _id: 'U2', name: 'GM', role: 4 },
      ],
    }),
    getRawActor: (id: string) => actors.find((a) => a._id === id),
    findToken: (id: string) => (id === TK ? { scene: { _id: SC, name: 'S' }, token } : null),
    getUserId: () => 'U2',
    createDocuments: vi.fn(async () => [{ _id: 'MSGAAAAAAAAAAAAA' }]),
    updateActorAttribute: vi.fn(async () => ({ success: true, updatedAttributes: {} })),
    updateTokenActorAttribute: vi.fn(async () => ({ success: true, updatedAttributes: {} })),
  };
  return { m, mock: m as unknown as FoundryClient };
}

const out = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? '';

describe('request_rest', () => {
  it('posts a request card for the party', async () => {
    const { m, mock } = client();
    await handleRequestRest({ type: 'long' }, mock);
    const [type, [data]] = m.createDocuments.mock.calls[0] as unknown as [
      string,
      Array<Record<string, unknown>>,
    ];
    expect(type).toBe('ChatMessage');
    expect(data).toMatchObject({
      type: 'request',
      author: 'U2',
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
    const { m, mock } = client();
    await handleRequestRest({ type: 'short', actors: ['Bram'], new_day: true }, mock);
    const [, [data]] = m.createDocuments.mock.calls[0] as unknown as [
      string,
      Array<Record<string, unknown>>,
    ];
    expect(data).toMatchObject({
      flavor: 'Short Rest (1 hour, new day)',
      system: { targets: [{ actor: `Actor.${A2}` }], data: { recoverTemp: false, newDay: true } },
    });
  });
});

describe('hit points', () => {
  it('damage drains temp first and clamps at 0', async () => {
    const { m, mock } = client();
    const r = await handleDamage({ target: 'Aria', amount: 8, type: 'fire' }, mock);
    expect(m.updateActorAttribute).toHaveBeenCalledWith(A1, {
      'attributes.hp.value': 7,
      'attributes.hp.temp': 0,
    });
    expect(out(r)).toContain('10/20 (+5 temp) → 7/20');
    await handleDamage({ target: 'Aria', amount: 99 }, mock);
    expect(m.updateActorAttribute).toHaveBeenLastCalledWith(A1, {
      'attributes.hp.value': 0,
      'attributes.hp.temp': 0,
    });
  });

  it('heal clamps at max and skips the write when full', async () => {
    const { m, mock } = client();
    await handleHeal({ target: A1, amount: 50, announce: true }, mock);
    expect(m.updateActorAttribute).toHaveBeenCalledWith(A1, { 'attributes.hp.value': 20 });
    expect(m.createDocuments).toHaveBeenCalledTimes(1);
  });

  it('temp HP keeps the higher value unless forced', async () => {
    const { m, mock } = client();
    await handleSetTempHp({ target: 'Aria', amount: 3 }, mock);
    expect(m.updateActorAttribute).not.toHaveBeenCalled();
    await handleSetTempHp({ target: 'Aria', amount: 3, force: true }, mock);
    expect(m.updateActorAttribute).toHaveBeenCalledWith(A1, { 'attributes.hp.temp': 3 });
    await handleSetTempHp({ target: 'Aria', amount: 9 }, mock);
    expect(m.updateActorAttribute).toHaveBeenLastCalledWith(A1, { 'attributes.hp.temp': 9 });
  });

  it('unlinked token writes to its ActorDelta using the merged HP', async () => {
    const { m, mock } = client();
    const r = await handleHeal({ target: TK, amount: 2 }, mock);
    expect(m.updateTokenActorAttribute).toHaveBeenCalledWith(SC, TK, { 'attributes.hp.value': 5 });
    expect(m.updateActorAttribute).not.toHaveBeenCalled();
    expect(out(r)).toContain('3/12 → 5/12');
  });

  it('linked token writes to the world actor', async () => {
    const { m, mock } = client({ linked: true });
    await handleHeal({ target: TK, amount: 2 }, mock);
    expect(m.updateActorAttribute).toHaveBeenCalledWith(A2, { 'attributes.hp.value': 6 });
  });

  it('rejects non-positive amounts', async () => {
    const { mock } = client();
    await expect(handleHeal({ target: 'Aria', amount: 0 }, mock)).rejects.toThrow(/amount/);
  });
});
