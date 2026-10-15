/**
 * @fileoverview get_write_log (read) and undo_last_write (WRITE).
 */

import type { FoundryClient } from '../../foundry/client.js';
import { withToolError } from './utils.js';

export async function handleGetWriteLog(args: { limit?: number }, foundryClient: FoundryClient) {
  return withToolError('get write log', async () => {
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 15), 1), 100);
    const entries = foundryClient.audit.list(limit);
    if (entries.length === 0) {
      return { content: [{ type: 'text', text: '🧾 No writes recorded yet.' }] };
    }
    const lines = entries.map((e) => {
      const flags = [
        e.dryRun ? 'dry-run' : '',
        e.undone ? 'undone' : '',
        e.undoOf ? `undo of ${e.undoOf}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      const what = e.names.length ? e.names.join(', ') : `${e.ids.length} id(s)`;
      return `- \`${e.id}\` ${e.at} · ${e.action} ${e.type}${e.parentUuid ? ` (in ${e.parentUuid})` : ''} · ${what}${flags ? ` · _${flags}_` : ''}`;
    });
    return {
      content: [
        {
          type: 'text',
          text: `🧾 **Recent writes** (newest first)\n${lines.join('\n')}\n\nUndo the newest with foundry_history_edit undo, or pass write_id.`,
        },
      ],
    };
  });
}

export async function handleUndoLastWrite(
  args: { write_id?: string },
  foundryClient: FoundryClient,
) {
  return withToolError('undo write', async () => {
    const { undone, message } = await foundryClient.undoWrite(args.write_id);
    const what = undone.names.length ? undone.names.join(', ') : `${undone.ids.length} id(s)`;
    return {
      content: [
        {
          type: 'text',
          text: `↩️ **Undid** \`${undone.id}\` (${undone.action} ${undone.type}: ${what})\nPerformed: ${message}\n\nBest effort: edits made to the same document since then are not detected, and a field the original update newly added is not removed.`,
        },
      ],
    };
  });
}
