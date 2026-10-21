/**
 * @fileoverview In-memory fake of Foundry's `modifyDocument` socket.
 *
 * Builds a REAL `FoundryClient` whose socket is wired to an in-memory "server"
 * world. Create/update/delete requests are applied to that store the way
 * Foundry's server does, so tests assert the resulting world state instead of
 * `toHaveBeenCalledWith(...)` on a mocked client method (which passed while the
 * real request shape was wrong).
 *
 * The server store (`world`) is a separate deep clone from the client's cache
 * (`client.getWorldSnapshot()`): the cache only changes through the client's own
 * write path, exactly as live.
 *
 * Server rules modelled, each from a live finding:
 *  - ActorDelta dot-path keys are accepted but not applied.
 *  - A pack index read returns only the requested fields.
 *  - Creating an active Combat deactivates the other and replies in the
 *    `results` shape.
 */

import { FoundryClient } from '../foundry/client.js';

type Doc = Record<string, unknown>;

export interface FakePack {
  id: string;
  type: string;
  label?: string;
  /** Full documents; index reads project these. */
  documents: Doc[];
}

export interface SentRequest {
  type: string;
  action: string;
  operation: Doc;
}

export interface FakeFoundryOptions {
  world?: Partial<Record<string, unknown>>;
  packs?: FakePack[];
  /** Client config overrides (e.g. `dryRun`). */
  config?: Record<string, unknown>;
}

export interface FakeFoundry {
  client: FoundryClient;
  /** Server-side truth, separate from the client's cache. */
  world: Record<string, Doc[]>;
  sent: SentRequest[];
}

const TOP_LEVEL: Record<string, string> = {
  Actor: 'actors',
  Item: 'items',
  Scene: 'scenes',
  JournalEntry: 'journal',
  Combat: 'combats',
  ChatMessage: 'messages',
  User: 'users',
  Folder: 'folders',
  Macro: 'macros',
  Playlist: 'playlists',
  RollTable: 'tables',
  Cards: 'cards',
};

/** Embedded document name → the array field on its parent. */
const EMBEDDED_FIELD: Record<string, string> = {
  Item: 'items',
  ActiveEffect: 'effects',
  Token: 'tokens',
  Wall: 'walls',
  Drawing: 'drawings',
  Note: 'notes',
  Tile: 'tiles',
  Region: 'regions',
  Combatant: 'combatants',
  PlaylistSound: 'sounds',
  JournalEntryPage: 'pages',
  TableResult: 'results',
  Card: 'cards',
};

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const FORCED_DELETION_KEY = '__$OPERATOR$__';
const isRecord = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);

