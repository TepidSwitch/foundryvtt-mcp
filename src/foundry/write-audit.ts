/**
 * @fileoverview Audit log, dry-run support and undo planning for world writes.
 *
 * Every `modifyDocument` write is recorded (what, which ids, and — for updates
 * and deletes — the previous source of each document when it is cached). The
 * log is kept in memory and appended to a JSONL file so `undo_last_write` still
 * works after a restart.
 *
 * Undo is best effort and says so: creates are deleted, updates restore the
 * previous value of every key the update touched, deletes are re-created with
 * their original id. Anything that changed the same document since is not
 * detected, and a key an update newly added is not removed.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';

export type WriteAction = 'create' | 'update' | 'delete';

export interface AuditEntry {
  /** Short sequential-ish id, e.g. "w-lq3k9f-1". */
  id: string;
  at: string;
  type: string;
  action: WriteAction;
  parentUuid?: string;
  /** Ids created / updated / deleted. */
  ids: string[];
  /** Display names where known. */
  names: string[];
  /** The updates that were sent (action = update). */
  updates?: Array<Record<string, unknown>>;
  /** Previous source docs (updates/deletes), when cached and not too large. */
  before?: Array<Record<string, unknown>>;
  dryRun?: boolean;
  undone?: boolean;
  /** Set on the entry produced by an undo; points at the entry it reverted. */
  undoOf?: string;
  /** Writes made inside one `FoundryClient.withBatch` call share an id and are undone together. */
  batchId?: string;
}

export interface UndoOperation {
  type: string;
  action: WriteAction;
  parentUuid?: string;
  operation: Record<string, unknown>;
}

/**
 * Foundry 14 wire form for removing a key in an update. The `-=key` syntax is
 * deprecated and removed in v16 (`ForcedDeletion` in foundry.mjs, with
 * `OPERATOR_IDENTIFIER` = "__$OPERATOR$__").
 */
export const FORCED_DELETION = { __$OPERATOR$__: 'ForcedDeletion' } as const;

const MAX_BEFORE_BYTES = 400_000;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function defaultAuditPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return join(
      env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
      'foundryvtt-mcp',
      'writes.jsonl',
    );
  }
  return join(
    env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
    'foundryvtt-mcp',
    'writes.jsonl',
  );
}

