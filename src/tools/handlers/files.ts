/**
 * @fileoverview Files tools: browse the Foundry data folder, make folders, upload
 */

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import {
  ALLOWED_UPLOAD_EXTENSIONS,
  contentTypeFor,
  MAX_UPLOAD_BYTES,
  normalizeDataPath,
  sanitizeFilename,
} from '../../foundry/files.js';
import { pageSlice, withToolError } from './utils.js';

function text(t: string) {
  return { content: [{ type: 'text', text: t }] };
}

export async function handleBrowseFiles(
  args: { path?: string; extensions?: string[]; limit?: number; offset?: number },
  foundryClient: FoundryClient,
) {
  return withToolError('browse files', async () => {
    const limit = args.limit ?? 60;
    const listing = await foundryClient.browseFiles(args.path ?? '', {
      ...(args.extensions ? { extensions: args.extensions } : {}),
    });
    const dirs = listing.dirs.map((d) => `- 📁 ${d}`);
    const files = listing.files.map((f) => `- ${f}`);
    const page = pageSlice([...dirs, ...files], limit, args.offset);
    return text(
      `📂 **${listing.target || '(data folder root)'}** — ${dirs.length} folders, ${files.length} files\n${page.items.join('\n') || '_Empty._'}${page.footer}`,
    );
  });
}

export async function handleMakeDirectory(args: { path: string }, foundryClient: FoundryClient) {
  return withToolError('make folder', async () => {
    const created = await foundryClient.ensureDirectory(args.path);
    return text(
      created.length > 0
        ? `📁 **Folder Ready** ${normalizeDataPath(args.path)}${created.length > 1 ? ` (created ${created.length} levels)` : ''}`
        : `📁 ${normalizeDataPath(args.path)} already exists.`,
    );
  });
}

/** Default upload folder: worlds/<world>/mcp-uploads */
export function defaultUploadDir(foundryClient: FoundryClient): string {
  const world = foundryClient.getWorldId();
  if (!world) {
    throw new McpError(
      ErrorCode.InternalError,
      'The world is not loaded yet - try again in a moment',
    );
  }
  return `worlds/${world}/mcp-uploads`;
}

export async function handleUploadFile(
  args: { local_path: string; filename?: string; folder?: string },
  foundryClient: FoundryClient,
) {
  return withToolError('upload file', async () => {
    const source = args.local_path;
    const name = sanitizeFilename(args.filename ?? basename(source));
    if (!contentTypeFor(name)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Only these file types can be uploaded: ${ALLOWED_UPLOAD_EXTENSIONS.join(' ')}`,
      );
    }
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(source);
    } catch {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No file at ${source} on the machine running this server`,
      );
    }
    if (!info.isFile()) {
      throw new McpError(ErrorCode.InvalidParams, `${source} is not a file`);
    }
    if (info.size > MAX_UPLOAD_BYTES) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `${source} is ${(info.size / 1048576).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / 1048576} MB`,
      );
    }
    const dir = args.folder ?? defaultUploadDir(foundryClient);
    const path = await foundryClient.uploadFile(await readFile(source), name, dir);
    return text(
      `⬆️ **Uploaded** ${name} (${(info.size / 1024).toFixed(0)} KB)\n**Path:** \`${path}\`\nUse this path as a scene background, token image or playlist sound. Uploads are not undoable from here; delete the file with the webdav tools if needed.`,
    );
  });
}
