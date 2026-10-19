/**
 * @fileoverview Code-mode tool: foundry_script (toolset `script`, off by default)
 */

import { z } from 'zod';
import { action, DomainTool } from '../domain.js';
import { handleRunScript } from '../handlers/script.js';

export const scriptTool = new DomainTool({
  name: 'foundry_script',
  title: 'Run script',
  toolset: 'script',
  write: true,
  destructive: true,
  description:
    'WRITE: run JavaScript in a sandbox (no network, files or Node access) against a `foundry` API: list/get/create/update/delete documents and chat. Use for bulk edits that would take many tool calls. Limits: 150 API calls, 30 deletes, 60 s. All writes of a run form one undoable batch. The first run of any script is a dry run. The full API is the resource foundry://script-api.d.ts.',
  actions: {
    run: action({
      description:
        'Run the code as the body of an async function (use await, return a JSON value). API: foundry.list(type,{query,limit}), foundry.get(type,id), foundry.create(type,data[],{parent}), foundry.update(type,updates[],{parent}), foundry.delete(type,ids[],{parent}), foundry.chat(text). A new script runs as a dry run (writes are logged, not sent; created ids are fake) - repeat with dry_run=false to apply.',
      schema: z.object({
        code: z.string().min(1).max(20000).describe('JavaScript body of an async function'),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            'Force dry run (true) or real run (false). Default: dry on the first run of a script.',
          ),
      }),
      run: (a, ctx) => handleRunScript(a, ctx.foundryClient),
    }),
  },
});
