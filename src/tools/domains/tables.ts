/**
 * @fileoverview Roll table tool: foundry_tables_edit (write)
 */

import { z } from 'zod';
import { action, DomainTool } from '../domain.js';
import {
  handleAddResults,
  handleCreateTable,
  handleDeleteTable,
  handleRemoveResults,
  handleResetTable,
  handleUpdateTable,
} from '../handlers/tables.js';

const table = z.string().describe('Table id or name (partial ok)');
const result = z.object({
  text: z.string().describe('Result text (HTML ok)'),
  range: z
    .array(z.number().int())
    .length(2)
    .optional()
    .describe('[low, high] roll range; omit to continue after the last row (width = weight)'),
  weight: z.number().int().min(1).optional().describe('Weight (default 1)'),
  documentUuid: z
    .string()
    .optional()
    .describe('Link the row to a document, e.g. "Item.<id>" or "Compendium.dnd5e.items.Item.<id>"'),
});

export const tablesEditTool = new DomainTool({
  name: 'foundry_tables_edit',
  title: 'Edit roll tables',
  toolset: 'tables',
  write: true,
  destructive: true,
  description:
    'WRITE: create and edit world roll tables and their rows. Ranges must not overlap. Needs FOUNDRY_WRITE_ENABLED=true and a GM login; revert with foundry_history_edit. Draw with foundry_chat_edit draw_table; list with foundry_world browse kind=tables.',
  actions: {
    create_table: action({
      description:
        'Create a roll table. Formula defaults to 1dN where N is the highest range end. Set replacement=false to make each row drawable only once.',
      schema: z.object({
        name: z.string().describe('Table name'),
        formula: z.string().optional().describe('Dice formula, e.g. "1d20" (default derived)'),
        replacement: z
          .boolean()
          .optional()
          .describe('Drawn rows go back in the pool (default true)'),
        description: z.string().optional().describe('Description'),
        results: z.array(result).min(1).describe('Rows'),
        folder: z.string().optional().describe('RollTable folder id or name'),
      }),
      run: (a, ctx) => handleCreateTable(a, ctx.foundryClient),
    }),
    update_table: action({
      description:
        "Change a table's name, formula, replacement, displayRoll, description or folder.",
      schema: z.object({
        table,
        name: z.string().optional().describe('New name'),
        formula: z.string().optional().describe('New dice formula'),
        replacement: z.boolean().optional().describe('Drawn rows return to the pool'),
        displayRoll: z.boolean().optional().describe('Show the roll in chat'),
        description: z.string().optional().describe('New description'),
        folder: z.string().nullable().optional().describe('Folder id or name; null for top level'),
      }),
      run: (a, ctx) => handleUpdateTable(a, ctx.foundryClient),
    }),
    add_results: action({
      description:
        'Append rows to a table. A simple 1dN formula is widened if the new rows exceed it.',
      schema: z.object({ table, results: z.array(result).min(1).describe('Rows to add') }),
      run: (a, ctx) => handleAddResults(a, ctx.foundryClient),
    }),
    remove_results: action({
      description: 'Remove rows by result id (ids are shown by foundry_world browse on the table).',
      schema: z.object({ table, results: z.array(z.string()).min(1).describe('Result ids') }),
      run: (a, ctx) => handleRemoveResults(a, ctx.foundryClient),
    }),
    delete_table: action({
      description: 'Delete a whole roll table.',
      schema: z.object({ table }),
      run: (a, ctx) => handleDeleteTable(a, ctx.foundryClient),
    }),
    reset_table: action({
      description: 'Mark every drawn row as undrawn again (for tables with replacement=false).',
      schema: z.object({ table }),
      run: (a, ctx) => handleResetTable(a, ctx.foundryClient),
    }),
  },
});
