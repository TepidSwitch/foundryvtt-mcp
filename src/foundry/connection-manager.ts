/**
 * Keeps a FoundryClient connected without blocking MCP startup.
 *
 * MCP hosts (Claude Desktop) give a stdio server a short window to answer
 * `initialize`, and never restart one that exits. Logging in to Foundry can
 * take ~7s or fail transiently (host restarting, no /join cookie), so the
 * server answers the MCP handshake first and this manager connects in the
 * background with exponential backoff + jitter. Tool calls wait on it.
 */

import { logger } from '../utils/logger.js';

export interface ConnectableClient {
  connect(): Promise<void>;
  isConnected(): boolean;
}

export interface ConnectionManagerOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Random source, injectable for tests. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Credential problems will not fix themselves; retrying only risks a lockout. */
export function isPermanentAuthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /authentication failed \(HTTP 401\)|requires username\/userId and password/i.test(msg);
}

/** Exponential backoff, 50-100% jitter. attempt is 1-based. */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const raw = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(raw * (0.5 + random() * 0.5));
}

export class ConnectionManager {
  private inflight: Promise<void> | null = null;
  private attempts = 0;
  private lastError: string | null = null;
  private fatal: string | null = null;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly client: ConnectableClient,
    opts: ConnectionManagerOptions = {},
  ) {
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.maxDelayMs = opts.maxDelayMs ?? 30_000;
    this.random = opts.random ?? Math.random;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Starts (or joins) the background connect loop. Never rejects. */
  start(): void {
    void this.run().catch(() => undefined);
  }

  /**
   * Resolves once connected; rejects with a human-readable reason if it does
   * not happen within `timeoutMs` or login is permanently rejected.
   */
  async ensureConnected(timeoutMs = 45_000): Promise<void> {
    if (this.client.isConnected()) {
      return;
    }
    // socket.io may be mid-reconnect on its own; give it a moment before a
    // full re-login.
    const attempt = this.run();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Still connecting to FoundryVTT (attempt ${this.attempts}` +
                `${this.lastError ? `, last error: ${this.lastError}` : ''}). ` +
                'Retrying in the background — try again in a few seconds.',
            ),
          ),
        timeoutMs,
      );
    });
    try {
      await Promise.race([attempt, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  status(): {
    connected: boolean;
    attempts: number;
    lastError: string | null;
    fatal: string | null;
  } {
    return {
      connected: this.client.isConnected(),
      attempts: this.attempts,
      lastError: this.lastError,
      fatal: this.fatal,
    };
  }

  private run(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.loop().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async loop(): Promise<void> {
    this.attempts = 0;
    while (!this.client.isConnected()) {
      this.attempts += 1;
      try {
        await this.client.connect();
        this.lastError = null;
        this.fatal = null;
        logger.info('Connected to FoundryVTT', { attempts: this.attempts });
        return;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        if (isPermanentAuthError(error)) {
          this.fatal = `Login rejected: ${this.lastError}. Check FOUNDRY_USERNAME / FOUNDRY_PASSWORD.`;
          logger.error(this.fatal);
          throw new Error(this.fatal);
        }
        const delay = backoffDelay(this.attempts, this.baseDelayMs, this.maxDelayMs, this.random);
        logger.warn(`FoundryVTT connect attempt ${this.attempts} failed; retrying in ${delay}ms`, {
          error: this.lastError,
        });
        await this.sleep(delay);
      }
    }
  }
}

export type ConnectionStatus = ReturnType<ConnectionManager['status']>;

let statusProvider: (() => ConnectionStatus) | null = null;

/** Lets tool handlers (e.g. get_health_status) report login state. */
export function setConnectionStatusProvider(fn: () => ConnectionStatus): void {
  statusProvider = fn;
}

export function getConnectionStatus(): ConnectionStatus | null {
  return statusProvider?.() ?? null;
}
