/**
 * @fileoverview foundry_script handler: runs a script in the QuickJS sandbox
 * with every write grouped into one undoable batch.
 */

import { createHash } from 'node:crypto';
import type { FoundryClient } from '../../foundry/client.js';
import { ScriptApi } from '../../script/api.js';
import { runInSandbox } from '../../script/sandbox.js';
import type { ToolResult } from '../base.js';

const TIMEOUT_MS = 60_000;
const MEMORY_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 20_000;

/** Hashes of scripts already run in this server process (first run is always a dry run). */
const seenScripts = new Set<string>();

export function resetSeenScripts(): void {
  seenScripts.clear();
}

export async function handleRunScript(
  args: { code: string; dry_run?: boolean },
  client: FoundryClient,
  limits: { timeoutMs?: number } = {},
): Promise<ToolResult> {
  const hash = createHash('sha256').update(args.code).digest('hex').slice(0, 12);
  const firstRun = !seenScripts.has(hash);
  const dryRun = args.dry_run ?? firstRun;
  seenScripts.add(hash);

  const api = new ScriptApi(client);
  let batchId: string | null = null;
  const run = () =>
    client.withBatch(async () => {
      batchId = client.getCurrentBatchId();
      return runInSandbox(args.code, {
        timeoutMs: limits.timeoutMs ?? TIMEOUT_MS,
        memoryBytes: MEMORY_BYTES,
        maxOutputChars: MAX_OUTPUT_CHARS,
        call: (m, a) => api.call(m, a),
      });
    });
  const result = await (dryRun ? client.withDryRun(run) : run());

  const lines = [
    `${result.ok ? '✅' : '❌'} Script ${hash} ${dryRun ? 'DRY RUN (nothing written)' : 'ran'}: ${api.calls} API calls, ${api.writes} write calls.`,
  ];
  if (dryRun && api.writes > 0) {
    lines.push(
      `Review the output, then run the same code with dry_run=false to apply it${firstRun ? ' (first runs of a script are always dry)' : ''}.`,
    );
  }
  if (!dryRun && api.writes > 0 && batchId) {
    lines.push(
      `Undo everything with foundry_history_edit undo write_id of any write in batch ${batchId}.`,
    );
  }
  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }
  if (result.logs.length) {
    lines.push(`Logs:\n${result.logs.join('\n')}`);
  }
  if (result.truncated) {
    lines.push('(logs truncated)');
  }
  if (result.ok) {
    lines.push(`Result: ${JSON.stringify(result.value ?? null)}`);
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    ...(result.ok ? {} : { isError: true }),
  };
}
