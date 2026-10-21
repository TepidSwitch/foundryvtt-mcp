import { describe, expect, it } from 'vitest';
import { fakeFoundry } from '../../../test-utils/fake-foundry.js';
import { handleGetWriteLog, handleUndoLastWrite } from '../write-safety.js';

const ITEM = 'ITEMAAAAAAAAAAAA';
const ACTOR = 'ACTORAAAAAAAAAAA';

type Row = Record<string, unknown>;
const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? '';

function setup(config: Row = {}) {
  const f = fakeFoundry({
    world: {
      items: [{ _id: ITEM, name: 'Cloak', type: 'equipment', system: { rarity: 'common' } }],
      actors: [{ _id: ACTOR, name: 'Hero', type: 'character' }],
    },
    config,
  });
  const names = (key: string) => (f.world[key] ?? []).map((d) => d.name);
  const writes = () => f.sent.filter((s) => s.action !== 'get');
  return { ...f, names, writes };
}

describe('get write log', () => {
  it('says so when nothing was written', async () => {
    const { client } = setup();
    expect(text(await handleGetWriteLog({}, client))).toBe('🧾 No writes recorded yet.');
  });

  it('lists writes newest first with what they touched', async () => {
    const { client } = setup();
    await client.updateDocuments('Item', [{ _id: ITEM, name: 'Cloak+1' }]);
    await client.createDocuments('Item', [{ name: 'Rope', type: 'loot' }]);
    const out = text(await handleGetWriteLog({}, client));
    const lines = out.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/create Item · Rope$/);
    // the name shown for an update is the document's name before the write
    expect(lines[1]).toMatch(/update Item · Cloak$/);
    expect(out).toContain('Undo the newest with foundry_history_edit undo');
  });

  it('clamps the limit to 1..100 and shows an id count for unnamed documents', async () => {
    const { client } = setup();
    await client.createDocuments('Item', [{ type: 'loot' } as Row]);
    await client.createDocuments('Item', [{ name: 'Rope', type: 'loot' }]);
    const one = text(await handleGetWriteLog({ limit: 0 }, client));
    expect(one.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1);
    const all = text(await handleGetWriteLog({ limit: 1000 }, client));
    expect(all).toContain('1 id(s)');
  });

  it('shows the parent of embedded writes and flags undone entries and undos', async () => {
    const { client } = setup();
    await client.createDocuments('Item', [{ name: 'Dagger', type: 'weapon' }], `Actor.${ACTOR}`);
    await handleUndoLastWrite({}, client);
    const out = text(await handleGetWriteLog({}, client));
    expect(out).toContain(`create Item (in Actor.${ACTOR}) · Dagger · _undone_`);
    expect(out).toMatch(/delete Item \(in Actor\.ACTORAAAAAAAAAAA\) · Dagger · _undo of w-/);
  });

  it('marks dry-run entries', async () => {
    const { client, writes } = setup({ dryRun: true });
    await client.createDocuments('Item', [{ name: 'Rope', type: 'loot' }]);
    expect(writes()).toEqual([]);
    expect(text(await handleGetWriteLog({}, client))).toContain('Rope · _dry-run_');
  });
});

