/**
 * @fileoverview Journal tools: foundry_journals (read), foundry_journals_edit (write)
 */

import { z } from 'zod';
import { action, DomainTool } from '../domain.js';
import { handleCreateJournalEntry } from '../handlers/journal-mutations.js';
import { handleGetJournal, handleSearchJournals } from '../handlers/journals.js';
import { handleWriteSessionNotes } from '../handlers/session-notes.js';

const visibility = z
  .enum(['gm-only', 'observer', 'owner'])
  .optional()
  .describe('Who can read it (default gm-only)');
const folder = z.string().optional().describe('Existing journal folder (id or name)');

export const journalsTool = new DomainTool({
  name: 'foundry_journals',
  title: 'Foundry journals',
  toolset: 'journals',
  write: false,
  description: 'Read journal entries (notes, lore, handouts).',
  actions: {
    search: action({
      description: 'Search journal entries by name and page content. Prints journal ids.',
      schema: z.object({
        query: z.string().describe('Keyword to look for'),
        limit: z.number().optional().describe('Maximum results (default 10)'),
      }),
      run: (a, ctx) => handleSearchJournals(a, ctx.foundryClient),
    }),
    get: action({
      description:
        'One journal entry by id with its page text. Page bodies are HTML-stripped and cut to their first 500 characters ("..." marks a cut).',
      schema: z.object({
        journalId: z.string().describe('Id of the journal entry'),
      }),
      run: (a, ctx) => handleGetJournal(a, ctx.foundryClient),
    }),
  },
});

export const journalsEditTool = new DomainTool({
  name: 'foundry_journals_edit',
  title: 'Write journals',
  toolset: 'journals',
  write: true,
  destructive: false,
  description:
    'WRITE: create journal entries in the live world. Only creates; nothing existing is modified. Needs FOUNDRY_WRITE_ENABLED=true and a GM login.',
  actions: {
    create: action({
      description:
        'Create a new journal entry with one or more text pages (HTML content), optionally in a folder. Always creates a new entry.',
      schema: z.object({
        name: z.string().describe('Entry name'),
        pages: z
          .array(z.object({ name: z.string(), content: z.string() }))
          .min(1)
          .describe('Pages: [{name, content}]'),
        folder,
        visibility,
      }),
      run: (a, ctx) => handleCreateJournalEntry(a, ctx.foundryClient),
    }),
    write_session_notes: action({
      description:
        'Turn a markdown session recap into a NEW journal entry: headings, bullets and bold become HTML, and names of world actors, scenes and journals become @UUID links (link_entities, default on; names under 4 characters skipped). split_by_heading=true makes each "## " section its own page.',
      schema: z.object({
        title: z.string().describe('Entry title'),
        notes: z.string().describe('The recap as markdown'),
        folder,
        visibility,
        link_entities: z.boolean().optional().describe('Link world entity names (default true)'),
        split_by_heading: z.boolean().optional().describe('Make each "## " section its own page'),
      }),
      run: (a, ctx) => handleWriteSessionNotes(a, ctx.foundryClient),
    }),
  },
});
