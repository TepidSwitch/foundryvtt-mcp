import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { FoundryClient } from '../../../foundry/client.js';
import type { FoundryItem } from '../../../foundry/types.js';
import {
  handleCreateActorItem,
  handleDeleteActorItem,
  handleUpdateActorItem,
} from '../item-mutations.js';

const VALID_ACTOR_ID = 'abcdefABCDEF0123';
const VALID_ITEM_ID = '0123456789abcdef';

const sampleItem: FoundryItem = {
  _id: VALID_ITEM_ID,
  name: 'Longsword',
  type: 'weapon',
};

const featWithActivity: FoundryItem = {
  _id: VALID_ITEM_ID,
  name: 'Action Surge',
  type: 'feat',
};

const createMockClient = (overrides: Partial<FoundryClient> = {}): FoundryClient => {
  return {
    createActorItem: vi.fn(async () => sampleItem),
    updateActorItem: vi.fn(async () => sampleItem),
    deleteActorItem: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as FoundryClient;
};

describe('item mutation handlers', () => {
  describe('handleCreateActorItem', () => {
    it('creates an item from an inline source', async () => {
      const mockClient = createMockClient();
      const result = await handleCreateActorItem(
        {
          actorId: VALID_ACTOR_ID,
          source: { type: 'inline', item: { type: 'weapon', name: 'Longsword' } },
        },
        mockClient,
      );

      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Item Created');
      expect(result.content[0].text).toContain('Longsword');
      expect(result.content[0].text).toContain('D&D 5e v4+ activity schema');
      expect(mockClient.createActorItem).toHaveBeenCalledWith(VALID_ACTOR_ID, {
        type: 'inline',
        item: { type: 'weapon', name: 'Longsword' },
      });
    });

    it('creates an item from a compendium source (passes ids through)', async () => {
      const mockClient = createMockClient();
      const result = await handleCreateActorItem(
        {
          actorId: VALID_ACTOR_ID,
          source: { type: 'compendium', compendiumId: 'dnd5e.items', itemId: VALID_ITEM_ID },
        },
        mockClient,
      );

      expect(result.content[0].text).toContain('compendium dnd5e.items');
      expect(mockClient.createActorItem).toHaveBeenCalledWith(VALID_ACTOR_ID, {
        type: 'compendium',
        compendiumId: 'dnd5e.items',
        itemId: VALID_ITEM_ID,
      });
    });

    it('rejects an empty actorId with InvalidParams', async () => {
      const mockClient = createMockClient();
      await expect(
        handleCreateActorItem(
          { actorId: '', source: { type: 'inline', item: { name: 'x', type: 'weapon' } } },
          mockClient,
        ),
      ).rejects.toThrow(McpError);
    });

    it('rejects a missing source with InvalidParams', async () => {
      const mockClient = createMockClient();
      await expect(
        handleCreateActorItem(
          {
            actorId: VALID_ACTOR_ID,
            source: undefined as unknown as { type: 'inline'; item: Partial<FoundryItem> },
          },
          mockClient,
        ),
      ).rejects.toThrow(McpError);
    });

    it('rejects an unknown source type with InvalidParams', async () => {
      const mockClient = createMockClient();
      await expect(
        handleCreateActorItem(
          {
            actorId: VALID_ACTOR_ID,
            source: { type: 'bogus' } as unknown as { type: 'inline'; item: Partial<FoundryItem> },
          },
          mockClient,
        ),
      ).rejects.toThrow(McpError);
    });

    it('propagates a not-found error from the client', async () => {
      const mockClient = createMockClient({
        createActorItem: vi.fn(async () => {
          throw new Error('Actor not found: abcdefABCDEF0123');
        }),
      });
      await expect(
        handleCreateActorItem(
          {
            actorId: VALID_ACTOR_ID,
            source: { type: 'inline', item: { name: 'x', type: 'weapon' } },
          },
          mockClient,
        ),
      ).rejects.toThrow(McpError);
    });

    it('surfaces the write-disabled guard error', async () => {
      const mockClient = createMockClient({
        createActorItem: vi.fn(async () => {
          throw new Error(
            'Write operations are disabled. Set FOUNDRY_WRITE_ENABLED=true to allow game-state mutation.',
          );
        }),
      });
      await expect(
        handleCreateActorItem(
          {
            actorId: VALID_ACTOR_ID,
            source: { type: 'inline', item: { name: 'x', type: 'weapon' } },
          },
          mockClient,
        ),
      ).rejects.toThrow('FOUNDRY_WRITE_ENABLED');
    });
  });

  describe('handleUpdateActorItem', () => {
    it('updates an item with a system patch', async () => {
      const mockClient = createMockClient();
      const result = await handleUpdateActorItem(
        { actorId: VALID_ACTOR_ID, itemId: VALID_ITEM_ID, patch: { equipped: true } },
        mockClient,
      );

      expect(result.content[0].text).toContain('Item Updated');
      expect(result.content[0].text).toContain('equipped');
      expect(mockClient.updateActorItem).toHaveBeenCalledWith(VALID_ACTOR_ID, VALID_ITEM_ID, {
        equipped: true,
      });
    });

    it('round-trips adding an activity to an existing feat (nested merge patch)', async () => {
      const mockClient = createMockClient({
        updateActorItem: vi.fn(async () => featWithActivity),
      });
      const patch = {
        activities: {
          dnd5eactivity01: {
            consumption: { targets: [{ type: 'itemUses', value: '1' }] },
          },
        },
      };
      const result = await handleUpdateActorItem(
        { actorId: VALID_ACTOR_ID, itemId: VALID_ITEM_ID, patch },
        mockClient,
      );

      expect(result.content[0].text).toContain('Action Surge');
      expect(result.content[0].text).toContain('activities');
      expect(mockClient.updateActorItem).toHaveBeenCalledWith(VALID_ACTOR_ID, VALID_ITEM_ID, patch);
    });

    it('rejects an empty itemId with InvalidParams', async () => {
      const mockClient = createMockClient();
      await expect(
        handleUpdateActorItem(
          { actorId: VALID_ACTOR_ID, itemId: '', patch: { equipped: true } },
          mockClient,
        ),
      ).rejects.toThrow(McpError);
    });

    it('rejects a non-object patch with InvalidParams', async () => {
      const mockClient = createMockClient();
      await expect(
        handleUpdateActorItem(
          {
            actorId: VALID_ACTOR_ID,
            itemId: VALID_ITEM_ID,
            patch: null as unknown as Record<string, unknown>,
          },
          mockClient,
        ),
      ).rejects.toThrow(McpError);
    });

    it('propagates a not-found error from the client', async () => {
      const mockClient = createMockClient({
        updateActorItem: vi.fn(async () => {
          throw new Error('Item not found: 0123456789abcdef');
        }),
      });
      await expect(
        handleUpdateActorItem(
          { actorId: VALID_ACTOR_ID, itemId: VALID_ITEM_ID, patch: { equipped: true } },
          mockClient,
        ),
      ).rejects.toThrow(McpError);
    });

    it('surfaces the write-disabled guard error', async () => {
      const mockClient = createMockClient({
        updateActorItem: vi.fn(async () => {
          throw new Error(
            'Write operations are disabled. Set FOUNDRY_WRITE_ENABLED=true to allow game-state mutation.',
          );
        }),
      });
      await expect(
        handleUpdateActorItem(
          { actorId: VALID_ACTOR_ID, itemId: VALID_ITEM_ID, patch: { equipped: true } },
          mockClient,
        ),
      ).rejects.toThrow('FOUNDRY_WRITE_ENABLED');
    });
  });

  describe('handleDeleteActorItem', () => {
    it('deletes an item', async () => {
      const mockClient = createMockClient();
      const result = await handleDeleteActorItem(
        { actorId: VALID_ACTOR_ID, itemId: VALID_ITEM_ID },
        mockClient,
      );

      expect(result.content[0].text).toContain('Item Deleted');
      expect(result.content[0].text).toContain(VALID_ITEM_ID);
      expect(mockClient.deleteActorItem).toHaveBeenCalledWith(VALID_ACTOR_ID, VALID_ITEM_ID);
    });

    it('rejects an empty actorId with InvalidParams', async () => {
      const mockClient = createMockClient();
      await expect(
        handleDeleteActorItem({ actorId: '', itemId: VALID_ITEM_ID }, mockClient),
      ).rejects.toThrow(McpError);
    });

    it('rejects an empty itemId with InvalidParams', async () => {
      const mockClient = createMockClient();
      await expect(
        handleDeleteActorItem({ actorId: VALID_ACTOR_ID, itemId: '' }, mockClient),
      ).rejects.toThrow(McpError);
    });

    it('propagates a not-found error from the client', async () => {
      const mockClient = createMockClient({
        deleteActorItem: vi.fn(async () => {
          throw new Error('Item not found: 0123456789abcdef');
        }),
      });
      await expect(
        handleDeleteActorItem({ actorId: VALID_ACTOR_ID, itemId: VALID_ITEM_ID }, mockClient),
      ).rejects.toThrow(McpError);
    });

    it('surfaces the write-disabled guard error', async () => {
      const mockClient = createMockClient({
        deleteActorItem: vi.fn(async () => {
          throw new Error(
            'Write operations are disabled. Set FOUNDRY_WRITE_ENABLED=true to allow game-state mutation.',
          );
        }),
      });
      await expect(
        handleDeleteActorItem({ actorId: VALID_ACTOR_ID, itemId: VALID_ITEM_ID }, mockClient),
      ).rejects.toThrow('FOUNDRY_WRITE_ENABLED');
    });
  });
});

// ----------------------------------------------------------------------------
// Client-level: exercises the real createActorItem/updateActorItem/
// deleteActorItem over a mocked Socket.IO socket (modifyDocument protocol).
// ----------------------------------------------------------------------------
describe('FoundryClient item mutations (modifyDocument)', () => {
  type SocketEmitMock = (event: string, payload: unknown, cb: (response: unknown) => void) => void;

  const buildClient = (opts: { writeEnabled?: boolean; connected?: boolean } = {}) => {
    const client = new FoundryClient({
      baseUrl: 'http://localhost:30000',
      writeEnabled: opts.writeEnabled ?? true,
    });
    // The ack echoes the first created/updated document (or empty for delete).
    const emit = vi.fn(((_event, payload, cb) => {
      const op = (
        payload as {
          operation?: { data?: unknown[]; updates?: unknown[] };
        }
      ).operation;
      const echoed = op?.data?.[0] ?? op?.updates?.[0];
      cb({ result: echoed ? [echoed] : [] });
    }) as SocketEmitMock);
    if (opts.connected !== false) {
      (client as unknown as { socket: { connected: boolean; emit: SocketEmitMock } }).socket = {
        connected: true,
        emit,
      };
    }
    return client;
  };

  const lastRequest = (client: FoundryClient) => {
    const emitMock = (client as unknown as { socket: { emit: ReturnType<typeof vi.fn> } }).socket
      .emit;
    return emitMock.mock.calls[0];
  };

  it('creates an inline item as an embedded Item modifyDocument request', async () => {
    const client = buildClient();
    await client.createActorItem(VALID_ACTOR_ID, {
      type: 'inline',
      item: { name: 'Divine Smite', type: 'feat' },
    });
    const [event, body] = lastRequest(client);
    expect(event).toBe('modifyDocument');
    expect(body).toMatchObject({
      type: 'Item',
      action: 'create',
      operation: {
        data: [{ name: 'Divine Smite', type: 'feat' }],
        parentUuid: `Actor.${VALID_ACTOR_ID}`,
        broadcast: true,
        pack: null,
      },
    });
  });

  it('applies its own write to the cached world (Foundry never echoes it back)', async () => {
    const client = buildClient();
    const cached = { _id: VALID_ACTOR_ID, name: 'Hero', type: 'character', system: {}, items: [] };
    (client as unknown as { worldData: unknown }).worldData = { actors: [cached], scenes: [] };

    await client.createActorItem(VALID_ACTOR_ID, {
      type: 'inline',
      item: { ...sampleItem, _id: VALID_ITEM_ID },
    });

    // the echoed ack carries the created item, which must now be in the cache
    expect(cached.items).toHaveLength(1);
    expect((cached.items[0] as { _id: string })._id).toBe(VALID_ITEM_ID);
  });

  describe('compendium-source create', () => {
    const PACK_ID = 'dnd5e.spells';
    const ENTRY_ID = 'phbsplCounterspe';

    /** A client whose socket answers compendium reads and creates like Foundry. */
    const buildCompendiumClient = () => {
      const client = new FoundryClient({ baseUrl: 'http://localhost:30000', writeEnabled: true });
      (client as unknown as { worldData: unknown }).worldData = {
        packs: [{ id: PACK_ID, type: 'Item', index: [] }],
        actors: [],
        scenes: [],
      };
      const emit = vi.fn(((_event, payload, cb) => {
        const req = payload as {
          action: string;
          operation: { data?: unknown[]; query?: { _id?: string } };
        };
        if (req.action === 'get') {
          cb({
            result: [
              { _id: req.operation.query?._id, name: 'Counterspell', type: 'spell', sort: 5 },
            ],
          });
        } else {
          cb({ result: [{ ...(req.operation.data?.[0] as object), _id: 'newitemnewitem01' }] });
        }
      }) as SocketEmitMock);
      (client as unknown as { socket: { connected: boolean; emit: SocketEmitMock } }).socket = {
        connected: true,
        emit,
      };
      return { client, emit };
    };

    it('reads the entry from the pack and creates a copy on the actor', async () => {
      const { client, emit } = buildCompendiumClient();
      const created = await client.createActorItem(VALID_ACTOR_ID, {
        type: 'compendium',
        compendiumId: PACK_ID,
        itemId: ENTRY_ID,
      });

      expect(emit).toHaveBeenCalledTimes(2);
      const [getReq, createReq] = emit.mock.calls.map((c) => c[1]) as Array<{
        type: string;
        action: string;
        operation: Record<string, unknown>;
      }>;
      expect(getReq).toMatchObject({
        type: 'Item',
        action: 'get',
        operation: { pack: PACK_ID, query: { _id: ENTRY_ID } },
      });
      expect(createReq).toMatchObject({
        type: 'Item',
        action: 'create',
        operation: { parentUuid: `Actor.${VALID_ACTOR_ID}` },
      });
      const data = (createReq.operation.data as Array<Record<string, unknown>>)[0] ?? {};
      expect(data.name).toBe('Counterspell');
      expect('_id' in data).toBe(false);
      expect('sort' in data).toBe(false);
      expect('folder' in data).toBe(false);
      expect(data._stats).toEqual({ compendiumSource: `Compendium.${PACK_ID}.Item.${ENTRY_ID}` });
      expect((created as unknown as { _id: string })._id).toBe('newitemnewitem01');
    });

    it('rejects an unknown compendium pack without writing', async () => {
      const { client, emit } = buildCompendiumClient();
      await expect(
        client.createActorItem(VALID_ACTOR_ID, {
          type: 'compendium',
          compendiumId: 'no.such.pack',
          itemId: ENTRY_ID,
        }),
      ).rejects.toThrow(/Unknown compendium pack/);
      expect(emit).not.toHaveBeenCalled();
    });

    it('is still refused when writes are disabled', async () => {
      const client = new FoundryClient({ baseUrl: 'http://localhost:30000', writeEnabled: false });
      await expect(
        client.createActorItem(VALID_ACTOR_ID, {
          type: 'compendium',
          compendiumId: PACK_ID,
          itemId: ENTRY_ID,
        }),
      ).rejects.toThrow(/Write operations are disabled/);
    });
  });

  it('updates an item with a nested system merge patch', async () => {
    const client = buildClient();
    const patch = { activities: { abc: { type: 'damage' } } };
    await client.updateActorItem(VALID_ACTOR_ID, VALID_ITEM_ID, patch);
    const [, body] = lastRequest(client);
    expect(body).toMatchObject({
      type: 'Item',
      action: 'update',
      operation: {
        updates: [{ _id: VALID_ITEM_ID, system: patch }],
        parentUuid: `Actor.${VALID_ACTOR_ID}`,
        recursive: true,
      },
    });
  });

  it('deletes an item by id with parentUuid', async () => {
    const client = buildClient();
    await client.deleteActorItem(VALID_ACTOR_ID, VALID_ITEM_ID);
    const [, body] = lastRequest(client);
    expect(body).toMatchObject({
      type: 'Item',
      action: 'delete',
      operation: { ids: [VALID_ITEM_ID], parentUuid: `Actor.${VALID_ACTOR_ID}` },
    });
  });

  it('rejects writes when FOUNDRY_WRITE_ENABLED is false', async () => {
    const client = buildClient({ writeEnabled: false });
    await expect(client.deleteActorItem(VALID_ACTOR_ID, VALID_ITEM_ID)).rejects.toThrow(
      /FOUNDRY_WRITE_ENABLED/,
    );
  });

  it('rejects writes when the socket is not connected', async () => {
    const client = buildClient({ connected: false });
    await expect(client.deleteActorItem(VALID_ACTOR_ID, VALID_ITEM_ID)).rejects.toThrow(
      /Socket\.IO connection/,
    );
  });

  it('rejects a malformed itemId before emitting', async () => {
    const client = buildClient();
    await expect(client.updateActorItem(VALID_ACTOR_ID, 'short', {})).rejects.toThrow(
      /Invalid itemId/,
    );
  });
});
