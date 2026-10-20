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
import { handleCreateMacro, handleDeleteMacro, handleUpdateMacro } from '../handlers/macros.js';

const type = z.enum(FOLDER_DOCUMENT_TYPES as [string, ...string[]]).describe('Document type');

export const worldEditTool = new DomainTool({
  name: 'foundry_world_edit',
  title: 'Organise the world',
  toolset: 'world',
  write: true,
  destructive: true,
  description:
    'WRITE: create folders, file documents, and create/edit/delete macros into them in the live world. Needs FOUNDRY_WRITE_ENABLED=true and a GM login; writes are logged and revertible with foundry_history_edit. List folders with foundry_world browse kind=folders.',
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
    create_macro: action({
      description:
        'Create a macro. type "chat" posts command as a chat message; type "script" holds JavaScript and needs the MACRO_SCRIPT permission for the connected user. Macros are never executed by this server.',
      schema: z.object({
        name: z.string().describe('Macro name'),
        type: z.enum(['chat', 'script']).describe('chat or script'),
        command: z.string().describe('Chat text or JavaScript source'),
        img: z.string().optional().describe('Icon path'),
        folder: z.string().optional().describe('Macro folder id or name'),
      }),
      run: (a, ctx) => handleCreateMacro(a, ctx.foundryClient),
    }),
    update_macro: action({
      description:
        "Change a macro's name, type, command, icon or folder (script edits need MACRO_SCRIPT).",
      schema: z.object({
        macro: z.string().describe('Macro id or name (partial ok)'),
        name: z.string().optional().describe('New name'),
        type: z.enum(['chat', 'script']).optional().describe('New type'),
        command: z.string().optional().describe('New command'),
        img: z.string().optional().describe('New icon path'),
        folder: z.string().nullable().optional().describe('Folder id or name; null for top level'),
      }),
      run: (a, ctx) => handleUpdateMacro(a, ctx.foundryClient),
    }),
    delete_macro: action({
      description: 'Delete a macro.',
      schema: z.object({ macro: z.string().describe('Macro id or name (partial ok)') }),
      run: (a, ctx) => handleDeleteMacro(a, ctx.foundryClient),
    }),
  },
});
