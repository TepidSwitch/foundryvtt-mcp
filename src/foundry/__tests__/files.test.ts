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
const {
  assertWritableDataPath,
  contentTypeFor,
  folderChain,
  normalizeDataPath,
  sanitizeFilename,
  slugify,
} = await import('../files.js');

describe('file path helpers', () => {
  it('normalizes data paths and rejects traversal', () => {
    expect(normalizeDataPath('/worlds/x/')).toBe('worlds/x');
    expect(normalizeDataPath('worlds\\my-world\\maps')).toBe('worlds/my-world/maps');
    expect(normalizeDataPath('', { allowRoot: true })).toBe('');
    expect(() => normalizeDataPath('')).toThrow(/required/);
    expect(() => normalizeDataPath('worlds/../secrets')).toThrow(/"\.\."/);
    expect(() => normalizeDataPath('C:/Windows')).toThrow(/inside the Foundry data folder/);
  });

  it('refuses package folders for writes', () => {
    expect(() => assertWritableDataPath('modules/x')).toThrow(/installed packages/);
    expect(() => assertWritableDataPath('systems/dnd5e')).toThrow(/installed packages/);
    expect(() => assertWritableDataPath('worlds/w/maps')).not.toThrow();
    expect(() => assertWritableDataPath('assets')).not.toThrow();
  });

  it('builds the folder chain, sanitizes names and knows the media types', () => {
    expect(folderChain('a/b/c')).toEqual(['a', 'a/b', 'a/b/c']);
    expect(sanitizeFilename('../../My Map (final).PNG')).toBe('My-Map-final.png');
    expect(sanitizeFilename('....')).toBe('file');
    expect(slugify('The Crystal Caverns!')).toBe('the-crystal-caverns');
    expect(contentTypeFor('a.WEBP')).toBe('image/webp');
    expect(contentTypeFor('run.exe')).toBeUndefined();
  });
});

function setup(opts: { dryRun?: boolean } = {}) {
  vi.mocked(axios.create).mockReturnValue({
    get: vi.fn(),
    post: vi.fn(),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  } as never);
  const client = new FoundryClient({
    baseUrl: 'https://foundry.example.com',
    writeEnabled: true,
    timeout: 100,
    ...opts,
  });
  const emitted: Array<{ data: Record<string, unknown>; options: unknown }> = [];
  const existing = new Set<string>(['worlds']);
  const socket = {
    connected: true,
    emit: vi.fn((_event: string, data: Record<string, unknown>, options: unknown, ack) => {
      emitted.push({ data, options });
      if (data.action === 'createDirectory') {
        const target = String(data.target);
        if (existing.has(target)) {
          ack({ error: `The directory ${target} already exists` });
          return;
        }
        existing.add(target);
        ack({ result: true });
        return;
      }
      ack({ target: data.target, dirs: ['worlds/w'], files: ['a.png'] });
    }),
    off: vi.fn(),
    disconnect: vi.fn(),
  };
  const internals = client as unknown as {
    socket: unknown;
    sessionCookie: string;
    worldData: unknown;
  };
  internals.socket = socket;
  internals.sessionCookie = 'abc123';
  internals.worldData = {
    world: { id: 'my-world' },
    actors: [],
    scenes: [],
    items: [],
    journal: [],
  };
  return { client, emitted };
}

describe('FoundryClient file operations', () => {
  it('browses with the manageFiles three-argument form', async () => {
    const { client, emitted } = setup();
    const listing = await client.browseFiles('worlds', { extensions: ['.png'] });
    expect(listing).toEqual({ target: 'worlds', dirs: ['worlds/w'], files: ['a.png'] });
    expect(emitted[0]).toEqual({
      data: { action: 'browseFiles', storage: 'data', target: 'worlds' },
      options: { extensions: ['.png'] },
    });
    expect(client.getWorldId()).toBe('my-world');
  });

  it('creates missing folders level by level and tolerates existing ones', async () => {
    const { client, emitted } = setup();
    const created = await client.ensureDirectory('worlds/my-world/mcp-uploads');
    expect(created).toEqual(['worlds/my-world', 'worlds/my-world/mcp-uploads']);
    expect(emitted.map((e) => e.data.target)).toEqual([
      'worlds',
      'worlds/my-world',
      'worlds/my-world/mcp-uploads',
    ]);
    expect(await client.ensureDirectory('worlds/my-world')).toEqual([]);
  });

  it('uploads multipart with the session cookie and returns the stored path', async () => {
    const { client } = setup();
    vi.mocked(axios.post).mockResolvedValue({
      status: 200,
      data: { path: 'worlds/my-world/mcp-uploads/map.png' },
    });
    const path = await client.uploadFile(
      Buffer.from('png'),
      'My Map.png',
      'worlds/my-world/mcp-uploads',
    );
    expect(path).toBe('worlds/my-world/mcp-uploads/map.png');
    const [url, form, config] = vi.mocked(axios.post).mock.calls[0] as unknown as [
      string,
      { getBuffer: () => Buffer },
      { headers: Record<string, string> },
    ];
    expect(url).toBe('https://foundry.example.com/upload');
    expect(config.headers.Cookie).toBe('session=abc123');
    expect(config.headers.Origin).toBe('https://foundry.example.com');
    const body = form.getBuffer().toString();
    expect(body).toContain('name="source"');
    expect(body).toContain('worlds/my-world/mcp-uploads');
    expect(body).toContain('filename="My-Map.png"');
  });

  it('turns server errors into plain messages and refuses bad uploads before sending', async () => {
    const { client } = setup();
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { error: 'No space left' } });
    await expect(client.uploadFile(Buffer.from('x'), 'a.png', 'assets')).rejects.toThrow(
      /No space left/,
    );
    vi.mocked(axios.post).mockClear();
    await expect(client.uploadFile(Buffer.from('x'), 'run.exe', 'assets')).rejects.toThrow(
      /only images/,
    );
    await expect(client.uploadFile(Buffer.alloc(0), 'a.png', 'assets')).rejects.toThrow(/empty/);
    await expect(client.uploadFile(Buffer.from('x'), 'a.png', 'modules/x')).rejects.toThrow(
      /installed packages/,
    );
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('sends nothing in dry-run mode', async () => {
    const { client, emitted } = setup({ dryRun: true });
    vi.mocked(axios.post).mockClear();
    expect(await client.uploadFile(Buffer.from('x'), 'a.png', 'assets/maps')).toBe(
      'assets/maps/a.png',
    );
    expect(await client.ensureDirectory('assets/maps')).toEqual(['assets/maps']);
    expect(axios.post).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
    expect(client.getDryRunWriteCount()).toBe(2);
  });
});
