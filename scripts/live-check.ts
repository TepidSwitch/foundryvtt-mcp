#!/usr/bin/env tsx

/**
 * Live check: spawns the built server (`dist/index.js`) over stdio and talks
 * to the real Foundry world through it, like Claude Desktop does.
 *
 * Usage (run `npm run build` first):
 *   tsx scripts/live-check.ts --read                      users, world summary, health
 *   tsx scripts/live-check.ts --dry-run --call <tool> '<json>'   writes are simulated
 *   tsx scripts/live-check.ts --call <tool> '<json>'      real call (writes need FOUNDRY_WRITE_ENABLED)
 *
 * Env comes from mcpServers.foundryvtt-mcp.env in the Claude Desktop config
 * (override the file with CLAUDE_DESKTOP_CONFIG); credentials load from
 * ~/.config/foundryvtt-mcp/.env inside the server itself.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = join(repoRoot, 'dist', 'index.js');
const TIMEOUT_MS = 90_000;

interface Call {
  name: string;
  args: Record<string, unknown>;
}

function parseArgs(argv: string[]): { calls: Call[]; dryRun: boolean } {
  const calls: Call[] = [];
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--read') {
      calls.push(
        { name: 'get_users', args: {} },
        { name: 'get_world_summary', args: {} },
        { name: 'get_health_status', args: {} },
      );
    } else if (arg === '--call') {
      const name = argv[++i];
      if (!name) {
        throw new Error('--call needs a tool name');
      }
      const raw = argv[i + 1]?.startsWith('--') ? undefined : argv[++i];
      calls.push({ name, args: raw ? JSON.parse(raw) : {} });
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (calls.length === 0) {
    throw new Error('Nothing to do. Use --read or --call <tool> [json] (optionally with --dry-run).');
  }
  return { calls, dryRun };
}

function loadServerEnv(): Record<string, string> {
  const path =
    process.env.CLAUDE_DESKTOP_CONFIG ?? join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
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

async function main(): Promise<void> {
  if (!existsSync(serverPath)) {
    throw new Error(`${serverPath} not found. Run \`npm run build\` first.`);
  }
  const { calls, dryRun } = parseArgs(process.argv.slice(2));

  const env: NodeJS.ProcessEnv = { ...process.env, ...loadServerEnv(), LOG_LEVEL: 'error' };
  if (dryRun) {
    env.FOUNDRY_DRY_RUN = 'true';
  }

  const child = spawn('node', [serverPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => process.stderr.write(String(d)));

  const pending = new Map<number, (msg: any) => void>();
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      try {
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg);
      } catch {
        // not JSON-RPC; ignore
      }
    }
  });

  let nextId = 1;
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const timer = setTimeout(() => {
    console.error(`TIMEOUT after ${TIMEOUT_MS / 1000}s`);
    child.kill();
    process.exit(1);
  }, TIMEOUT_MS);

  let failed = false;
  try {
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'live-check', version: '1' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    if (dryRun) {
      console.log('[dry-run] FOUNDRY_DRY_RUN=true, writes are simulated\n');
    }
    for (const call of calls) {
      const started = Date.now();
      const res = await request('tools/call', { name: call.name, arguments: call.args });
      const text = (res.result?.content ?? [])
        .map((c: { type: string; text?: string }) => (c.type === 'text' ? c.text : `[${c.type}]`))
        .join('\n');
      const isError = Boolean(res.error || res.result?.isError);
      failed ||= isError;
      console.log(`=== ${call.name} ${isError ? 'FAILED' : 'ok'} (${Date.now() - started} ms)`);
      console.log(res.error ? JSON.stringify(res.error) : text);
      console.log();
    }
  } finally {
    clearTimeout(timer);
    child.kill();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
