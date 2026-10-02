import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { handleWriteSessionNotes, linkEntities, markdownToHtml } from '../session-notes.js';

describe('markdownToHtml', () => {
  it('converts headings, lists, emphasis and escapes html', () => {
    const html = markdownToHtml('# Day 1\nThey met **Ossul** <b>\n\n- one\n- two\n\n1. a');
    expect(html).toContain('<h2>Day 1</h2>');
    expect(html).toContain('<strong>Ossul</strong>');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('<ul>\n<li>one</li>\n<li>two</li>\n</ul>');
    expect(html).toContain('<ol>');
  });
});

describe('linkEntities', () => {
  const targets = [
    { type: 'Actor' as const, id: 'AAAAAAAAAAAAAAAA', name: 'Dande Lyon' },
    { type: 'Scene' as const, id: 'BBBBBBBBBBBBBBBB', name: 'Dande' },
    { type: 'Actor' as const, id: 'CCCCCCCCCCCCCCCC', name: 'Ivan' },
  ];
  it('links longest name once and never inside tags', () => {
    const { html, linked } = linkEntities(
      '<p>Dande Lyon met Ivan. <a href="Ivan">x</a></p>',
      targets,
    );
    expect(html).toContain('@UUID[Actor.AAAAAAAAAAAAAAAA]{Dande Lyon}');
    expect(html).toContain('@UUID[Actor.CCCCCCCCCCCCCCCC]{Ivan}');
    expect(html).toContain('<a href="Ivan">');
    expect(linked.map((t) => t.name).sort()).toEqual(['Dande Lyon', 'Ivan']);
  });
  it('ignores short names and partial words', () => {
    const { html } = linkEntities('<p>Ivanhoe</p>', targets);
    expect(html).toBe('<p>Ivanhoe</p>');
  });
});

describe('handleWriteSessionNotes', () => {
  const makeClient = () =>
    ({
      getWorldData: () => ({
        actors: [{ _id: 'AAAAAAAAAAAAAAAA', name: 'Dande Lyon' }],
        scenes: [],
        journal: [],
      }),
      createJournalEntry: vi.fn(async (name: string) => ({
        _id: 'JJJJJJJJJJJJJJJJ',
        name,
        pages: [{}],
      })),
    }) as unknown as FoundryClient & { createJournalEntry: ReturnType<typeof vi.fn> };

  it('creates a linked GM-only entry', async () => {
    const client = makeClient();
    const res = await handleWriteSessionNotes(
      { title: 'Session 5', notes: 'Dande Lyon fled.' },
      client,
    );
    const [name, pages, , vis] = client.createJournalEntry.mock.calls[0] as [
      string,
      Array<{ content: string }>,
      unknown,
      unknown,
    ];
    expect(name).toBe('Session 5');
    expect(pages[0]?.content).toContain('@UUID[Actor.AAAAAAAAAAAAAAAA]{Dande Lyon}');
    expect(vis).toBeUndefined();
    expect((res.content[0] as { text: string }).text).toContain('Dande Lyon (Actor)');
  });
  it('splits on ## headings when asked', async () => {
    const client = makeClient();
    await handleWriteSessionNotes(
      { title: 'S6', notes: 'Intro\n## Fight\nhit\n## Loot\ngold', split_by_heading: true },
      client,
    );
    const pages = client.createJournalEntry.mock.calls[0]?.[1] as Array<{ name: string }>;
    expect(pages.map((p) => p.name)).toEqual(['S6', 'Fight', 'Loot']);
  });
  it('rejects empty notes', async () => {
    await expect(
      handleWriteSessionNotes({ title: 't', notes: '  ' }, makeClient()),
    ).rejects.toThrow(/notes/);
  });
});
