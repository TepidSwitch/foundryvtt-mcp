import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { fakeFoundry } from '../../../test-utils/fake-foundry.js';
import {
  handleCreateActorItem,
  handleDeleteActorItem,
  handleUpdateActorItem,
} from '../item-mutations.js';

const VALID_ACTOR_ID = 'abcdefABCDEF0123';
const VALID_ITEM_ID = '0123456789abcdef';
const PACK_ID = 'dnd5e.spells';
const ENTRY_ID = 'phbsplCounterspe';

type Row = Record<string, unknown>;

function setup(config: Row = {}) {
  return fakeFoundry({
    config,
    world: {
      actors: [
        {
          _id: VALID_ACTOR_ID,
          name: 'Hero',
          type: 'character',
          system: {},
          items: [
            {
              _id: VALID_ITEM_ID,
              name: 'Action Surge',
              type: 'feat',
              system: { equipped: false },
            },
          ],
        },
      ],
    },
    packs: [
      {
        id: PACK_ID,
        type: 'Item',
        documents: [{ _id: ENTRY_ID, name: 'Counterspell', type: 'spell', sort: 5 }],
      },
    ],
  });
}
type Fake = ReturnType<typeof setup>;
const items = (f: Fake) => (f.world.actors?.[0]?.items ?? []) as Row[];
const item = (f: Fake) => items(f).find((i) => i._id === VALID_ITEM_ID);
const writes = (f: Fake) => f.sent.filter((s) => s.action !== 'get');
const textOf = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? '';
const inline = (name: string) => ({
  actorId: VALID_ACTOR_ID,
  source: { type: 'inline' as const, item: { name, type: 'weapon' } },
});

describe('create_actor_item', () => {
  it('creates an inline item on the actor, in the server and the client cache', async () => {
    const f = setup();
    const text = textOf(await handleCreateActorItem(inline('Longsword'), f.client));
    expect(text).toContain('Item Created');
    expect(text).toContain('Longsword');
    expect(text).toContain('D&D 5e v4+ activity schema');
    const created = items(f).find((i) => i.name === 'Longsword');
    expect(created).toMatchObject({ type: 'weapon' });
    expect(String(created?._id)).toHaveLength(16);
    // Foundry never echoes our own write back, so the cache must apply it.
    expect(f.client.getRawActor(VALID_ACTOR_ID)?.items?.map((i) => i.name)).toContain('Longsword');
  });

  it('copies a compendium entry, dropping id/sort/folder and recording the source', async () => {
    const f = setup();
    const text = textOf(
      await handleCreateActorItem(
        {
          actorId: VALID_ACTOR_ID,
          source: { type: 'compendium', compendiumId: PACK_ID, itemId: ENTRY_ID },
        },
        f.client,
      ),
    );
    expect(text).toContain(`compendium ${PACK_ID}`);
    const copy = items(f).find((i) => i.name === 'Counterspell') as Row;
    expect(copy._id).not.toBe(ENTRY_ID);
    expect('sort' in copy).toBe(false);
    expect('folder' in copy).toBe(false);
    expect(copy._stats).toEqual({ compendiumSource: `Compendium.${PACK_ID}.Item.${ENTRY_ID}` });
  });

  it('rejects an unknown compendium pack without writing', async () => {
    const f = setup();
    await expect(
      f.client.createActorItem(VALID_ACTOR_ID, {
        type: 'compendium',
        compendiumId: 'no.such.pack',
        itemId: ENTRY_ID,
      }),
    ).rejects.toThrow(/Unknown compendium pack/);
    expect(writes(f)).toEqual([]);
  });

  it('rejects an empty actorId, a missing source and an unknown source type', async () => {
    const f = setup();
    await expect(handleCreateActorItem({ ...inline('x'), actorId: '' }, f.client)).rejects.toThrow(
      McpError,
    );
    await expect(
      handleCreateActorItem(
        { actorId: VALID_ACTOR_ID, source: undefined as unknown as never },
        f.client,
      ),
    ).rejects.toThrow(McpError);
    await expect(
      handleCreateActorItem(
        { actorId: VALID_ACTOR_ID, source: { type: 'bogus' } as unknown as never },
        f.client,
      ),
    ).rejects.toThrow(McpError);
    expect(writes(f)).toEqual([]);
  });

  it('fails for an actor that does not exist', async () => {
    const f = setup();
    await expect(
      handleCreateActorItem({ ...inline('x'), actorId: 'ffffffffffffffff' }, f.client),
    ).rejects.toThrow(McpError);
    expect(items(f)).toHaveLength(1);
  });

  it('surfaces the write-disabled guard error', async () => {
    const f = setup({ writeEnabled: false });
    await expect(handleCreateActorItem(inline('x'), f.client)).rejects.toThrow(
      'FOUNDRY_WRITE_ENABLED',
    );
    const compendium = {
      actorId: VALID_ACTOR_ID,
      source: { type: 'compendium' as const, compendiumId: PACK_ID, itemId: ENTRY_ID },
    };
    await expect(handleCreateActorItem(compendium, f.client)).rejects.toThrow(
      /Write operations are disabled/,
    );
    expect(items(f)).toHaveLength(1);
  });

  it('rejects writes when the socket is not connected', async () => {
    const f = setup();
    (f.client as unknown as { socket: unknown }).socket = null;
    await expect(f.client.deleteActorItem(VALID_ACTOR_ID, VALID_ITEM_ID)).rejects.toThrow(
      /Socket\.IO connection/,
    );
  });
});

