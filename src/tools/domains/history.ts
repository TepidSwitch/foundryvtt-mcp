/**
 * @fileoverview Write history tools: foundry_history (read), foundry_history_edit (write)
 */

import { z } from 'zod';
import { action, DomainTool } from '../domain.js';
import { handleGetWriteLog, handleUndoLastWrite } from '../handlers/write-safety.js';

export const historyTool = new DomainTool({
  name: 'foundry_history',
  title: 'Write history',
  toolset: 'history',
  write: false,
  description: 'Read the log of world writes made through this server.',
  actions: {
    log: action({
      description:
        'Most recent world writes this server made (create/update/delete, which documents, when, undone or dry run). Survives restarts. Gives the write_id for undo. Does not cover changes made in Foundry itself.',
      schema: z.object({
        limit: z.number().optional().describe('How many entries (default 15, max 100)'),
      }),
      run: (a, ctx) => handleGetWriteLog(a, ctx.foundryClient),
    }),
  },
});

export const historyEditTool = new DomainTool({
  name: 'foundry_history_edit',
  title: 'Undo writes',
  toolset: 'history',
  write: true,
  destructive: true,
  description:
    'WRITE: revert writes made through this server. Needs FOUNDRY_WRITE_ENABLED=true and a GM login.',
  actions: {
    undo: action({
      description:
        'Reverse a write: a create is deleted, an update has its touched fields restored, a delete is re-created with its original id. Defaults to the newest write not yet undone; pass write_id (from foundry_history log) for an older one. Best effort - later edits to the same document are not detected.',
      schema: z.object({
        write_id: z.string().optional().describe('Write to undo (default: newest not yet undone)'),
      }),
      run: (a, ctx) => handleUndoLastWrite(a, ctx.foundryClient),
    }),
  },
});