describe('undo', () => {
  it('undoes the newest write and reports what was reversed', async () => {
    const { client, names, world } = setup();
    await client.createDocuments('Item', [{ name: 'Rope', type: 'loot' }]);
    const out = text(await handleUndoLastWrite({}, client));
    expect(out).toContain('**Undid**');
    expect(out).toContain('(create Item: Rope)');
    expect(out).toContain('Performed: delete Item (1 document(s))');
    expect(out).toContain('Best effort');
    expect(names('items')).toEqual(['Cloak']);
    expect(world.items).toHaveLength(1);
  });

  it('restores the previous values of an update, by id, even when newer writes exist', async () => {
    const { client, world } = setup();
    await client.updateDocuments('Item', [{ _id: ITEM, name: 'Cloak+1' }]);
    const firstId = client.audit.list(1)[0]?.id as string;
    await client.updateDocuments('Actor', [{ _id: ACTOR, name: 'Villain' }]);
    const out = text(await handleUndoLastWrite({ write_id: firstId }, client));
    expect(out).toContain(`\`${firstId}\``);
    expect(world.items?.[0]?.name).toBe('Cloak');
    expect(world.actors?.[0]?.name).toBe('Villain');
  });

  it('skips undone writes and undos when picking the newest', async () => {
    const { client, names } = setup();
    await client.createDocuments('Item', [{ name: 'Rope', type: 'loot' }]);
    await client.createDocuments('Item', [{ name: 'Lamp', type: 'loot' }]);
    await handleUndoLastWrite({}, client);
    expect(names('items')).toEqual(['Cloak', 'Rope']);
    await handleUndoLastWrite({}, client);
    expect(names('items')).toEqual(['Cloak']);
    await expect(handleUndoLastWrite({}, client)).rejects.toThrow(/There is no write to undo/);
  });

  it('restores a deleted document under its original id', async () => {
    const { client, world } = setup();
    await client.deleteDocuments('Item', [ITEM]);
    expect(world.items).toEqual([]);
    await handleUndoLastWrite({}, client);
    expect(world.items?.[0]).toMatchObject({ _id: ITEM, name: 'Cloak' });
  });

  it('undoes a whole batch together and says so', async () => {
    const { client, names } = setup();
    await client.withBatch(async () => {
      await client.createDocuments('Item', [{ name: 'Rope', type: 'loot' }]);
      await client.updateDocuments('Actor', [{ _id: ACTOR, name: 'Villain' }]);
    });
    const out = text(await handleUndoLastWrite({}, client));
    expect(out).toContain('Performed: batch of 2 writes: ');
    expect(names('items')).toEqual(['Cloak']);
    expect(names('actors')).toEqual(['Hero']);
  });

  it('refuses with a reason and sends nothing', async () => {
    const { client, writes, names } = setup({ dryRun: true });
    await expect(handleUndoLastWrite({ write_id: 'w-nope' }, client)).rejects.toThrow(
      /No write with id w-nope/,
    );
    await client.createDocuments('Item', [{ name: 'Rope', type: 'loot' }]);
    const id = client.audit.list(1)[0]?.id as string;
    await expect(handleUndoLastWrite({ write_id: id }, client)).rejects.toThrow(
      /Cannot undo .*: that was a dry run; nothing was written/,
    );
    expect(writes()).toEqual([]);
    expect(names('items')).toEqual(['Cloak']);
  });

  it('refuses a second undo of the same write and an undo of an undo', async () => {
    const { client, names } = setup();
    await client.createDocuments('Item', [{ name: 'Rope', type: 'loot' }]);
    const createId = client.audit.list(1)[0]?.id as string;
    await handleUndoLastWrite({}, client);
    const undoId = client.audit.list(1)[0]?.id as string;
    await expect(handleUndoLastWrite({ write_id: createId }, client)).rejects.toThrow(
      /it was already undone/,
    );
    await expect(handleUndoLastWrite({ write_id: undoId }, client)).rejects.toThrow(
      /it is itself an undo/,
    );
    expect(names('items')).toEqual(['Cloak']);
  });

  it('refuses when the previous state was not cached', async () => {
    const { client } = setup();
    await client.updateDocuments('Item', [{ _id: ITEM, name: 'Cloak+1' }]);
    // an update of a document the client never cached (not in worldData)
    const e = client.audit.record({
      type: 'Item',
      action: 'update',
      ids: ['x'],
      names: [],
      updates: [{ _id: 'x', name: 'y' }],
    });
    await expect(handleUndoLastWrite({ write_id: e.id }, client)).rejects.toThrow(
      /previous state of the document was not cached/,
    );
  });

  it('is refused when writes are disabled', async () => {
    const { client } = setup({ writeEnabled: false });
    await expect(handleUndoLastWrite({}, client)).rejects.toThrow(/Write operations are disabled/);
  });
});
