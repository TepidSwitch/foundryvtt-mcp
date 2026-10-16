/**
 * @fileoverview World organisation tools: foundry_world_edit (write)
 */

import { z } from 'zod';
import { action, DomainTool } from '../domain.js';
import {
  FOLDER_DOCUMENT_TYPES,
  handleCreateFolder,
  handleMoveToFolder,
} from '../handlers/folders.js';

const type = z.enum(FOLDER_DOCUMENT_TYPES as [string, ...string[]]).describe('Document type');

export const worldEditTool = new DomainTool({
  name: 'foundry_world_edit',
  title: 'Organise the world',
  toolset: 'world',
  write: true,
  destructive: true,
  description:
    'WRITE: create folders and file documents into them in the live world. Needs FOUNDRY_WRITE_ENABLED=true and a GM login; writes are logged and revertible with foundry_history_edit. List folders with foundry_world browse kind=folders.',
  actions: {
    create_folder: action({
      description:
        'Create a folder for one document type (Actor, Item, Scene, JournalEntry, Playlist, RollTable, Macro), optionally inside another folder of that type (max 4 levels).',
      schema: z.object({
        name: z.string().describe('Folder name'),
        type,
        parent: z.string().optional().describe('Parent folder id or name (same type)'),
        color: z.string().optional().describe('Colour, e.g. "#3355aa"'),
        description: z.string().optional().describe('Description'),
      }),
      run: (a, ctx) => handleCreateFolder(a, ctx.foundryClient),
    }),
    move_to_folder: action({
      description:
        'File a document into a folder of the same type, or omit folder to move it back to the top level.',
      schema: z.object({
        type,
        document: z.string().describe('Document id or name (partial ok)'),
        folder: z.string().optional().describe('Folder id or name; omit for the top level'),
      }),
      run: (a, ctx) => handleMoveToFolder(a, ctx.foundryClient),
    }),
  },
});
