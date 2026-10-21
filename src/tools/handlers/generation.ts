/**
 * @fileoverview Content generation tool handlers
 *
 * Handles NPC generation, loot generation, and rule lookups.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import { withToolError } from './utils.js';

/**
 * Handles loot generation requests
 */
export async function handleGenerateLoot(
  args: {
    challengeRating?: number;
    treasureType?: string;
  },
  _foundryClient: FoundryClient,
) {
  const { challengeRating = 1, treasureType = 'individual' } = args;

  return withToolError('generate loot', async () => {
    const loot = generateLootForCR(challengeRating, treasureType);

    return {
      content: [
        {
          type: 'text',
          text: `💰 **Generated Loot**
**Challenge Rating:** ${challengeRating}
**Treasure Type:** ${treasureType}

**Currency:**
${loot.currency.map((c) => `- ${c.amount} ${c.type}`).join('\n')}

**Items:**
${loot.items.map((item) => `- ${item.name} (${item.rarity})`).join('\n')}

**Total Estimated Value:** ${loot.totalValue} gp`,
        },
      ],
    };
  });
}

/**
 * Handles rule lookup requests
 */
export async function handleLookupRule(
  args: {
    query: string;
    system?: string;
  },
  _foundryClient: FoundryClient,
) {
  const { query, system = 'D&D 5e' } = args;

  if (!query || typeof query !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'Query is required and must be a string');
  }

  return withToolError('lookup rule', async () => {
    const ruleInfo = lookupGameRule(query, system);

    return {
      content: [
        {
          type: 'text',
          text: `📖 **Rule Lookup: ${query}**
**System:** ${system}

**Rule:** ${ruleInfo.title}
**Description:** ${ruleInfo.description}

**Mechanics:** ${ruleInfo.mechanics}

**Source:** ${ruleInfo.source}`,
        },
      ],
    };
  });
}

// Helper functions for content generation

function generateLootForCR(cr: number, _type: string) {
  const baseValue = Math.floor(cr * 100 * (0.5 + Math.random()));

  return {
    currency: [
      { amount: Math.floor(baseValue * 0.1), type: 'gp' as const },
      { amount: Math.floor(baseValue * 0.05), type: 'sp' as const },
      { amount: Math.floor(baseValue * 0.02), type: 'cp' as const },
    ],
    items: [
      { name: 'Healing Potion' as const, rarity: 'Common' as const },
      { name: 'Silver Ring' as const, rarity: 'Common' as const },
    ],
    totalValue: baseValue,
  };
}

function lookupGameRule(query: string, system: string) {
  // Mock rule lookup - in a real implementation, this would query actual rule databases
  return {
    title: `${query} Rule`,
    description: `Rules and mechanics for ${query} in ${system}.`,
    mechanics: `Detailed explanation of how ${query} works mechanically.`,
    source: `${system} Core Rulebook`,
  };
}
