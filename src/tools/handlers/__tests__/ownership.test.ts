import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { handleSetActorOwnership } from '../ownership.js';

const ACTOR = 'ACTORAAAAAAAAAAA';

function client() {
  const updateDocuments = vi.fn(async () => []);
  const snapshot = {
    actors: [
      {
        _id: ACTOR,
        name: 'Ossul',
        type: 'character',
        ownership: { default: 0, USERBBBBBBBBBBBB: 3 },
      },
    ],
    users: [
      { _id: 'USERAAAAAAAAAAAA', name: 'Skander', role: 1 },
      { _id: 'USERBBBBBBBBBBBB', name: 'Alex', role: 1 },
    ],
  };
  const mock = { getWorldSnapshot: () => snapshot, updateDocuments } as unknown as FoundryClient;
  return { mock, updateDocuments };
}

describe('handleSetActorOwnership', () => {
  it('sets a level for a user found by name and reports the resulting map', async () => {
    const { mock, updateDocuments } = client();
    const result = await handleSetActorOwnership(
      { actor: 'Ossul', user: 'skander', level: 'owner' },
      mock,
    );
    expect(updateDocuments).toHaveBeenCalledWith('Actor', [
      { _id: ACTOR, 'ownership.USERAAAAAAAAAAAA': 3 },
    ]);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Skander');
    expect(text).toContain('Alex: owner');
    expect(text).toContain('default: none');
  });

  it('accepts a user id and the default key', async () => {
    const { mock, updateDocuments } = client();
    await handleSetActorOwnership(
      { actor: ACTOR, user: 'USERBBBBBBBBBBBB', level: 'observer' },
      mock,
    );
    expect(updateDocuments).toHaveBeenLastCalledWith('Actor', [
      { _id: ACTOR, 'ownership.USERBBBBBBBBBBBB': 2 },
    ]);
    await handleSetActorOwnership({ actor: ACTOR, user: 'everyone', level: 'limited' }, mock);
    expect(updateDocuments).toHaveBeenLastCalledWith('Actor', [
      { _id: ACTOR, 'ownership.default': 1 },
    ]);
  });

  it('lists the users when none matches', async () => {
    const { mock, updateDocuments } = client();
    await expect(
      handleSetActorOwnership({ actor: 'Ossul', user: 'Nobody', level: 'owner' }, mock),
    ).rejects.toThrow(/Skander, Alex/);
    expect(updateDocuments).not.toHaveBeenCalled();
  });
});
