/**
 * @fileoverview Folders: create them and file documents into them
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { WorldData } from '../../foundry/types.js';
import { type Rec, str } from './dnd5e.js';
import { resolveByRef, snapshotOf } from './refs.js';
import { withToolError } from './utils.js';

/** Foundry nests folders at most this deep (CONST.FOLDER_MAX_DEPTH). */
const FOLDER_MAX_DEPTH = 4;

/** Document types that can be filed in a folder here, with their cached collection. */
const COLLECTIONS: Record<string, (s: WorldData) => Rec[]> = {
  Actor: (s) => s.actors as unknown as Rec[],
  Item: (s) => s.items as unknown as Rec[],
  Scene: (s) => s.scenes as unknown as Rec[],
  JournalEntry: (s) => s.journal as unknown as Rec[],
  Playlist: (s) => s.playlists as Rec[],
  RollTable: (s) => s.tables as Rec[],
  Macro: (s) => s.macros as Rec[],
};
export const FOLDER_DOCUMENT_TYPES = Object.keys(COLLECTIONS);

function text(t: string) {
  return { content: [{ type: 'text', text: t }] };
}

function depthOf(folders: Rec[], folder: Rec): number {
  let depth = 1;
  let cur: Rec | undefined = folder;
  const seen = new Set<string>();
  while (cur && typeof cur.folder === 'string' && !seen.has(str(cur._id))) {
    seen.add(str(cur._id));
    const parentId: string = cur.folder;
    cur = folders.find((f) => f._id === parentId);
    depth += 1;
  }
  return depth;
}

function findFolder(snapshot: WorldData, ref: string, type: string): Rec {
  const folders = (snapshot.folders as Rec[]).filter((f) => str(f.type) === type);
  return resolveByRef(
    folders,
    ref,
    `${type} folder`,
    `foundry_world browse kind="folders" folder_type="${type}"`,
  );
}

export async function handleCreateFolder(
  args: { name: string; type: string; parent?: string; color?: string; description?: string },
  foundryClient: FoundryClient,
) {
  return withToolError('create folder', async () => {
    if (!FOLDER_DOCUMENT_TYPES.includes(args.type)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `type must be one of ${FOLDER_DOCUMENT_TYPES.join(', ')}`,
      );
    }
    const snapshot = snapshotOf(foundryClient);
    const data: Rec = { name: args.name, type: args.type };
    if (args.parent) {
      const parent = findFolder(snapshot, args.parent, args.type);
      if (depthOf(snapshot.folders as Rec[], parent) >= FOLDER_MAX_DEPTH) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Folders can only nest ${FOLDER_MAX_DEPTH} levels deep; "${str(parent.name)}" is already at the limit`,
        );
      }
      data.folder = str(parent._id);
    }
    if (args.color !== undefined) {
      data.color = args.color;
    }
    if (args.description !== undefined) {
      data.description = args.description;
    }
    const [created] = await foundryClient.createDocuments('Folder', [data]);
    return text(
      `📁 **Folder Created** "${args.name}" (${args.type})${args.parent ? ` inside "${args.parent}"` : ''}\n**ID:** ${str(created?._id)}`,
    );
  });
}

export async function handleMoveToFolder(
  args: { type: string; document: string; folder?: string },
  foundryClient: FoundryClient,
) {
  return withToolError('move to folder', async () => {
    const collection = COLLECTIONS[args.type];
    if (!collection) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `type must be one of ${FOLDER_DOCUMENT_TYPES.join(', ')}`,
      );
    }
    const snapshot = snapshotOf(foundryClient);
    const doc = resolveByRef(
      collection(snapshot),
      args.document,
      args.type,
      'foundry_world search',
    );
    const target = args.folder ? findFolder(snapshot, args.folder, args.type) : null;
    await foundryClient.updateDocuments(args.type, [
      { _id: str(doc._id), folder: target ? str(target._id) : null },
    ]);
    return text(
      `📁 **Moved** ${args.type} "${str(doc.name)}" ${target ? `into folder "${str(target.name)}"` : 'out of its folder (top level)'}`,
    );
  });
}
