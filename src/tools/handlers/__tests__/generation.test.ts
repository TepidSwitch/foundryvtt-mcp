/**
 * @fileoverview Unit tests for content generation handlers
 *
 * Covers handleGenerateLoot, and handleLookupRule.
 * Math.random is stubbed for determinism.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { handleGenerateLoot, handleLookupRule } from '../generation.js';

// The handlers do not call any FoundryClient methods, so an empty stub suffices.
const stubClient = {} as unknown as FoundryClient;

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('handleGenerateLoot', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('happy path', () => {
    it('returns formatted loot with default CR=1 and treasureType=individual', async () => {
      const result = await handleGenerateLoot({}, stubClient);
      const text = getText(result);

      expect(text).toContain('Generated Loot');
      expect(text).toContain('**Challenge Rating:** 1');
      expect(text).toContain('**Treasure Type:** individual');
      expect(text).toContain('**Currency:**');
      expect(text).toContain('**Items:**');
      expect(text).toContain('**Total Estimated Value:**');
      expect(text).toContain('gp');
    });
  });

  describe('edge cases', () => {
    it('honors caller-supplied challengeRating and treasureType', async () => {
      const result = await handleGenerateLoot(
        { challengeRating: 10, treasureType: 'hoard' },
        stubClient,
      );
      const text = getText(result);

      expect(text).toContain('**Challenge Rating:** 10');
      expect(text).toContain('**Treasure Type:** hoard');
    });
  });
});

describe('handleLookupRule', () => {
  describe('happy path', () => {
    it('returns formatted rule with default system D&D 5e', async () => {
      const result = await handleLookupRule({ query: 'Grapple' }, stubClient);
      const text = getText(result);

      expect(text).toContain('Rule Lookup: Grapple');
      expect(text).toContain('**System:** D&D 5e');
      expect(text).toContain('**Rule:** Grapple Rule');
      expect(text).toContain('**Description:**');
      expect(text).toContain('**Mechanics:**');
      expect(text).toContain('**Source:** D&D 5e Core Rulebook');
    });

    it('honors caller-supplied system', async () => {
      const result = await handleLookupRule(
        { query: 'Sanity', system: 'Call of Cthulhu' },
        stubClient,
      );
      const text = getText(result);

      expect(text).toContain('**System:** Call of Cthulhu');
      expect(text).toContain('**Source:** Call of Cthulhu Core Rulebook');
    });
  });

  describe('edge cases', () => {
    it('throws McpError when query is empty string', async () => {
      await expect(
        handleLookupRule({ query: '' } as { query: string }, stubClient),
      ).rejects.toThrow(/Query is required/);
    });

    it('throws McpError when query is not a string', async () => {
      await expect(
        // Intentionally passing wrong type to exercise runtime guard
        handleLookupRule({ query: 42 } as unknown as { query: string }, stubClient),
      ).rejects.toThrow(/Query is required/);
    });
  });
});
