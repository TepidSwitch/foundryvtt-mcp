/**
 * @fileoverview The `foundry` object scripts see: a small async facade over the
 * client, with per-run budgets. Everything crosses the sandbox boundary as JSON.
 */

import type { FoundryClient } from '../foundry/client.js';
import type { WorldData } from '../foundry/types.js';

export interface ScriptBudget {
  maxCalls: number;
  maxDeletes: number;
}

export const DEFAULT_BUDGET: ScriptBudget = { maxCalls: 150, maxDeletes: 30 };

type Rec = Record<string, unknown>;

/** Readable top-level collections, keyed by document name. */
const READABLE: Record<string, keyof WorldData> = {
  Actor: 'actors',
  Item: 'items',
  Scene: 'scenes',
  JournalEntry: 'journal',
  Macro: 'macros',
  Playlist: 'playlists',
  RollTable: 'tables',
  Cards: 'cards',
  Folder: 'folders',
  Combat: 'combats',
};

/** Document types scripts may never write. */
const FORBIDDEN_WRITE = new Set(['User', 'Setting', 'World', 'Folder.__none__']);

export class BudgetError extends Error {}

export class ScriptApi {
  calls = 0;
  deletes = 0;
  writes = 0;

  constructor(
    private readonly client: FoundryClient,
    private readonly budget: ScriptBudget = DEFAULT_BUDGET,
  ) {}

  private spend(deletes = 0): void {
    this.calls += 1;
    this.deletes += deletes;
    if (this.calls > this.budget.maxCalls) {
      throw new BudgetError(`API call budget exceeded (${this.budget.maxCalls} calls per script)`);
    }
    if (this.deletes > this.budget.maxDeletes) {
      throw new BudgetError(
        `Delete budget exceeded (${this.budget.maxDeletes} deletes per script)`,
      );
    }
  }

  private assertWritable(type: unknown): string {
    if (typeof type !== 'string' || !type) {
      throw new Error('type must be a document name such as "Actor"');
    }
    if (FORBIDDEN_WRITE.has(type)) {
      throw new Error(`Scripts may not write ${type} documents`);
    }
    return type;
  }

  private parentOf(opts: unknown): string | undefined {
    const parent = (opts as Rec | undefined)?.parent;
    return typeof parent === 'string' && parent ? parent : undefined;
  }

  /** Dispatch one call from the sandbox. `args` is already JSON-decoded. */
  async call(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'list': {
        this.spend();
        const [type, opts] = args as [string, Rec | undefined];
        const key = READABLE[type];
        const world = this.client.getWorldData();
        if (!key || !world) {
          throw new Error(
            `Cannot list "${type}". Readable types: ${Object.keys(READABLE).join(', ')}`,
          );
        }
        const q = typeof opts?.query === 'string' ? opts.query.toLowerCase() : '';
        const limit = Math.min(Number(opts?.limit ?? 50) || 50, 200);
        return (world[key] as Rec[])
          .filter(
            (d) =>
              !q ||
              String(d.name ?? '')
                .toLowerCase()
                .includes(q),
          )
          .slice(0, limit)
          .map((d) => ({ _id: d._id, name: d.name, type: d.type, folder: d.folder ?? null }));
      }
      case 'get': {
        this.spend();
        const [type, id] = args as [string, string];
        const key = READABLE[type];
        const world = this.client.getWorldData();
        const doc = key && world ? (world[key] as Rec[]).find((d) => d._id === id) : undefined;
        if (!doc) {
          throw new Error(`${type} "${id}" not found`);
        }
        return doc;
      }
      case 'create': {
        this.spend();
        const [type, data, opts] = args as [string, Rec[], unknown];
        this.writes += 1;
        return this.client.createDocuments(this.assertWritable(type), data, this.parentOf(opts));
      }
      case 'update': {
        this.spend();
        const [type, updates, opts] = args as [string, Rec[], unknown];
        this.writes += 1;
        return this.client.updateDocuments(this.assertWritable(type), updates, this.parentOf(opts));
      }
      case 'delete': {
        const [type, ids, opts] = args as [string, string[], unknown];
        this.spend(Array.isArray(ids) ? ids.length : 0);
        this.writes += 1;
        return this.client.deleteDocuments(this.assertWritable(type), ids, this.parentOf(opts));
      }
      case 'chat': {
        this.spend();
        const [content, opts] = args as [string, Rec | undefined];
        this.writes += 1;
        const author = this.client.getUserId();
        const [msg] = await this.client.createDocuments('ChatMessage', [
          {
            content: String(content),
            ...(author ? { author } : {}),
            ...(Array.isArray(opts?.whisper) ? { whisper: opts.whisper } : {}),
          },
        ]);
        return { _id: msg?._id };
      }
      default:
        throw new Error(`Unknown API method: ${method}`);
    }
  }
}

/** TypeScript declarations for the script API (published as an MCP resource). */
export const SCRIPT_API_DTS = `/** The \`foundry\` global available inside foundry_script code. */
type Doc = Record<string, any> & { _id: string; name?: string };
type Summary = { _id: string; name: string; type?: string; folder: string | null };

declare const foundry: {
  /** List world documents (Actor, Item, Scene, JournalEntry, Macro, Playlist, RollTable, Cards, Folder, Combat). limit default 50, max 200. */
  list(type: string, opts?: { query?: string; limit?: number }): Promise<Summary[]>;
  /** Full document as cached from the world. */
  get(type: string, id: string): Promise<Doc>;
  /** Create documents. Embedded types need opts.parent, e.g. "Scene.<id>" or "Actor.<id>". */
  create(type: string, data: object[], opts?: { parent?: string }): Promise<Doc[]>;
  /** Update documents: each entry has _id plus changed fields (dot-notation keys allowed). */
  update(type: string, updates: Array<{ _id: string } & object>, opts?: { parent?: string }): Promise<Doc[]>;
  /** Delete documents by id. Counts against the delete budget. */
  delete(type: string, ids: string[], opts?: { parent?: string }): Promise<string[]>;
  /** Post a chat message (optionally whispered to user ids). */
  chat(content: string, opts?: { whisper?: string[] }): Promise<{ _id: string }>;
};
declare const console: { log(...args: unknown[]): void };
/** The script body is an async function: use await, and return a JSON-serializable value. */
`;
