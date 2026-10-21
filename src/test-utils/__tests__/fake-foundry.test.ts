import { describe, expect, it } from 'vitest';
import { fakeFoundry } from '../fake-foundry.js';

const A = 'ACTOR1AAAAAAAAAA';
const SC = 'SCENE1AAAAAAAAAA';
const TK = 'TOKEN1AAAAAAAAAA';

const world = {
  actors: [
    { _id: A, name: 'Bram', type: 'npc', system: { attributes: { hp: { value: 4, max: 20 } } } },
  ],
  scenes: [{ _id: SC, name: 'S', tokens: [{ _id: TK, actorId: A, actorLink: false }] }],
};

describe('fake foundry server', () => {
  it('creates with 16-char ids and updates nested embedded docs', async () => {
    const { client, world: server } = fakeFoundry({ world });
    const [created] = await client.createDocuments('JournalEntry', [{ name: 'Recap' }]);
    expect(String(created?._id)).toHaveLength(16);
    expect(server.journal?.[0]?.name).toBe('Recap');
    await client.updateActorAttribute(A, { 'attributes.hp.value': 9 });
    expect(server.actors?.[0]).toMatchObject({ system: { attributes: { hp: { value: 9 } } } });
  });

  it('accepts but does not store dot-path keys on an ActorDelta (bug 1)', async () => {
    const { client, world: server } = fakeFoundry({ world });
    const send = (update: Record<string, unknown>) =>
      client.updateDocuments('ActorDelta', [update], `Scene.${SC}.Token.${TK}`);
    const echoed = await send({ _id: TK, 'system.attributes.hp.value': 5 });
    expect(echoed[0]).toMatchObject({ 'system.attributes.hp.value': 5 });
    const token = (server.scenes?.[0]?.tokens as Array<Record<string, unknown>>)[0];
    expect((token?.delta as Record<string, unknown> | undefined)?.system).toBeUndefined();
    await send({ _id: TK, system: { attributes: { hp: { value: 5 } } } });
    expect(token?.delta).toMatchObject({ system: { attributes: { hp: { value: 5 } } } });
  });

  it('projects a pack index to the requested fields only (bug 2)', async () => {
    const { client } = fakeFoundry({
      world,
      packs: [
        {
          id: 'p.monsters',
          type: 'Actor',
          documents: [{ _id: 'M1', name: 'Wolf', type: 'npc', img: 'w.png', system: { cr: 1 } }],
        },
      ],
    });
    const rows = await client.getPackIndexFields('p.monsters', ['system.cr']);
    expect(rows).toEqual([
      { _id: 'M1', name: 'Wolf', type: 'npc', img: 'w.png', system: { cr: 1 } },
    ]);
  });

  it('deactivates the active combat on creating another, replying with results (bug 3)', async () => {
    const {
      client,
      world: server,
      sent,
    } = fakeFoundry({
      world: { combats: [{ _id: 'OLDCOMBATAAAAAAA', active: true, combatants: [] }] },
    });
    const [created] = await client.createDocuments('Combat', [{ active: true }]);
    expect(String(created?._id)).toHaveLength(16);
    expect(server.combats?.map((c) => c.active)).toEqual([false, true]);
    expect(sent.at(-1)?.action).toBe('create');
    // The client's cache also reflects the deactivation (side effect recorded).
    expect(
      client.getWorldSnapshot()?.combats.find((c) => c._id === 'OLDCOMBATAAAAAAA')?.active,
    ).toBe(false);
  });
});
