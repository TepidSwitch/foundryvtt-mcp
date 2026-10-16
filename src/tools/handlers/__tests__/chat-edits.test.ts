import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import {
  buildRollEnricher,
  handleDrawTable,
  handleRequestRoll,
  handleSendChat,
  handleUseItem,
} from '../chat-edits.js';

const ACTOR = 'ACTORAAAAAAAAAAA';
const ITEM = 'ITEMAAAAAAAAAAAA';

function client(random = 0) {
  vi.spyOn(Math, 'random').mockReturnValue(random);
  const createDocuments = vi.fn(async () => [{ _id: 'MSGAAAAAAAAAAAAA' }]);
  const snapshot = {
    actors: [
      {
        _id: ACTOR,
        name: 'Ossul',
        type: 'character',
        items: [{ _id: ITEM, name: 'Heavy Crossbow' }],
      },
    ],
    users: [
      { _id: 'USERAAAAAAAAAAAA', name: 'Skander', role: 1 },
      { _id: 'USERGMAAAAAAAAAA', name: 'Stasykins', role: 4 },
    ],
    tables: [
      {
        _id: 'TABLEAAAAAAAAAAA',
        name: 'Wild Magic',
        formula: '1d4',
        results: [
          { range: [1, 2], name: 'Sparkles' },
          { range: [3, 4], name: 'Frogs' },
        ],
      },
    ],
  };
  return {
    mock: {
      getWorldSnapshot: () => snapshot,
      getUserId: () => 'USERGMAAAAAAAAAA',
      createDocuments,
    } as unknown as FoundryClient,
    createDocuments,
  };
}

const sent = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls.at(-1)?.[1][0] as Record<string, unknown>;

describe('buildRollEnricher', () => {
  it('builds the dnd5e enrichers the system parses', () => {
    expect(buildRollEnricher({ kind: 'check', ability: ['dex'], skill: ['stealth'], dc: 15 })).toBe(
      '[[/check ability=dex skill=stealth dc=15]]',
    );
    expect(buildRollEnricher({ kind: 'skill', skill: ['Sleight of Hand', 'perception'] })).toBe(
      '[[/skill skill=sleight-of-hand/perception]]',
    );
    expect(buildRollEnricher({ kind: 'save', ability: ['str', 'dex'], dc: 14 })).toBe(
      '[[/save ability=str/dex dc=14]]',
    );
    expect(buildRollEnricher({ kind: 'tool', tool: ["Thieves' Tools"], ability: ['dex'] })).toBe(
      '[[/tool tool=thieves-tools ability=dex]]',
    );
    expect(buildRollEnricher({ kind: 'concentration', dc: 10 })).toBe('[[/concentration dc=10]]');
  });

  it('rejects incomplete or unsafe requests', () => {
    expect(() => buildRollEnricher({ kind: 'check' })).toThrow(/needs ability, skill or tool/);
    expect(() => buildRollEnricher({ kind: 'save' })).toThrow(/needs ability/);
    expect(() => buildRollEnricher({ kind: 'skill', skill: ['x]] <b>'] })).toThrow(/plain name/);
  });
});

describe('chat edit handlers', () => {
  it('sends an escaped GM message and a whispered actor message', async () => {
    const { mock, createDocuments } = client();
    await handleSendChat({ content: 'Hi <b>there</b>\nnext' }, mock);
    expect(sent(createDocuments)).toEqual({
      content: '<p>Hi &lt;b&gt;there&lt;/b&gt;<br>next</p>',
      author: 'USERGMAAAAAAAAAA',
      speaker: { alias: 'Game Master' },
    });
    await handleSendChat(
      { content: 'Psst', speaker: 'Ossul', whisper: ['skander'], flavor: 'quietly' },
      mock,
    );
    expect(sent(createDocuments)).toEqual({
      content: '<p>Psst</p>',
      author: 'USERGMAAAAAAAAAA',
      speaker: { actor: ACTOR, alias: 'Ossul' },
      style: 2,
      whisper: ['USERAAAAAAAAAAAA'],
      flavor: 'quietly',
    });
    await expect(handleSendChat({ content: 'x', whisper: ['nobody'] }, mock)).rejects.toThrow(
      /Skander, Stasykins/,
    );
  });

  it('posts a roll request with the prompt above the link', async () => {
    const { mock, createDocuments } = client();
    await handleRequestRoll(
      { kind: 'check', skill: ['perception'], dc: 15, prompt: 'You hear a noise <now>' },
      mock,
    );
    expect(sent(createDocuments).content).toBe(
      '<p>You hear a noise &lt;now&gt;</p><p>[[/check skill=perception dc=15]]</p>',
    );
  });

  it('posts an item card with the actor uuid and quoted activity', async () => {
    const { mock, createDocuments } = client();
    await handleUseItem({ actor: 'Ossul', item: 'crossbow', activity: 'Poison Bolt' }, mock);
    const message = sent(createDocuments);
    expect(message.content).toBe(
      `<p>[[/item Actor.${ACTOR}.Item.${ITEM} activity="Poison Bolt"]]</p>`,
    );
    expect(message.speaker).toEqual({ actor: ACTOR, alias: 'Ossul' });
    await expect(
      handleUseItem({ actor: 'Ossul', item: 'crossbow', activity: 'a"b' }, mock),
    ).rejects.toThrow(/quotes/);
  });

  it('draws from a world table and posts the matching row', async () => {
    const { mock, createDocuments } = client(0.99);
    const out = (await handleDrawTable({ table: 'wild magic' }, mock)).content[0] as {
      text: string;
    };
    expect(out.text).toContain('→ **4**');
    expect(sent(createDocuments).content).toContain('Frogs');
    expect(sent(createDocuments).content).toContain('<h3>Wild Magic</h3>');
  });
});
