import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolContext } from '../base.js';
import { action, DomainTool } from '../domain.js';

const tool = new DomainTool({
  name: 'foundry_demo',
  title: 'Demo',
  toolset: 'world',
  write: false,
  destructive: false,
  description: 'demo',
  actions: {
    echo: action({
      description: 'Echo the window',
      schema: z.object({ timeframe_seconds: z.number().optional() }),
      run: async (a) => ({
        content: [{ type: 'text', text: `window ${a.timeframe_seconds ?? 3600}` }],
      }),
    }),
  },
});

const run = (args: Record<string, unknown>) => tool.execute(args, {} as ToolContext);

describe('DomainTool unknown arguments', () => {
  it('runs the action and says which arguments it ignored', async () => {
    // Live finding: a misnamed argument silently fell back to the default.
    const result = await run({ action: 'echo', timeout_seconds: 60 });
    expect(result.content[0]?.text).toBe('window 3600');
    expect(result.content[1]?.text).toContain('Ignored unknown argument `timeout_seconds`');
    expect(result.content[1]?.text).toContain('timeframe_seconds?');
  });

  it('adds nothing when every argument is known', async () => {
    const result = await run({ action: 'echo', timeframe_seconds: 60 });
    expect(result.content).toEqual([{ type: 'text', text: 'window 60' }]);
  });
});
