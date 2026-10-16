import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';

vi.mock('axios');
vi.mock('socket.io-client');
vi.mock('../auth.js', () => ({
  authenticateFoundry: vi.fn(),
  sessionSocketOptions: () => ({}),
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../config/index.js', () => ({ config: { logLevel: 'info' } }));

const { FoundryClient } = await import('../client.js');
const { WriteAudit, planUndo, fakeDocumentId } = await import('../write-audit.js');

const ACTOR = 'AAAAAAAAAAAAAAAA';

function setup(opts: { dryRun?: boolean } = {}) {
  vi.mocked(axios.create).mockReturnValue({
    get: vi.fn(),
    post: vi.fn(),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  } as never);
  const client = new FoundryClient({
    baseUrl: 'http://localhost:30000',
    writeEnabled: true,
    timeout: 100,
    ...opts,
  });
  const emitted: unknown[] = [];
  const socket = {
    connected: true,
    emit: vi.fn(
      (_event: string, payload: { action: string; operation: Record<string, unknown> }, ack) => {
        emitted.push(payload);
        const op = payload.operation;
        const result =
          payload.action === 'create'
            ? (op.data as Array<Record<string, unknown>>).map((d, i) => ({
                _id: `NEW${i}`.padEnd(16, 'x'),
                ...d,
              }))
            : payload.action === 'update'
              ? op.updates
              : op.ids;
        ack({ result });
      },
    ),
    off: vi.fn(),
    disconnect: vi.fn(),
  };
  const internals = client as unknown as { socket: unknown; worldData: unknown };
  internals.socket = socket;
  internals.worldData = {
    actors: [{ _id: ACTOR, name: 'Ossul', system: { currency: { gp: 10 } }, flags: {} }],
    scenes: [],
    items: [],
    journal: [],
  };
  return { client, emitted };
}

describe('write audit + undo', () => {
  it('logs an update with the previous state and undoes it', async () => {
    const { client, emitted } = setup();
    await client.updateActorAttribute(ACTOR, { 'currency.gp': 3 });
    const entry = client.audit.list(1)[0];
    expect(entry?.action).toBe('update');
    expect(entry?.names).toEqual(['Ossul']);
    expect(entry?.before?.[0]?._id).toBe(ACTOR);

    const { undone } = await client.undoWrite();
    expect(undone.id).toBe(entry?.id);
    const sent = emitted.at(-1) as {
      action: string;
      operation: { updates: Array<Record<string, unknown>> };
    };
    expect(sent.action).toBe('update');
    expect(sent.operation.updates[0]).toMatchObject({
      _id: ACTOR,
      'system.currency.gp': 10,
    });
    expect(client.audit.get(entry?.id ?? '')?.undone).toBe(true);
    // The undo itself is not undoable again.
    await expect(client.undoWrite()).rejects.toThrow(/no write to undo/i);
  });

  it('undoes a create by deleting the created ids', async () => {
    const { client, emitted } = setup();
    const journal = await client.createJournalEntry('Recap', [{ name: 'p', content: 'x' }]);
    await client.undoWrite();
    const sent = emitted.at(-1) as { action: string; type: string; operation: { ids: string[] } };
    expect(sent).toMatchObject({ action: 'delete', type: 'JournalEntry' });
    expect(sent.operation.ids).toEqual([journal._id]);
  });

  it('undoes every write of a batch together, newest first', async () => {
    const { client, emitted } = setup();
    await client.withBatch(async () => {
      await client.createJournalEntry('One', [{ name: 'p', content: 'x' }]);
      await client.createJournalEntry('Two', [{ name: 'p', content: 'y' }]);
    });
    await client.createJournalEntry('Outside', [{ name: 'p', content: 'z' }]);
    const [outside, two, one] = client.audit.list(3);
    expect(one?.batchId).toBeDefined();
    expect(two?.batchId).toBe(one?.batchId);
    expect(outside?.batchId).toBeUndefined();

    // Undoing by the older batch member reverts both batch writes, not the later one.
    const sentBefore = emitted.length;
    const { message } = await client.undoWrite(one?.id);
    expect(message).toContain('batch of 2 writes');
    const deletes = (
      emitted.slice(sentBefore) as Array<{ action: string; operation: { ids: string[] } }>
    ).map((p) => [p.action, p.operation.ids]);
    expect(deletes).toEqual([
      ['delete', two?.ids],
      ['delete', one?.ids],
    ]);
    expect(client.audit.get(one?.id ?? '')?.undone).toBe(true);
    expect(client.audit.get(two?.id ?? '')?.undone).toBe(true);
    expect(client.audit.get(outside?.id ?? '')?.undone).toBeUndefined();
  });

  it('sends nothing when part of a batch cannot be undone', async () => {
    const { client, emitted } = setup();
    await client.withBatch(async () => {
      await client.createJournalEntry('One', [{ name: 'p', content: 'x' }]);
      await client.updateActorAttribute(ACTOR, { 'currency.gp': 3 });
    });
    const update = client.audit.list(1)[0];
    if (update) {
      delete update.before;
    }
    const sentBefore = emitted.length;
    await expect(client.undoWrite()).rejects.toThrow(/Cannot undo/);
    expect(emitted).toHaveLength(sentBefore);
  });

  it('dry run sends nothing, logs the intent and counts it', async () => {
    const { client, emitted } = setup({ dryRun: true });
    const journal = await client.createJournalEntry('Recap', [{ name: 'p', content: 'x' }]);
    expect(emitted).toHaveLength(0);
    expect(journal._id).toHaveLength(16);
    expect(client.getDryRunWriteCount()).toBe(1);
    expect(client.audit.list(1)[0]?.dryRun).toBe(true);
    await expect(client.undoWrite()).rejects.toThrow(/no write to undo/i);
  });
});

describe('planUndo', () => {
  it('re-creates a deleted document with its id and removes newly added keys', () => {
    const del = planUndo({
      id: 'w1',
      at: '',
      type: 'Item',
      action: 'delete',
      ids: ['I'],
      names: [],
      before: [{ _id: 'I', name: 'Sword' }],
      parentUuid: `Actor.${ACTOR}`,
    });
    expect(del.ok && del.op.operation).toMatchObject({ keepId: true, data: [{ _id: 'I' }] });

    const upd = planUndo({
      id: 'w2',
      at: '',
      type: 'Actor',
      action: 'update',
      ids: [ACTOR],
      names: [],
      updates: [{ _id: ACTOR, 'flags.x.new': 1 }],
      before: [{ _id: ACTOR, flags: {} }],
    });
    expect(upd.ok && upd.op.operation).toMatchObject({
      updates: [{ _id: ACTOR, 'flags.x.new': { __$OPERATOR$__: 'ForcedDeletion' } }],
    });
  });
  it('restores an ownership entry the update added to the default level, not a deletion', () => {
    const upd = planUndo({
      id: 'w4',
      at: '',
      type: 'Actor',
      action: 'update',
      ids: [ACTOR],
      names: [],
      updates: [{ _id: ACTOR, 'ownership.USERAAAAAAAAAAAA': 3 }],
      before: [{ _id: ACTOR, ownership: { default: 1 } }],
    });
    expect(upd.ok && upd.op.operation).toMatchObject({
      updates: [{ _id: ACTOR, 'ownership.USERAAAAAAAAAAAA': 1 }],
    });
  });
  it('refuses when state was not captured', () => {
    const r = planUndo({
      id: 'w3',
      at: '',
      type: 'Actor',
      action: 'update',
      ids: ['X'],
      names: [],
      updates: [{ _id: 'X', name: 'a' }],
    });
    expect(r.ok).toBe(false);
  });
});

describe('WriteAudit persistence', () => {
  it('reloads entries and undone flags from the file', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'audit-')), 'sub', 'w.jsonl');
    const a = new WriteAudit(file);
    const e1 = a.record({ type: 'Actor', action: 'create', ids: ['1'], names: ['A'] });
    a.record({ type: 'Actor', action: 'create', ids: ['2'], names: ['B'] });
    a.markUndone(e1.id);
    const b = new WriteAudit(file);
    expect(b.list().length).toBe(2);
    expect(b.get(e1.id)?.undone).toBe(true);
    expect(b.lastUndoable()?.ids).toEqual(['2']);
    expect(fakeDocumentId()).toMatch(/^[A-Za-z0-9]{16}$/);
  });
});