function newId(): string {
  let id = '';
  for (let i = 0; i < 16; i += 1) {
    id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return id;
}

/** Drops ForcedDeletion leaves, as Foundry's update reply does. */
function withoutDeletions(doc: Doc): Doc {
  for (const [key, value] of Object.entries(doc)) {
    if (isRecord(value) && value[FORCED_DELETION_KEY] === 'ForcedDeletion') {
      delete doc[key];
    } else if (isRecord(value)) {
      withoutDeletions(value);
    }
  }
  return doc;
}

/** Foundry's update merge: nested objects merge, ForcedDeletion removes, `a.b` keys expand. */
function mergeUpdate(target: Doc, update: Doc): void {
  for (const [rawKey, value] of Object.entries(update)) {
    if (rawKey === '_id') {
      continue;
    }
    const parts = rawKey.split('.');
    let cur = target;
    for (const part of parts.slice(0, -1)) {
      if (!isRecord(cur[part])) {
        cur[part] = {};
      }
      cur = cur[part] as Doc;
    }
    const key = parts[parts.length - 1] as string;
    if (isRecord(value) && value[FORCED_DELETION_KEY] === 'ForcedDeletion') {
      delete cur[key];
    } else if (
      Array.isArray(value) &&
      Array.isArray(cur[key]) &&
      Object.values(EMBEDDED_FIELD).includes(key)
    ) {
      // A parent update may carry partial embedded docs; they merge by `_id`
      // (the embedded collection is updated in place, not replaced).
      for (const part of value as Doc[]) {
        const existing = (cur[key] as Doc[]).find((d) => d._id === part._id);
        if (existing) {
          mergeUpdate(existing, part);
        }
      }
    } else if (isRecord(value) && isRecord(cur[key])) {
      mergeUpdate(cur[key] as Doc, value);
    } else if (isRecord(value)) {
      const fresh: Doc = {};
      mergeUpdate(fresh, value);
      cur[key] = fresh;
    } else {
      cur[key] = structuredClone(value);
    }
  }
}

/** Walks `Scene.<sid>.Token.<tid>` / `Actor.<aid>.Item.<iid>` to the parent doc. */
function resolveParent(world: Record<string, Doc[]>, parentUuid: string): Doc | undefined {
  const seg = parentUuid.split('.');
  const topKey = TOP_LEVEL[seg[0] ?? ''];
  let cur = topKey ? world[topKey]?.find((d) => d._id === seg[1]) : undefined;
  for (let i = 2; cur && i + 1 < seg.length; i += 2) {
    const childType = seg[i] as string;
    if (childType === 'ActorDelta') {
      cur = isRecord(cur.delta) ? cur.delta : undefined;
      continue;
    }
    const field = EMBEDDED_FIELD[childType];
    const list = field ? cur[field] : undefined;
    cur = Array.isArray(list) ? (list as Doc[]).find((d) => d._id === seg[i + 1]) : undefined;
  }
  return cur;
}

function collectionFor(
  world: Record<string, Doc[]>,
  type: string,
  parentUuid: string | undefined,
  create: boolean,
): Doc[] | undefined {
  if (!parentUuid) {
    const key = TOP_LEVEL[type];
    return key ? world[key] : undefined;
  }
  const parent = resolveParent(world, parentUuid);
  const field = EMBEDDED_FIELD[type];
  if (!parent || !field) {
    return undefined;
  }
  if (!Array.isArray(parent[field]) && create) {
    parent[field] = [];
  }
  return Array.isArray(parent[field]) ? (parent[field] as Doc[]) : undefined;
}

const INDEX_BASE = ['_id', 'name', 'type', 'img'];

function project(doc: Doc, fields: string[]): Doc {
  const out: Doc = {};
  for (const field of fields) {
    let src: unknown = doc;
    for (const part of field.split('.')) {
      src = isRecord(src) ? src[part] : undefined;
    }
    if (src === undefined) {
      continue;
    }
    const parts = field.split('.');
    let dst = out;
    for (const part of parts.slice(0, -1)) {
      if (!isRecord(dst[part])) {
        dst[part] = {};
      }
      dst = dst[part] as Doc;
    }
    dst[parts[parts.length - 1] as string] = structuredClone(src);
  }
  return out;
}

class FakeServer {
  constructor(
    readonly world: Record<string, Doc[]>,
    private readonly packs: FakePack[],
  ) {}

  handle(request: SentRequest): Doc {
    const { type, action } = request;
    const op = request.operation;
    const parentUuid = typeof op.parentUuid === 'string' ? op.parentUuid : undefined;

    if (action === 'get') {
      return this.get(op);
    }
    if (action === 'create') {
      return this.create(type, op, parentUuid);
    }
    if (action === 'update') {
      return this.update(type, op, parentUuid);
    }
    if (action === 'delete') {
      const list = collectionFor(this.world, type, parentUuid, false);
      const ids = (op.ids as string[]) ?? [];
      if (list) {
        for (const id of ids) {
          const i = list.findIndex((d) => d._id === id);
          if (i !== -1) {
            list.splice(i, 1);
          }
        }
      }
      return { result: ids };
    }
    return { error: { message: `fake: unsupported action ${action}` } };
  }

  private get(op: Doc): Doc {
    const pack = this.packs.find((p) => p.id === op.pack);
    if (!pack) {
      return { error: { message: `fake: unknown pack ${String(op.pack)}` } };
    }
    if (op.index === true) {
      // Live finding (bug 2): over the socket `indexFields` is the WHOLE
      // projection. `_id`, `name`, `type`, `img` are not added server-side, so a
      // caller that does not request them gets none.
      const fields = Array.isArray(op.indexFields) ? (op.indexFields as string[]) : INDEX_BASE;
      return { result: pack.documents.map((d) => project(d, fields)) };
    }
    const query = isRecord(op.query) ? op.query : {};
    const hits = pack.documents.filter((d) => Object.entries(query).every(([k, v]) => d[k] === v));
    return { result: structuredClone(hits) };
  }

  private create(type: string, op: Doc, parentUuid: string | undefined): Doc {
    const list = collectionFor(this.world, type, parentUuid, true);
    if (!list) {
      return { error: { message: `fake: cannot create ${type} under ${String(parentUuid)}` } };
    }
    const created = ((op.data as Doc[]) ?? []).map((d) => {
      const doc = structuredClone(d);
      if (!(op.keepId === true && typeof doc._id === 'string')) {
        doc._id = newId();
      }
      return doc;
    });
    const sideEffects: Doc[] = [];
    if (type === 'Combat' && created.some((c) => c.active === true)) {
      // Live finding (bug 3): creating an active Combat while another is active
      // deactivates the other and the reply is `{results:[...]}` (side effect
      // first), not `{result:[...]}`.
      const deactivated = list
        .filter((c) => c.active === true)
        .map((c) => {
          c.active = false;
          return { _id: c._id, active: false };
        });
      if (deactivated.length > 0) {
        sideEffects.push({
          type: 'Combat',
          action: 'update',
          result: deactivated,
          sideEffect: true,
        });
      }
    }
    list.push(...created);
    if (sideEffects.length > 0) {
      return {
        results: [
          ...sideEffects,
          {
            type,
            action: 'create',
            result: structuredClone(created),
            ...(parentUuid ? { operation: { parentUuid } } : {}),
          },
        ],
      };
    }
    return { result: structuredClone(created) };
  }

  private update(type: string, op: Doc, parentUuid: string | undefined): Doc {
    const updates = (op.updates as Doc[]) ?? [];
    const isDelta = type === 'ActorDelta';
    for (const update of updates) {
      let target: Doc | undefined;
      if (isDelta) {
        // The delta is embedded in the token: parent `Scene.<sid>.Token.<tid>`,
        // `_id` is the token id.
        const token = parentUuid ? resolveParent(this.world, parentUuid) : undefined;
        if (token) {
          if (!isRecord(token.delta)) {
            token.delta = { _id: token._id };
          }
          target = token.delta as Doc;
        }
      } else {
        target = collectionFor(this.world, type, parentUuid, false)?.find(
          (d) => d._id === update._id,
        );
      }
      if (!target) {
        return { error: { message: `fake: ${type} ${String(update._id)} not found` } };
      }
      if (isDelta) {
        // Live finding (bug 1): an ActorDelta update with dot-path keys is
        // ACCEPTED but those keys are NOT saved. Nested objects are.
        const nested: Doc = {};
        for (const [k, v] of Object.entries(update)) {
          if (!k.includes('.')) {
            nested[k] = v;
          }
        }
        mergeUpdate(target, nested);
      } else {
        mergeUpdate(target, update);
      }
    }
    // The reply echoes the request, as Foundry does (accepted != applied), but
    // leaves out keys removed with ForcedDeletion (live finding).
    return { result: updates.map((u) => withoutDeletions(structuredClone(u))) };
  }
}

export function fakeFoundry(opts: FakeFoundryOptions = {}): FakeFoundry {
  const base: Record<string, Doc[]> = {};
  for (const key of Object.values(TOP_LEVEL)) {
    base[key] = [];
  }
  for (const [key, value] of Object.entries(opts.world ?? {})) {
    base[key] = structuredClone(value) as Doc[];
  }
  const packs = opts.packs ?? [];
  const server = new FakeServer(structuredClone(base), packs);
  const sent: SentRequest[] = [];

  const client = new FoundryClient({
    baseUrl: 'http://localhost:30000',
    writeEnabled: true,
    timeout: 200,
    ...(opts.config ?? {}),
  } as never);

  const socket = {
    connected: true,
    emit: (_event: string, payload: SentRequest, ack: (r: unknown) => void) => {
      sent.push(structuredClone(payload));
      ack(server.handle(structuredClone(payload)));
    },
    on: () => undefined,
    off: () => undefined,
    disconnect: () => undefined,
  };
  const internals = client as unknown as {
    socket: unknown;
    worldData: unknown;
    sessionUserId: string;
  };
  internals.sessionUserId = 'GMUSERAAAAAAAAAA';
  internals.socket = socket;
  internals.worldData = {
    userId: 'GMUSERAAAAAAAAAA',
    release: {},
    world: {},
    system: {},
    modules: [],
    demoMode: false,
    activeUsers: [],
    settings: [],
    ...structuredClone(base),
    packs: packs.map((p) => ({ id: p.id, type: p.type, label: p.label ?? p.id })),
  };
  return { client, world: server.world, sent };
}
