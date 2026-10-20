/**
 * @fileoverview Macro CRUD (create/update/delete; macros are never executed here)
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import { type Rec, str } from './dnd5e.js';
import { resolveByRef, snapshotOf } from './refs.js';
import { withToolError } from './utils.js';

function text(t: string) {
  return { content: [{ type: 'text', text: t }] };
}

function findMacro(foundryClient: FoundryClient, ref: string): Rec {
  return resolveByRef(
    snapshotOf(foundryClient).macros as Rec[],
    ref,
    'macro',
    'foundry_world browse kind="macros"',
  );
}

function macroFolder(foundryClient: FoundryClient, ref: string): string {
  const folders = (snapshotOf(foundryClient).folders as Rec[]).filter(
    (f) => str(f.type) === 'Macro',
  );
  return str(resolveByRef(folders, ref, 'Macro folder', 'foundry_world browse kind="folders"')._id);
}

export async function handleCreateMacro(
  args: { name: string; type: 'chat' | 'script'; command: string; img?: string; folder?: string },
  foundryClient: FoundryClient,
) {
  return withToolError('create macro', async () => {
    const data: Rec = { name: args.name, type: args.type, command: args.command, scope: 'global' };
    if (args.img) {
      data.img = args.img;
    }
    if (args.folder) {
      data.folder = macroFolder(foundryClient, args.folder);
    }
    const [created] = await foundryClient.createDocuments('Macro', [data]);
    return text(`📜 **Macro Created** "${args.name}" (${args.type})\n**ID:** ${str(created?._id)}`);
  });
}

export async function handleUpdateMacro(
  args: {
    macro: string;
    name?: string;
    type?: 'chat' | 'script';
    command?: string;
    img?: string;
    folder?: string | null;
  },
  foundryClient: FoundryClient,
) {
  return withToolError('update macro', async () => {
    const macro = findMacro(foundryClient, args.macro);
    const update: Rec = { _id: str(macro._id) };
    for (const key of ['name', 'type', 'command', 'img'] as const) {
      if (args[key] !== undefined) {
        update[key] = args[key];
      }
    }
    if (args.folder !== undefined) {
      update.folder =
        args.folder === null || args.folder === '' ? null : macroFolder(foundryClient, args.folder);
    }
    if (Object.keys(update).length === 1) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Nothing to update: give name, type, command, img or folder',
      );
    }
    await foundryClient.updateDocuments('Macro', [update]);
    return text(
      `📜 **Macro Updated** "${str(macro.name)}": ${Object.keys(update)
        .filter((k) => k !== '_id')
        .join(', ')}\n**ID:** ${str(macro._id)}`,
    );
  });
}

export async function handleDeleteMacro(args: { macro: string }, foundryClient: FoundryClient) {
  return withToolError('delete macro', async () => {
    const macro = findMacro(foundryClient, args.macro);
    await foundryClient.deleteDocuments('Macro', [str(macro._id)]);
    return text(
      `🗑️ **Macro Deleted** "${str(macro.name)}" (revert with foundry_history_edit undo)\n**ID:** ${str(macro._id)}`,
    );
  });
}
