import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import {
  handleAddPage,
  handleAppendToPage,
  handleDeleteJournal,
  handleRenameJournal,
  handleReplacePage,
} from '../journal-edits.js';

const J1 = 'JOURNALAAAAAAAAA';
const J2 = 'JOURNALBBBBBBBBB';
const P1 = 'PAGEAAAAAAAAAAAA';
const P2 = 'PAGEBBBBBBBBBBBB';

function client() {
  const calls = {
    createDocuments: vi.fn(async () => [{ _id: 'NEWPAGEAAAAAAAAA' }]),
    updateDocuments: vi.fn(async () => []),
    deleteDocuments: vi.fn(async () => []),
  };
  const journal = [
    {
      _id: J1,
      name: 'Session 1',
      pages: [
        { _id: P1, name: 'Recap', type: 'text', sort: 100000, text: { content: '<p>One</p>' } },
      ],
    },
    {
      _id: J2,
      name: 'Lore',
      pages: [
        {
          _id: P1.replace('A', 'C'),
          name: 'Gods',
          type: 'text',
          sort: 200000,
          text: { content: '<p>G</p>' },
        },
        { _id: P2, name: 'Map', type: 'image', sort: 300000 },
      ],
    },
  ];
  return {
    mock: { getWorldSnapshot: () => ({ journal }), ...calls } as unknown as FoundryClient,
    ...calls,
  };
}

describe('journal edit handlers', () => {
  it('appends html to a single-page journal without naming the page', async () => {
    const { mock, updateDocuments } = client();
    await handleAppendToPage({ journal: 'session 1', content: '<p>Two</p>' }, mock);
    expect(updateDocuments).toHaveBeenCalledWith(
      'JournalEntryPage',
      [{ _id: P1, 'text.content': '<p>One</p><p>Two</p>' }],
      `JournalEntry.${J1}`,
    );
  });

  it('converts markdown when asked', async () => {
    const { mock, updateDocuments } = client();
    await handleReplacePage(
      { journal: J1, page: 'Recap', content: '## New\n- a', format: 'markdown' },
      mock,
    );
    const sent = updateDocuments.mock.calls[0]?.[1] as Array<Record<string, string>>;
    expect(sent[0]?.['text.content']).toContain('<h3>New</h3>');
    expect(sent[0]?.['text.content']).toContain('<li>a</li>');
  });

  it('asks which page when a journal has several, and refuses non-text pages', async () => {
    const { mock, updateDocuments } = client();
    await expect(handleAppendToPage({ journal: 'Lore', content: 'x' }, mock)).rejects.toThrow(
      /2 pages — say which/,
    );
    await expect(
      handleReplacePage({ journal: 'Lore', page: 'Map', content: 'x' }, mock),
    ).rejects.toThrow(/image page/);
    expect(updateDocuments).not.toHaveBeenCalled();
  });

  it('adds a page after the last one', async () => {
    const { mock, createDocuments } = client();
    await handleAddPage({ journal: 'Lore', name: 'Titans', content: 'T' }, mock);
    expect(createDocuments).toHaveBeenCalledWith(
      'JournalEntryPage',
      [{ name: 'Titans', type: 'text', text: { content: 'T', format: 1 }, sort: 400000 }],
      `JournalEntry.${J2}`,
    );
  });

  it('renames an entry or a page, and deletes an entry or a page', async () => {
    const { mock, updateDocuments, deleteDocuments } = client();
    await handleRenameJournal({ journal: 'Session 1', name: 'Session One' }, mock);
    expect(updateDocuments).toHaveBeenLastCalledWith('JournalEntry', [
      { _id: J1, name: 'Session One' },
    ]);
    await handleRenameJournal({ journal: 'Session 1', page: 'Recap', name: 'Summary' }, mock);
    expect(updateDocuments).toHaveBeenLastCalledWith(
      'JournalEntryPage',
      [{ _id: P1, name: 'Summary' }],
      `JournalEntry.${J1}`,
    );
    await handleDeleteJournal({ journal: 'Session 1', page: 'Recap' }, mock);
    expect(deleteDocuments).toHaveBeenLastCalledWith(
      'JournalEntryPage',
      [P1],
      `JournalEntry.${J1}`,
    );
    await handleDeleteJournal({ journal: 'Session 1' }, mock);
    expect(deleteDocuments).toHaveBeenLastCalledWith('JournalEntry', [J1]);
  });
});
