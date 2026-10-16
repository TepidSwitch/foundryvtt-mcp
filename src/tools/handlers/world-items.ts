/**
 * @fileoverview World item create / update / delete (items that are not on an actor)
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import { type Rec, str } from './dnd5e.js';
import { resolveFolder } from './import-place.js';
import { resolveByRef, snapshotOf } from './refs.js';
import { withToolError } from './utils.js';

function text(t: string) {
  return { content: [{ type: 'text', text: t }] };
}

function worldItems(foundryClient: FoundryClient): Rec[] {
  return snapshotOf(foundryClient).items as unknown as Rec[];
}

export async function handleCreateWorldItem(
  args: {
    name: string;
    type: string;
    img?: string;
    system?: Record<string, unknown>;
    folder?: string;
  },
  foundryClient: FoundryClient,
) {
  return withToolError('create item', async () => {
    const data: Rec = { name: args.name, type: args.type };
    if (args.img !== undefined) {
      data.img = args.img;
    }
    if (args.system !== undefined) {
      data.system = args.system;
    }
    if (args.folder) {
      data.folder = resolveFolder(snapshotOf(foundryClient), args.folder, 'Item');
    }
    const [created] = await foundryClient.createDocuments('Item', [data]);
    return text(
      `🎒 **World Item Created**\n**Name:** ${args.name}\n**Type:** ${args.type}\n**ID:** ${str(created?._id)}`,
    );
  });
}

export async function handleUpdateWorldItem(
  args: {
    item: string;
    name?: string;
    img?: string;
    folder?: string;
    system?: Record<string, unknown>;
  },
  foundryClient: FoundryClient,
) {
  return withToolError('update item', async () => {
    const item = resolveByRef(
      worldItems(foundryClient),
      args.item,
      'world item',
      'foundry_items search',
    );
    const oldName = str(item.name);
    const patch: Rec = {};
    if (args.name !== undefined) {
      patch.name = args.name;
    }
    if (args.img !== undefined) {
      patch.img = args.img;
    }
    if (args.folder !== undefined) {
      patch.folder = resolveFolder(snapshotOf(foundryClient), args.folder, 'Item');
    }
    if (args.system !== undefined) {
      patch.system = args.system;
    }
    if (Object.keys(patch).length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'Give at least one field to change');
    }
    await foundryClient.updateDocuments('Item', [{ _id: str(item._id), ...patch }]);
    return text(`✏️ **World Item Updated** "${oldName}": ${Object.keys(patch).join(', ')}`);
  });
}

export async function handleDeleteWorldItem(args: { item: string }, foundryClient: FoundryClient) {
  return withToolError('delete item', async () => {
    const item = resolveByRef(
      worldItems(foundryClient),
      args.item,
      'world item',
      'foundry_items search',
    );
    await foundryClient.deleteDocuments('Item', [str(item._id)]);
    return text(
      `🗑️ **World Item Deleted** "${str(item.name)}". Undo with foundry_history_edit undo.`,
    );
  });
}