describe('update_actor_item', () => {
  it('updates an item with a system patch', async () => {
    const f = setup();
    const text = textOf(
      await handleUpdateActorItem(
        { actorId: VALID_ACTOR_ID, itemId: VALID_ITEM_ID, patch: { equipped: true } },
        f.client,
      ),
    );
    expect(text).toContain('Item Updated');
    expect(text).toContain('equipped');
    expect(item(f)?.system).toEqual({ equipped: true });
  });

  it('adds an activity to an existing feat with a nested merge patch', async () => {
    const f = setup();
    const patch = {
      activities: {
        dnd5eactivity01: { consumption: { targets: [{ type: 'itemUses', value: '1' }] } },
      },
    };
    const text = textOf(
      await handleUpdateActorItem(
        { actorId: VALID_ACTOR_ID, itemId: VALID_ITEM_ID, patch },
        f.client,
      ),
    );
    // Live finding: a diff reply has no name or type, which printed "undefined (undefined)".
    expect(text).toContain('**Item:** Action Surge (feat)');
    expect(text).toContain('activities');
    expect(item(f)?.system).toMatchObject({ equipped: false, ...patch });
  });

  it('rejects an empty itemId, a non-object patch, a malformed id and an unknown item', async () => {
    const f = setup();
    const base = { actorId: VALID_ACTOR_ID, itemId: VALID_ITEM_ID, patch: { equipped: true } };
    await expect(handleUpdateActorItem({ ...base, itemId: '' }, f.client)).rejects.toThrow(
      McpError,
    );
    await expect(
      handleUpdateActorItem({ ...base, patch: null as unknown as Row }, f.client),
    ).rejects.toThrow(McpError);
    await expect(f.client.updateActorItem(VALID_ACTOR_ID, 'short', {})).rejects.toThrow(
      /Invalid itemId/,
    );
    await expect(
      handleUpdateActorItem({ ...base, itemId: 'ffffffffffffffff' }, f.client),
    ).rejects.toThrow(McpError);
    expect(item(f)?.system).toEqual({ equipped: false });
  });

  it('surfaces the write-disabled guard error', async () => {
    const f = setup({ writeEnabled: false });
    await expect(
      handleUpdateActorItem(
        { actorId: VALID_ACTOR_ID, itemId: VALID_ITEM_ID, patch: { equipped: true } },
        f.client,
      ),
    ).rejects.toThrow('FOUNDRY_WRITE_ENABLED');
  });
});

describe('delete_actor_item', () => {
  it('deletes an item', async () => {
    const f = setup();
    const text = textOf(
      await handleDeleteActorItem({ actorId: VALID_ACTOR_ID, itemId: VALID_ITEM_ID }, f.client),
    );
    expect(text).toContain('Item Deleted');
    expect(text).toContain(VALID_ITEM_ID);
    expect(items(f)).toEqual([]);
  });

  it('rejects empty ids and an unknown item', async () => {
    const f = setup();
    await expect(
      handleDeleteActorItem({ actorId: '', itemId: VALID_ITEM_ID }, f.client),
    ).rejects.toThrow(McpError);
    await expect(
      handleDeleteActorItem({ actorId: VALID_ACTOR_ID, itemId: '' }, f.client),
    ).rejects.toThrow(McpError);
    expect(items(f)).toHaveLength(1);
  });

  it('surfaces the write-disabled guard error', async () => {
    const f = setup({ writeEnabled: false });
    await expect(
      handleDeleteActorItem({ actorId: VALID_ACTOR_ID, itemId: VALID_ITEM_ID }, f.client),
    ).rejects.toThrow('FOUNDRY_WRITE_ENABLED');
    expect(items(f)).toHaveLength(1);
  });
});