/** Random 16-char Foundry-style document id (for dry-run placeholders). */
export function fakeDocumentId(random: () => number = Math.random): string {
  let id = '';
  for (let i = 0; i < 16; i += 1) {
    id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
  }
  return id;
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Dot paths of every leaf (non-object value) of a nested object, skipping `_id`. */
export function leafPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (!prefix && key === '_id') {
      continue;
    }
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out.push(...leafPaths(value as Record<string, unknown>, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (typeof next === 'object' && next !== null) {
      cur = next as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      cur[part] = created;
      cur = created;
    }
  }
  cur[parts[parts.length - 1] as string] = value;
}

/**
 * Nested restore for an ActorDelta update (never dot-path keys: Foundry accepts
 * them on an ActorDelta but persists nothing). Per leaf the update touched: the
 * override the delta had before, or a nested ForcedDeletion when it had none,
 * which removes the override so the base actor's value shows again (verified
 * live on Foundry 14).
 */
function planDeltaRestore(
  update: Record<string, unknown>,
  before: Record<string, unknown>,
): Record<string, unknown> {
  const restore: Record<string, unknown> = { _id: update._id };
  for (const path of leafPaths(update)) {
    const value = getPath(before, path);
    setPath(restore, path, value === undefined ? { ...FORCED_DELETION } : structuredClone(value));
  }
  return restore;
}

/** Builds the operation(s) that reverse an entry, or an explanation why not. */
export function planUndo(
  entry: AuditEntry,
): { ok: true; op: UndoOperation } | { ok: false; reason: string } {
  if (entry.dryRun) {
    return { ok: false, reason: 'that was a dry run; nothing was written' };
  }
  if (entry.undone) {
    return { ok: false, reason: 'it was already undone' };
  }
  if (entry.undoOf) {
    return { ok: false, reason: 'it is itself an undo' };
  }
  const base = entry.parentUuid ? { parentUuid: entry.parentUuid } : {};

  if (entry.action === 'create') {
    if (entry.ids.length === 0) {
      return { ok: false, reason: 'no created ids were recorded' };
    }
    return {
      ok: true,
      op: { type: entry.type, action: 'delete', ...base, operation: { ids: entry.ids, ...base } },
    };
  }

  if (!entry.before || entry.before.length === 0) {
    return {
      ok: false,
      reason: 'the previous state of the document was not cached, so it cannot be restored',
    };
  }

  if (entry.action === 'delete') {
    return {
      ok: true,
      op: {
        type: entry.type,
        action: 'create',
        ...base,
        operation: { data: entry.before, keepId: true, ...base },
      },
    };
  }

  const restores: Array<Record<string, unknown>> = [];
  for (const update of entry.updates ?? []) {
    const before = entry.before.find((b) => b._id === update._id);
    if (!before) {
      return { ok: false, reason: `previous state of ${String(update._id)} was not cached` };
    }
    if (entry.type === 'ActorDelta') {
      restores.push(planDeltaRestore(update, before));
      continue;
    }
    const restore: Record<string, unknown> = { _id: update._id };
    for (const key of Object.keys(update)) {
      if (key === '_id') {
        continue;
      }
      const prev = key.includes('.') ? getPath(before, key) : before[key];
      if (prev === undefined) {
        if (key.startsWith('ownership.')) {
          // Foundry validates every ownership value as a permission level, so the
          // deletion operator is rejected there. An entry equal to the default
          // level grants the same access as having no entry.
          const fallback = getPath(before, 'ownership.default');
          restore[key] = typeof fallback === 'number' ? fallback : 0;
        } else {
          // The update added this key; removing it restores the earlier state.
          restore[key] = { ...FORCED_DELETION };
        }
      } else {
        restore[key] = structuredClone(prev);
      }
    }
    restores.push(restore);
  }
  if (restores.length === 0) {
    return { ok: false, reason: 'no updates were recorded' };
  }
  return {
    ok: true,
    op: { type: entry.type, action: 'update', ...base, operation: { updates: restores, ...base } },
  };
}

export class WriteAudit {
  private entries: AuditEntry[] = [];
  private seq = 0;
  private readonly stamp = Date.now().toString(36);

  /** @param filePath JSONL path, or null for in-memory only. */
  constructor(private readonly filePath: string | null) {
    this.load();
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) {
      return;
    }
    try {
      const lines = readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean).slice(-200);
      for (const line of lines) {
        const parsed = JSON.parse(line) as AuditEntry & { markUndone?: string };
        if (parsed.markUndone) {
          const target = this.entries.find((e) => e.id === parsed.markUndone);
          if (target) {
            target.undone = true;
          }
        } else {
          this.entries.push(parsed);
        }
      }
    } catch (error) {
      logger.warn('Could not read write audit log; starting empty', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private append(obj: unknown): void {
    if (!this.filePath) {
      return;
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      appendFileSync(this.filePath, `${JSON.stringify(obj)}\n`, { mode: 0o600 });
    } catch (error) {
      logger.warn('Could not append to write audit log', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  record(input: Omit<AuditEntry, 'id' | 'at'>): AuditEntry {
    this.seq += 1;
    const entry: AuditEntry = {
      id: `w-${this.stamp}-${this.seq}`,
      at: new Date().toISOString(),
      ...input,
    };
    if (entry.before && JSON.stringify(entry.before).length > MAX_BEFORE_BYTES) {
      delete entry.before;
    }
    this.entries.push(entry);
    if (this.entries.length > 500) {
      this.entries.shift();
    }
    this.append(entry);
    return entry;
  }

  markUndone(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (entry) {
      entry.undone = true;
      this.append({ markUndone: id });
    }
  }

  get(id: string): AuditEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** Entries sharing a batch id, newest first. */
  batch(batchId: string): AuditEntry[] {
    return [...this.entries].reverse().filter((e) => e.batchId === batchId);
  }

  /** Newest first. */
  list(limit = 20): AuditEntry[] {
    return [...this.entries].reverse().slice(0, limit);
  }

  /** Newest real write that has not been undone and is not itself an undo. */
  lastUndoable(): AuditEntry | undefined {
    return [...this.entries].reverse().find((e) => !e.dryRun && !e.undone && !e.undoOf);
  }
}

/** Display names for an entry from its documents/updates. */
export function namesOf(docs: Array<Record<string, unknown>> | undefined): string[] {
  // Unnamed documents (a Combat's name is "") are left out, so the log shows an id count.
  return (docs ?? [])
    .map((d) => d.name)
    .filter((n): n is string => typeof n === 'string' && n !== '');
}
