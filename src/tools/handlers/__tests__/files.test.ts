/**
 * @fileoverview Unit tests for the files browse handler
 */

import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { handleBrowseFiles } from '../files.js';

const textOf = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? '';

describe('handleBrowseFiles', () => {
  it('pages folders then files with offset and a footer', async () => {
    const browseFiles = vi.fn(async () => ({
      target: 'worlds/x',
      dirs: ['maps'],
      files: ['a.png', 'b.png', 'c.png'],
    }));
    const client = { browseFiles } as unknown as FoundryClient;

    const page = textOf(await handleBrowseFiles({ path: 'worlds/x', limit: 2, offset: 1 }, client));

    expect(browseFiles).toHaveBeenCalledWith('worlds/x', {});
    expect(page).not.toContain('maps');
    expect(page).toContain('- a.png');
    expect(page).toContain('- b.png');
    expect(page).not.toContain('- c.png');
    expect(page).toContain('_Showing 2–3 of 4; next offset=3._');
  });
});
