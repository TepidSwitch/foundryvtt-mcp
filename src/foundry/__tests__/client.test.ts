import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies
vi.mock('axios');
vi.mock('socket.io-client');
vi.mock('../auth.js', () => ({
  authenticateFoundry: vi
    .fn()
    .mockResolvedValue({ session: 'test-session', userId: 'test-user-id' }),
  // Real implementation — connectAndLoadWorld's handshake options are the
  // subject of the #206 regression test below.
  sessionSocketOptions: (session: string) => ({
    transports: ['websocket'],
    query: { session },
    extraHeaders: { Cookie: `session=${session}` },
  }),
}));
vi.mock('../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('../../config/index.js', () => ({
  config: {
    logLevel: 'info',
  },
}));

const { FoundryClient } = await import('../client.js');

const mockAxios = vi.mocked(axios);

describe('FoundryClient', () => {
  let client: InstanceType<typeof FoundryClient>;
  let mockAxiosInstance: any;

  beforeEach(() => {
    mockAxiosInstance = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
      interceptors: {
        request: { use: vi.fn() },
        response: { use: vi.fn() },
      },
    };

    vi.clearAllMocks();
    mockAxios.create = vi.fn().mockReturnValue(mockAxiosInstance);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('constructor', () => {
    it('should create instance with default config', () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      expect(client).toBeDefined();
      expect(client.isConnected()).toBe(false);
    });

    it('should throw on empty baseUrl', () => {
      expect(() => new FoundryClient({ baseUrl: '' })).toThrow('baseUrl is required');
    });

    it('should throw on invalid baseUrl', () => {
      expect(() => new FoundryClient({ baseUrl: 'not-a-url' })).toThrow('Invalid baseUrl');
    });
  });

  describe('worldData mode', () => {
    it('should return empty results when no worldData', async () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });

      const actors = await client.searchActors({ query: 'test' });
      expect(actors.actors).toEqual([]);
      expect(actors.total).toBe(0);

      const items = await client.searchItems({ query: 'test' });
      expect(items.items).toEqual([]);
    });

    it('should return default world info when no worldData', async () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      const info = await client.getWorldInfo();
      expect(info.id).toBe('unknown');
      expect(info.title).toBe('Not connected');
    });

    it('should require credentials for connect in Socket.IO mode', async () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      await expect(client.connect()).rejects.toThrow('Socket.IO mode requires');
    });

    it('should return null combat state when no worldData', () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      expect(client.getCombatState()).toBeNull();
    });

    it('should return empty chat messages when no worldData', () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      expect(client.getChatMessages()).toEqual([]);
    });

    it('should return empty users when no worldData', () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      const { users, activeUsers } = client.getUsers();
      expect(users).toEqual([]);
      expect(activeUsers).toEqual([]);
    });

    it('should return empty journals when no worldData', () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      expect(client.getJournals()).toEqual([]);
    });

    it('should return empty world search when no worldData', () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      const results = client.searchWorld('test');
      expect(results.actors).toEqual([]);
      expect(results.items).toEqual([]);
    });

    it('should return empty summary when no worldData', () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      expect(client.getWorldSummary()).toEqual({});
    });
  });

  describe('dice rolling', () => {
    beforeEach(() => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
    });

    it('should validate dice formula', async () => {
      await expect(client.rollDice('')).rejects.toThrow('Invalid dice formula');
      await expect(client.rollDice('DROP TABLE')).rejects.toThrow('Invalid dice formula');
    });

    it('should perform fallback dice roll', async () => {
      const result = await client.rollDice('1d20+5', 'Attack roll');
      expect(result.formula).toBe('1d20+5');
      expect(result.total).toBeGreaterThanOrEqual(6);
      expect(result.total).toBeLessThanOrEqual(25);
      expect(result.reason).toBe('Attack roll');
      expect(result.timestamp).toBeDefined();
    });

    it('should perform fallback roll for multiple dice', async () => {
      const result = await client.rollDice('3d6');
      expect(result.formula).toBe('3d6');
      expect(result.total).toBeGreaterThanOrEqual(3);
      expect(result.total).toBeLessThanOrEqual(18);
    });

    /**
     * Issue #219 — the old parser only captured a modifier glued directly to a
     * dice term, so every formula below returned a plausible-but-wrong total
     * with the unparsed part silently dropped. RNG is pinned so the totals are
     * exact rather than ranges.
     */
    describe('formulas that used to be silently mis-totalled (#219)', () => {
      beforeEach(() => {
        // Math.floor(0.5 * sides) + 1 — the middle-ish face of every die.
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it.each([
        { formula: '1d20+5', total: 16, breakdown: '1d20: [11] + 5 = 16' },
        { formula: '1d20 + 5', total: 16, breakdown: '1d20: [11] + 5 = 16' },
        { formula: '1d20+5+3', total: 19, breakdown: '1d20: [11] + 5 + 3 = 19' },
        { formula: 'd20', total: 11, breakdown: '1d20: [11] = 11' },
        { formula: '2d6+1d4', total: 11, breakdown: '2d6: [4, 4] + 1d4: [3] = 11' },
        { formula: '2d6 - 1', total: 7, breakdown: '2d6: [4, 4] - 1 = 7' },
      ])('rolls $formula for exactly $total', async ({ formula, total, breakdown }) => {
        const result = await client.rollDice(formula);
        expect(result.total).toBe(total);
        expect(result.breakdown).toBe(breakdown);
        // The rendered breakdown must agree with the total it claims.
        expect(result.breakdown.endsWith(` = ${result.total}`)).toBe(true);
      });

      /**
       * The message has to name the problem, not just the formula: `roll_dice`
       * advertises `4d6kh3` and `1d20r1` by name as notation that "is rejected
       * with an error naming the problem". A generic `Invalid dice formula:
       * 4d6kh3` does not tell the caller which character was not understood.
       */
      it.each([
        { formula: '(1d20+5)', match: /parenthes/i },
        { formula: '(1d20+5)*2', match: /parenthes/i },
        { formula: '4d6kh3', match: /unexpected "k" at position 3/ },
        { formula: '1d20r1', match: /unexpected "r" at position 4/ },
        { formula: '1d20*2', match: /unexpected "\*" at position 4/ },
        { formula: '1d20+STR', match: /unexpected "S" at position 5/ },
        { formula: '1d20+', match: /ends with/i },
        { formula: '1d20 5', match: /unexpected/i },
        { formula: '1d0', match: /at least 1 side/i },
      ])('rejects $formula instead of dropping part of it', async ({ formula, match }) => {
        await expect(client.rollDice(formula)).rejects.toThrow(match);
      });
    });
  });

  describe('disconnect', () => {
    it('should reset state on disconnect', async () => {
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      await client.disconnect();
      expect(client.isConnected()).toBe(false);
      expect(client.hasWorldData()).toBe(false);
    });
  });

  describe('refreshWorldData', () => {
    const SNAPSHOT = {
      userId: 'test-user',
      actors: [{ _id: 'AAAAAAAAAAAAAAAA', name: 'Fresh' }],
      scenes: [],
      items: [],
      journal: [],
      messages: [],
      combats: [],
      users: [],
      activeUsers: [],
      macros: [],
      playlists: [],
      tables: [],
      folders: [],
    };

    it('reads the snapshot from the world acknowledgement, as Foundry answers it', async () => {
      // Live finding: Foundry replies to `world` only through the ack callback;
      // waiting for a separate `world` event always timed out.
      client = new FoundryClient({ baseUrl: 'http://localhost:30000' });
      const socket = {
        connected: true,
        emit: vi.fn((event: string, ack?: (data: unknown) => void) => {
          if (event === 'world') {
            ack?.(SNAPSHOT);
          }
        }),
      };
      (client as unknown as { socket: typeof socket }).socket = socket;

      await client.refreshWorldData();

      expect(client.getWorldData()?.actors.map((a) => a.name)).toEqual(['Fresh']);
    });

    it('rejects when no acknowledgement arrives', async () => {
      vi.useFakeTimers();
      try {
        client = new FoundryClient({ baseUrl: 'http://localhost:30000', timeout: 25 });
        const socket = { connected: true, emit: vi.fn() };
        (client as unknown as { socket: typeof socket }).socket = socket;
        const refresh = expect(client.refreshWorldData()).rejects.toThrow('Refresh timeout');
        await vi.advanceTimersByTimeAsync(30_000);
        await refresh;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * Issue #217 — liveness must come from the socket, not a latched flag.
   *
   * `_isConnected` used to be cleared only by an explicit `disconnect()`, so a
   * socket that dropped on its own (server restart, network loss) still read as
   * connected and `get_health_status` still printed "✅ Connected".
   */
  describe('socket liveness (#217) and live presence (#218)', () => {
    /** Mock socket that records listeners and lets the test fire them. */
    function buildHandshakeSocket(worldData: Record<string, unknown>) {
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
      const socket = {
        connected: true,
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          const existing = listeners.get(event) ?? [];
          existing.push(handler);
          listeners.set(event, existing);
          return socket;
        }),
        once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          const existing = listeners.get(event) ?? [];
          existing.push(handler);
          listeners.set(event, existing);
          return socket;
        }),
        off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          const remaining = (listeners.get(event) ?? []).filter((h) => h !== handler);
          listeners.set(event, remaining);
          return socket;
        }),
        emit: vi.fn((event: string, ack?: (payload: unknown) => void) => {
          if (event === 'world' && typeof ack === 'function') {
            ack(worldData);
          }
          return socket;
        }),
        disconnect: vi.fn(() => {
          socket.connected = false;
          return socket;
        }),
      };
      const fire = (event: string, ...args: unknown[]) => {
        for (const handler of [...(listeners.get(event) ?? [])]) {
          handler(...args);
        }
      };
      return { socket, listeners, fire };
    }

    const WORLD_DATA = {
      userId: 'test-user-id',
      world: { id: 'w', title: 'Test World' },
      system: { id: 'dnd5e', version: '3.3.1' },
      release: { version: '12.331' },
      actors: [],
      scenes: [],
      items: [],
      journal: [],
      messages: [],
      combats: [],
      users: [
        { _id: 'user-aaaaaaaaaaaaaa', name: 'GM', role: 4 },
        { _id: 'user-bbbbbbbbbbbbbb', name: 'Player', role: 1 },
      ],
      activeUsers: ['user-aaaaaaaaaaaaaa'],
      settings: [],
      macros: [],
      playlists: [],
      tables: [],
      folders: [],
    };

    async function connectWithMockSocket(existing?: FoundryClient) {
      const { io } = await import('socket.io-client');
      const { authenticateFoundry } = await import('../auth.js');
      // afterEach's resetAllMocks() clears the module-factory resolved value.
      vi.mocked(authenticateFoundry).mockResolvedValue({
        session: 'test-session',
        userId: 'test-user-id',
      });
      const harness = buildHandshakeSocket(structuredClone(WORLD_DATA));
      vi.mocked(io).mockReturnValue(harness.socket as never);

      const connected =
        existing ??
        new FoundryClient({
          baseUrl: 'http://localhost:30000',
          username: 'gm',
          password: 'secret',
        });

      const connecting = connected.connect();
      // connect() awaits authentication before attaching the handshake
      // listeners, so wait for the 'session' listener before firing it.
      await vi.waitFor(() => expect(harness.listeners.get('session')?.length).toBe(1));
      harness.fire('session', { userId: 'test-user-id' });
      await connecting;

      return { client: connected, ...harness };
    }

    it('reports connected after a successful handshake', async () => {
      const { client: connected } = await connectWithMockSocket();
      expect(connected.isConnected()).toBe(true);
    });

    it('reports disconnected once the socket drops without disconnect()', async () => {
      const { client: connected, socket, fire } = await connectWithMockSocket();

      // Simulate the server going away: Socket.IO flips `connected` and emits
      // 'disconnect'. `disconnect()` is deliberately NOT called.
      socket.connected = false;
      fire('disconnect', 'transport close');

      expect(connected.isConnected()).toBe(false);
    });

    it('reports disconnected on a silent drop even without a disconnect event', async () => {
      const { client: connected, socket } = await connectWithMockSocket();
      socket.connected = false;
      expect(connected.isConnected()).toBe(false);
    });

    it('get_health_status reports the dropped socket', async () => {
      const { handleGetHealthStatus } = await import('../../tools/handlers/diagnostics.js');
      const { client: connected, socket, fire } = await connectWithMockSocket();
      const diagnosticsClient = {
        getSystemHealth: vi.fn().mockRejectedValue(new Error('diagnostics unavailable')),
      };

      const before = await handleGetHealthStatus(
        {},
        connected,
        diagnosticsClient as unknown as Parameters<typeof handleGetHealthStatus>[2],
      );
      expect((before.content[0] as { text: string }).text).toContain('✅ Connected');

      socket.connected = false;
      fire('disconnect', 'transport close');

      const after = await handleGetHealthStatus(
        {},
        connected,
        diagnosticsClient as unknown as Parameters<typeof handleGetHealthStatus>[2],
      );
      expect((after.content[0] as { text: string }).text).toContain('❌ Disconnected');
    });

    it('marks the cached world data stale after a drop, but keeps serving it', async () => {
      const { client: connected, socket, fire } = await connectWithMockSocket();
      expect(connected.isWorldDataStale()).toBe(false);

      socket.connected = false;
      fire('disconnect', 'transport close');

      expect(connected.isWorldDataStale()).toBe(true);
      // The snapshot is retained — a stale answer beats no answer.
      expect(connected.hasWorldData()).toBe(true);
      expect(connected.getUsers().users).toHaveLength(2);
    });

    /**
     * socket.io-client reconnects with `reconnection: true` by default and
     * `sessionSocketOptions` does not turn it off, so after a transient drop
     * the manager brings the SAME socket back up and re-emits 'connect'.
     * Liveness has to follow it back up, not latch off for the rest of the
     * process while broadcasts and writes are working again.
     */
    it('reports connected again when the socket auto-reconnects', async () => {
      const { client: connected, socket, fire } = await connectWithMockSocket();

      socket.connected = false;
      fire('disconnect', 'transport close');
      expect(connected.isConnected()).toBe(false);

      // What socket.io does on an automatic reconnect of the same instance.
      socket.connected = true;
      fire('connect');

      expect(connected.isConnected()).toBe(true);
      // The gap was not replayed: broadcasts missed while the socket was down
      // are gone, so the cache stays flagged until an explicit refresh.
      expect(connected.isWorldDataStale()).toBe(true);
    });

    /**
     * And the flag has to reach a human. A reconnected client that reports
     * "✅ Connected" while serving a cache that missed every broadcast from the
     * outage is the sharper version of #217's second impact bullet.
     */
    it('get_health_status shows a reconnect resynced the cache', async () => {
      const { handleGetHealthStatus } = await import('../../tools/handlers/diagnostics.js');
      const { client: connected, socket, fire } = await connectWithMockSocket();
      const diagnosticsClient = {
        getSystemHealth: vi.fn().mockRejectedValue(new Error('diagnostics unavailable')),
      } as unknown as Parameters<typeof handleGetHealthStatus>[2];

      const before = await handleGetHealthStatus({}, connected, diagnosticsClient);
      expect((before.content[0] as { text: string }).text).not.toMatch(/stale/i);

      socket.connected = false;
      fire('disconnect', 'transport close');
      const worldRequests = () =>
        socket.emit.mock.calls.filter(([event]) => event === 'world').length;
      const requestsBefore = worldRequests();
      socket.connected = true;
      fire('connect');
      await new Promise((r) => setTimeout(r, 0));

      const after = (await handleGetHealthStatus({}, connected, diagnosticsClient)).content[0] as {
        text: string;
      };

      // The reconnect re-requests the world (answered through the ack), so the
      // missed broadcasts no longer leave the cache stale.
      expect(worldRequests()).toBe(requestsBefore + 1);
      expect(after.text).toContain('✅ Connected');
      expect(after.text).not.toMatch(/stale/i);
    });

    it('removes the persistent connect listener on explicit disconnect()', async () => {
      const { client: connected, socket, listeners } = await connectWithMockSocket();

      const registered = socket.on.mock.calls
        .filter(([event]) => event === 'connect')
        .map(([, handler]) => handler);
      expect(registered).toHaveLength(1);

      await connected.disconnect();

      expect(socket.off).toHaveBeenCalledWith('connect', registered[0]);
      expect(listeners.get('connect') ?? []).toHaveLength(0);
    });

    /**
     * `DiagnosticsClient.testAuthentication()` calls `connect()` on a client
     * that is already connected. The superseded socket used to keep the same
     * bound 'disconnect' handler, so when it closed it cleared liveness for the
     * live socket that had replaced it.
     */
    it('a superseded socket cannot clear liveness for its replacement', async () => {
      const first = await connectWithMockSocket();
      const second = await connectWithMockSocket(first.client);
      expect(second.socket).not.toBe(first.socket);
      expect(first.client.isConnected()).toBe(true);

      // The orphaned socket finally closes.
      first.socket.connected = false;
      first.fire('disconnect', 'transport close');

      expect(first.client.isConnected()).toBe(true);
      expect(first.client.isWorldDataStale()).toBe(false);
    });

    it('removes the persistent disconnect listener on explicit disconnect()', async () => {
      const { client: connected, socket, listeners } = await connectWithMockSocket();

      const registered = socket.on.mock.calls
        .filter(([event]) => event === 'disconnect')
        .map(([, handler]) => handler);
      expect(registered).toHaveLength(1);

      await connected.disconnect();

      expect(socket.off).toHaveBeenCalledWith('disconnect', registered[0]);
      expect(listeners.get('disconnect') ?? []).toHaveLength(0);
    });

    /**
     * Issue #218 — presence used to be frozen at the world snapshot: nothing
     * subscribed to `userActivity`, and `modifyDocument` maps onto document
     * collections, never the top-level `activeUsers` field.
     */
    it('applies a userActivity login to the cache and to get_users', async () => {
      const { handleGetUsers } = await import('../../tools/handlers/users.js');
      const { client: connected, fire } = await connectWithMockSocket();

      expect(connected.getUsers().activeUsers).toEqual(['user-aaaaaaaaaaaaaa']);
      const before = await handleGetUsers({}, connected);
      expect((before.content[0] as { text: string }).text).toContain('(1/2 online)');

      fire('userActivity', 'user-bbbbbbbbbbbbbb', { active: true });

      expect(connected.getUsers().activeUsers).toEqual([
        'user-aaaaaaaaaaaaaa',
        'user-bbbbbbbbbbbbbb',
      ]);
      const after = await handleGetUsers({}, connected);
      const text = (after.content[0] as { text: string }).text;
      expect(text).toContain('(2/2 online)');
      expect(text).toContain('**Player** (Player) — Online');
    });

    it('applies a userActivity logout to the cache and to get_users', async () => {
      const { handleGetUsers } = await import('../../tools/handlers/users.js');
      const { client: connected, fire } = await connectWithMockSocket();

      fire('userActivity', 'user-aaaaaaaaaaaaaa', { active: false });

      expect(connected.getUsers().activeUsers).toEqual([]);
      const after = await handleGetUsers({}, connected);
      const text = (after.content[0] as { text: string }).text;
      expect(text).toContain('(0/2 online)');
      expect(text).toContain('**GM** (Game Master) — Offline');
    });

    it('ignores a malformed userActivity payload rather than corrupting the cache', async () => {
      const { client: connected, fire } = await connectWithMockSocket();

      fire('userActivity', 42, { active: false });
      fire('userActivity', 'user-bbbbbbbbbbbbbb', { active: 'yes' });

      expect(connected.getUsers().activeUsers).toEqual(['user-aaaaaaaaaaaaaa']);
    });

    it('removes the userActivity listener on disconnect()', async () => {
      const { client: connected, socket, listeners } = await connectWithMockSocket();

      const registered = socket.on.mock.calls
        .filter(([event]) => event === 'userActivity')
        .map(([, handler]) => handler);
      expect(registered).toHaveLength(1);

      await connected.disconnect();

      expect(socket.off).toHaveBeenCalledWith('userActivity', registered[0]);
      expect(listeners.get('userActivity') ?? []).toHaveLength(0);
    });
  });
});
