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

import { McpSession, loadServerEnv, serverPath } from './lib/mcp-session.js';
import { existsSync } from 'node:fs';

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
        { name: 'foundry_world', args: { action: 'users' } },
        { name: 'foundry_world', args: { action: 'summary' } },
        { name: 'foundry_diagnostics', args: { action: 'health' } },
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

async function main(): Promise<void> {
  if (!existsSync(serverPath)) {
    throw new Error(`${serverPath} not found. Run \`npm run build\` first.`);
  }
  const { calls, dryRun } = parseArgs(process.argv.slice(2));

  const env: Record<string, string> = { ...loadServerEnv() };
  if (dryRun) {
    env.FOUNDRY_DRY_RUN = 'true';
  }

  const timer = setTimeout(() => {
    console.error(`TIMEOUT after ${TIMEOUT_MS / 1000}s`);
    process.exit(1);
  }, TIMEOUT_MS);

  let failed = false;
  let session: McpSession | undefined;
  try {
    session = await McpSession.start(env);
    if (dryRun) {
      console.log('[dry-run] FOUNDRY_DRY_RUN=true, writes are simulated\n');
    }
    for (const call of calls) {
      const res = await session.call(call.name, call.args);
      failed ||= res.isError;
      console.log(`=== ${call.name} ${res.isError ? 'FAILED' : 'ok'} (${res.ms} ms)`);
      console.log(res.text);
      console.log();
    }
  } finally {
    clearTimeout(timer);
    session?.close();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
