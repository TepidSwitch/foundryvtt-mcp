/**
 * @fileoverview Edit existing journal entries: add, append to and replace pages,
 * rename, delete
 *
 * Pages are `JournalEntryPage` documents embedded in the entry, so these writes
 * carry `parentUuid: JournalEntry.<id>`. Only text pages can be appended to or
 * replaced; their HTML lives in `text.content`.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import { isRec, num, type Rec, str } from './dnd5e.js';
import { resolveByRef, snapshotOf } from './refs.js';
import { markdownToHtml } from './session-notes.js';
import { withToolError } from './utils.js';

export type ContentFormat = 'html' | 'markdown';

function text(t: string) {
  return { content: [{ type: 'text', text: t }] };
}

function toHtml(content: string, format: ContentFormat | undefined): string {
  return format === 'markdown' ? markdownToHtml(content) : content;
}

function resolveJournal(foundryClient: FoundryClient, ref: string): Rec {
  return resolveByRef(
    snapshotOf(foundryClient).journal as unknown as Rec[],
    ref,
    'journal',
    'foundry_journals search',
  );
}

function pagesOf(journal: Rec): Rec[] {
  return (Array.isArray(journal.pages) ? journal.pages : []).filter(isRec);
}

/** The named page, or the only page when the journal has just one. */
function pickPage(journal: Rec, ref: string | undefined): Rec {
  const pages = pagesOf(journal);
  if (!ref) {
    if (pages.length === 1 && pages[0]) {
      return pages[0];
    }
    throw new McpError(
      ErrorCode.InvalidParams,
      `"${str(journal.name)}" has ${pages.length} pages — say which: ${pages
        .slice(0, 10)
        .map((p) => `${str(p.name)} (${str(p._id)})`)
        .join('; ')}`,
    );
  }
  return resolveByRef(pages, ref, `page of "${str(journal.name)}"`, 'foundry_journals get');
}

function textContentOf(page: Rec): string {
  if (str(page.type, 'text') !== 'text') {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Page "${str(page.name)}" is a ${str(page.type)} page; only text pages can be edited here`,
    );
  }
  return isRec(page.text) ? str(page.text.content) : '';
}

export async function handleAddPage(
  args: { journal: string; name: string; content: string; format?: ContentFormat },
  foundryClient: FoundryClient,
) {
  return withToolError('add journal page', async () => {
    const journal = resolveJournal(foundryClient, args.journal);
    const last = Math.max(0, ...pagesOf(journal).map((p) => num(p.sort)));
    const [created] = await foundryClient.createDocuments(
      'JournalEntryPage',
      [
        {
          name: args.name,
          type: 'text',
          text: { content: toHtml(args.content, args.format), format: 1 },
          sort: last + 100000,
        },
      ],
      `JournalEntry.${str(journal._id)}`,
    );
    return text(
      `📄 **Page Added** "${args.name}" to "${str(journal.name)}"\n**ID:** ${str(created?._id)}`,
    );
  });
}

export async function handleAppendToPage(
  args: { journal: string; page?: string; content: string; format?: ContentFormat },
  foundryClient: FoundryClient,
) {
  return withToolError('append to journal page', async () => {
    const journal = resolveJournal(foundryClient, args.journal);
    const page = pickPage(journal, args.page);
    const existing = textContentOf(page);
    await foundryClient.updateDocuments(
      'JournalEntryPage',
      [{ _id: str(page._id), 'text.content': existing + toHtml(args.content, args.format) }],
      `JournalEntry.${str(journal._id)}`,
    );
    return text(`➕ **Appended** to "${str(page.name)}" in "${str(journal.name)}"`);
  });
}

export async function handleReplacePage(
  args: { journal: string; page?: string; content: string; format?: ContentFormat },
  foundryClient: FoundryClient,
) {
  return withToolError('replace journal page', async () => {
    const journal = resolveJournal(foundryClient, args.journal);
    const page = pickPage(journal, args.page);
    textContentOf(page);
    await foundryClient.updateDocuments(
      'JournalEntryPage',
      [{ _id: str(page._id), 'text.content': toHtml(args.content, args.format) }],
      `JournalEntry.${str(journal._id)}`,
    );
    return text(
      `✏️ **Page Replaced** "${str(page.name)}" in "${str(journal.name)}". Undo with foundry_history_edit undo.`,
    );
  });
}

export async function handleRenameJournal(
  args: { journal: string; page?: string; name: string },
  foundryClient: FoundryClient,
) {
  return withToolError('rename journal', async () => {
    const journal = resolveJournal(foundryClient, args.journal);
    // Read names before writing: the cache already holds the new name afterwards.
    const journalName = str(journal.name);
    if (args.page) {
      const page = pickPage(journal, args.page);
      const pageName = str(page.name);
      await foundryClient.updateDocuments(
        'JournalEntryPage',
        [{ _id: str(page._id), name: args.name }],
        `JournalEntry.${str(journal._id)}`,
      );
      return text(`✏️ **Page Renamed** "${pageName}" → "${args.name}"`);
    }
    await foundryClient.updateDocuments('JournalEntry', [
      { _id: str(journal._id), name: args.name },
    ]);
    return text(`✏️ **Journal Renamed** "${journalName}" → "${args.name}"`);
  });
}

export async function handleDeleteJournal(
  args: { journal: string; page?: string },
  foundryClient: FoundryClient,
) {
  return withToolError('delete journal', async () => {
    const journal = resolveJournal(foundryClient, args.journal);
    if (args.page) {
      const page = pickPage(journal, args.page);
      await foundryClient.deleteDocuments(
        'JournalEntryPage',
        [str(page._id)],
        `JournalEntry.${str(journal._id)}`,
      );
      return text(
        `🗑️ **Page Deleted** "${str(page.name)}" from "${str(journal.name)}". Undo with foundry_history_edit undo.`,
      );
    }
    await foundryClient.deleteDocuments('JournalEntry', [str(journal._id)]);
    return text(
      `🗑️ **Journal Deleted** "${str(journal.name)}" with ${pagesOf(journal).length} page(s). Undo with foundry_history_edit undo.`,
    );
  });
}
