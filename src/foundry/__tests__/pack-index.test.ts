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

const ENTRY = {
  _id: 'ddbAarAer5194864',
  name: 'Aarakocra Aeromancer',
  type: 'npc',
  img: 'a.png',
  system: { details: { cr: 4, type: { value: 'elemental' } }, attributes: { hp: { max: 66 } } },
};

/** Projects a dotted field list the way Foundry's server does for an index read. */
function project(doc: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const parts = field.split('.');
    let src: unknown = doc;
    for (const part of parts) {
      src = (src as Record<string, unknown> | undefined)?.[part];
    }
    if (src === undefined) {
      continue;
    }
    let dst = out;
    for (const part of parts.slice(0, -1)) {
      dst[part] ??= {};
      dst = dst[part] as Record<string, unknown>;
    }
    dst[parts.at(-1) as string] = src;
  }
  return out;
}

function setup() {
  vi.mocked(axios.create).mockReturnValue({
    get: vi.fn(),
    post: vi.fn(),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  } as never);
  const client = new FoundryClient({ baseUrl: 'http://localhost:30000', timeout: 100 });
  const socket = {
    connected: true,
    emit: vi.fn((_event: string, payload: { operation: { indexFields: string[] } }, ack) => {
      // Live finding: the server returns only the requested indexFields, no base fields.
      ack({ result: [project(ENTRY, payload.operation.indexFields)] });
    }),
    off: vi.fn(),
    disconnect: vi.fn(),
  };
  const internals = client as unknown as { socket: unknown; worldData: unknown };
  internals.socket = socket;
  internals.worldData = { packs: [{ id: 'dnd5e.monsters', type: 'Actor' }] };
  return { client };
}

describe('getPackIndexFields', () => {
  it('keeps _id, name, type and img alongside the requested system fields', async () => {
    const { client } = setup();
    const [doc] = await client.getPackIndexFields('dnd5e.monsters', ['system.details.cr']);
    expect(doc).toEqual({
      _id: ENTRY._id,
      name: ENTRY.name,
      type: 'npc',
      img: 'a.png',
      system: { details: { cr: 4 } },
    });
  });
});
