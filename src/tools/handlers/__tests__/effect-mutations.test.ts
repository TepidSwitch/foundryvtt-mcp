import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import {
  handleCreateEffect,
  handleDeleteEffect,
  handleListEffects,
  handleUpdateEffect,
} from '../effect-mutations.js';

const ACTOR = 'ACTORAAAAAAAAAAA';
const ITEM = 'ITEMAAAAAAAAAAAA';
const WORLD_ITEM = 'WORLDITEMAAAAAAA';
const EFFECT = 'EFFECTAAAAAAAAAA';

function client() {
  const calls = {
    createDocuments: vi.fn(async () => [{ _id: 'NEWEFFECTAAAAAAA' }]),
    updateDocuments: vi.fn(async () => []),
    deleteDocuments: vi.fn(async () => []),
  };
  const snapshot = {
    actors: [
      {
        _id: ACTOR,
        name: 'Ossul',
        type: 'character',
        items: [
          {
            _id: ITEM,
            name: 'Ring of Protection',
            effects: [{ _id: 'RINGEFFECTAAAAAAA', name: 'Protection', transfer: true }],
          },
        ],
        effects: [
          {
            _id: EFFECT,
            name: 'Bless',
            system: {
              changes: [{ key: 'system.bonuses.abilities.save', type: 'add', value: '1d4' }],
            },
          },
        ],
      },
    ],
    items: [{ _id: WORLD_ITEM, name: 'Cloak', effects: [] }],
    users: [],
  };
  return {
    mock: { getWorldSnapshot: () => snapshot, ...calls } as unknown as FoundryClient,
    ...calls,
  };
}

describe('effect mutation handlers', () => {
  it('creates an actor effect with v14 system.changes and string change types', async () => {
    const { mock, createDocuments } = client();
    await handleCreateEffect(
      {
        actor: 'Ossul',
        name: 'Shield of Faith',
        changes: [{ key: 'system.attributes.ac.bonus', value: 2 }],
        duration: { value: 10, units: 'minutes' },
        description: '+2 AC',
      },
      mock,
    );
    expect(createDocuments).toHaveBeenCalledWith(
      'ActiveEffect',
      [
        {
          name: 'Shield of Faith',
          description: '+2 AC',
          system: { changes: [{ key: 'system.attributes.ac.bonus', type: 'add', value: 2 }] },
          duration: { value: 10, units: 'minutes' },
        },
      ],
      `Actor.${ACTOR}`,
    );
  });

  it('targets an item owned by an actor and a world item', async () => {
    const { mock, createDocuments } = client();
    await handleCreateEffect({ actor: 'Ossul', item: 'ring', name: 'x', transfer: true }, mock);
    expect(createDocuments).toHaveBeenLastCalledWith(
      'ActiveEffect',
      [{ name: 'x', transfer: true }],
      `Actor.${ACTOR}.Item.${ITEM}`,
    );
    await handleCreateEffect({ item: 'Cloak', name: 'y' }, mock);
    expect(createDocuments).toHaveBeenLastCalledWith(
      'ActiveEffect',
      [{ name: 'y' }],
      `Item.${WORLD_ITEM}`,
    );
  });

  it('updates with dot keys so duration merges and changes replace', async () => {
    const { mock, updateDocuments } = client();
    await handleUpdateEffect(
      {
        actor: 'Ossul',
        effect: 'bless',
        disabled: true,
        duration: { units: 'rounds' },
        changes: [{ key: 'k', type: 'override', value: 'v', phase: 'final', priority: 90 }],
      },
      mock,
    );
    expect(updateDocuments).toHaveBeenCalledWith(
      'ActiveEffect',
      [
        {
          _id: EFFECT,
          disabled: true,
          'system.changes': [
            { key: 'k', type: 'override', value: 'v', phase: 'final', priority: 90 },
          ],
          'duration.units': 'rounds',
        },
      ],
      `Actor.${ACTOR}`,
    );
    await expect(handleUpdateEffect({ actor: 'Ossul', effect: 'bless' }, mock)).rejects.toThrow(
      /at least one/,
    );
  });

  it('deletes by name and lists with changes', async () => {
    const { mock, deleteDocuments } = client();
    await handleDeleteEffect({ actor: 'Ossul', effect: 'Bless' }, mock);
    expect(deleteDocuments).toHaveBeenCalledWith('ActiveEffect', [EFFECT], `Actor.${ACTOR}`);
    const listed = (await handleListEffects({ actor: 'Ossul' }, mock)).content[0] as {
      text: string;
    };
    expect(listed.text).toContain('Bless');
    expect(listed.text).toContain('system.bonuses.abilities.save add "1d4"');
  });

  it('says where to put the effect when no target is given, and which effect is unknown', async () => {
    const { mock } = client();
    await expect(handleCreateEffect({ name: 'x' }, mock)).rejects.toThrow(
      /Say where the effect is/,
    );
    await expect(handleDeleteEffect({ actor: 'Ossul', effect: 'Nope' }, mock)).rejects.toThrow(
      /No effect matches/,
    );
  });
});
