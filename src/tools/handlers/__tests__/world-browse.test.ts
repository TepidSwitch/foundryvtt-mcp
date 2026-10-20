/**
 * @fileoverview Unit tests for the world browse handler
 */

import { describe, expect, it } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { handleBrowseWorld } from '../world-browse.js';

const textOf = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? '';

describe('handleBrowseWorld', () => {
  it('pages rows with offset and a footer', async () => {
    const tables = Array.from({ length: 25 }, (_, i) => ({
      _id: `TABLE${i}`,
      name: `Table ${i}`,
      formula: '1d20',
      results: [],
    }));
    const client = {
      getWorldSnapshot: () => ({ tables }),
    } as unknown as FoundryClient;

    const page = textOf(await handleBrowseWorld({ kind: 'tables', limit: 5, offset: 20 }, client));

    expect(page).toContain('**Table 20**');
    expect(page).toContain('**Table 24**');
    expect(page).not.toContain('**Table 19**');
    expect(page).toContain('_Showing 21–25 of 25._');
  });
});
