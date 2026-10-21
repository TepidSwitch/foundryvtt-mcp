/**
 * Shared helpers for the live scripts: read the server env from the Claude
 * Desktop config and talk to the built server (`dist/index.js`) over MCP stdio.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const serverPath = join(repoRoot, 'dist', 'index.js');

export function loadServerEnv(): Record<string, string> {
  const path =
    process.env.CLAUDE_DESKTOP_CONFIG ??
    join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
  if (!existsSync(path)) {
    throw new Error(`Claude Desktop config not found at ${path} (set CLAUDE_DESKTOP_CONFIG)`);
  }
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const entry = config.mcpServers?.['foundryvtt-mcp'];
  if (!entry) {
    throw new Error(`No mcpServers.foundryvtt-mcp entry in ${path}`);
  }
  return entry.env ?? {};
}

export interface ToolResult {
  text: string;
  isError: boolean;
  ms: number;
}

export class McpSession {
  private nextId = 1;
  private buf = '';
  private readonly pending = new Map<number, (msg: any) => void>();
  private closed = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly timeoutMs: number,
  ) {
    child.stderr.on('data', (d) => process.stderr.write(String(d)));
    child.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let nl = this.buf.indexOf('\n');
      while (nl >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        nl = this.buf.indexOf('\n');
        try {
          const msg = JSON.parse(line);
          this.pending.get(msg.id)?.(msg);
        } catch {
          // not JSON-RPC; ignore
        }
      }
    });
    child.on('exit', () => {
      this.closed = true;
      for (const resolve of this.pending.values()) {
        resolve({ error: { message: 'server process exited' } });
      }
    });
  }

  /** Spawn the built server with `env` layered over the process env and handshake. */
  static async start(
    extraEnv: Record<string, string>,
    opts: { clientName?: string; timeoutMs?: number } = {},
  ): Promise<McpSession> {
    if (!existsSync(serverPath)) {
      throw new Error(`${serverPath} not found. Run \`npm run build\` first.`);
    }
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, LOG_LEVEL: 'error' };
    const child = spawn('node', [serverPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const session = new McpSession(child, opts.timeoutMs ?? 90_000);
    await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: opts.clientName ?? 'live-check', version: '1' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return session;
  }

  private request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve({ error: { message: 'server process is not running' } });
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: `timeout after ${this.timeoutMs / 1000}s` } });
      }, this.timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(msg);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const started = Date.now();
    const res = await this.request('tools/call', { name, arguments: args });
    const text = res.error
      ? JSON.stringify(res.error)
      : (res.result?.content ?? [])
          .map((c: { type: string; text?: string }) =>
            c.type === 'text' ? c.text : `[${c.type}]`,
          )
          .join('\n');
    return {
      text,
      isError: Boolean(res.error || res.result?.isError),
      ms: Date.now() - started,
    };
  }

  /** Tool names the server exposes. */
  async listTools(): Promise<string[]> {
    const res = await this.request('tools/list', {});
    return (res.result?.tools ?? []).map((t: { name: string }) => t.name);
  }

  close(): void {
    this.closed = true;
    this.child.kill();
  }
}
