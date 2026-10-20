/**
 * @fileoverview File tools: foundry_files (read), foundry_files_edit (write)
 */

import { z } from 'zod';
import { action, DomainTool } from '../domain.js';
import { handleBrowseFiles, handleMakeDirectory, handleUploadFile } from '../handlers/files.js';

export const filesTool = new DomainTool({
  name: 'foundry_files',
  title: 'Foundry files',
  toolset: 'files',
  write: false,
  description: "Browse Foundry's data folder (maps, tokens, audio, uploads).",
  actions: {
    browse: action({
      description:
        'List the folders and files in one folder of the Foundry data directory. path is relative to it ("" is the root, e.g. "worlds/my-world/mcp-uploads"). extensions filters files, e.g. [".png", ".webp"].',
      schema: z.object({
        path: z.string().optional().describe('Folder to list (default: the data root)'),
        extensions: z.array(z.string()).optional().describe('Only files with these extensions'),
        limit: z.number().optional().describe('Maximum entries to show (default 60)'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Entries to skip before the page (default 0)'),
      }),
      run: (a, ctx) => handleBrowseFiles(a, ctx.foundryClient),
    }),
  },
});

export const filesEditTool = new DomainTool({
  name: 'foundry_files_edit',
  title: 'Upload files',
  toolset: 'files',
  write: true,
  destructive: false,
  description:
    'WRITE: make folders and upload files into the Foundry data folder. Only adds; nothing is overwritten or deleted (use the webdav tools for that). Needs FOUNDRY_WRITE_ENABLED=true and a GM login. Folders under modules/ and systems/ are refused.',
  actions: {
    mkdir: action({
      description: 'Create a folder, with any missing parent folders. Fine if it already exists.',
      schema: z.object({
        path: z.string().describe('Folder path relative to the data folder, e.g. "assets/maps"'),
      }),
      run: (a, ctx) => handleMakeDirectory(a, ctx.foundryClient),
    }),
    upload: action({
      description:
        'Upload a file from the machine running this server (an image, audio, video or PDF up to 25 MB) into the data folder, by default worlds/<world>/mcp-uploads/. Returns the path to use for scene backgrounds, token art or playlist sounds.',
      schema: z.object({
        local_path: z.string().describe('Absolute path of the file on this machine'),
        filename: z
          .string()
          .optional()
          .describe('Name to store it under (default: the original name)'),
        folder: z
          .string()
          .optional()
          .describe('Destination folder (default worlds/<world>/mcp-uploads)'),
      }),
      run: (a, ctx) => handleUploadFile(a, ctx.foundryClient),
    }),
  },
});
