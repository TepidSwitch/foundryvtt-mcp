/**
 * @fileoverview Pure helpers for Foundry file management (browse, mkdir, upload)
 *
 * Protocol (checked against FilePicker in Foundry 14): directory operations go
 * over the socket event `manageFiles` with `{action, storage:"data", target}`;
 * uploads are a multipart POST to `/upload` with fields `source`, `target` and
 * `upload`, answered with `{path}` or `{error}`.
 */

import { basename, extname } from 'node:path';

/** Upload types accepted here. Narrow on purpose: this is for maps, art and audio. */
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
};

export const ALLOWED_UPLOAD_EXTENSIONS = Object.keys(CONTENT_TYPES);

/** Largest file this server will upload. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function contentTypeFor(filename: string): string | undefined {
  return CONTENT_TYPES[extname(filename).toLowerCase()];
}

/** Keeps letters, digits, dot, dash and underscore; other characters become "-". */
export function sanitizeFilename(name: string): string {
  const base = basename(name.replace(/\\/g, '/'));
  const rawExt = extname(base).toLowerCase();
  const ext = rawExt.length > 1 ? rawExt : '';
  const stem = base
    .slice(0, base.length - rawExt.length)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `${stem || 'file'}${ext}`;
}

/** A lowercase slug for building file names from titles. */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'map'
  );
}

const PROTECTED_ROOTS = new Set(['modules', 'systems', 'core', 'node_modules']);

/**
 * Validates a data-folder path (relative, forward slashes, no "..") and returns
 * it without leading or trailing slashes. Uploads and folders under the
 * package roots (modules, systems) are refused because Foundry itself warns
 * that packages overwrite them on update.
 */
export function normalizeDataPath(path: string, options: { allowRoot?: boolean } = {}): string {
  const cleaned = path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (cleaned === '') {
    if (options.allowRoot) {
      return '';
    }
    throw new Error('A folder path is required');
  }
  const segments = cleaned.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`Invalid folder path "${path}": no empty, "." or ".." segments`);
  }
  if (/^[a-z]+:/i.test(cleaned)) {
    throw new Error(`Invalid folder path "${path}": give a path inside the Foundry data folder`);
  }
  return cleaned;
}

/** Rejects writing into folders Foundry manages for packages. */
export function assertWritableDataPath(path: string): void {
  const root = path.split('/')[0] ?? '';
  if (PROTECTED_ROOTS.has(root)) {
    throw new Error(
      `"${root}/" holds installed packages and is replaced on update; use a folder under worlds/ or your own folder`,
    );
  }
}

/** Every folder from the first segment down to `path`, shortest first. */
export function folderChain(path: string): string[] {
  const segments = path.split('/');
  return segments.map((_, i) => segments.slice(0, i + 1).join('/'));
}
