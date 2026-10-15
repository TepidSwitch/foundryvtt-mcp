/**
 * @fileoverview Generation tools: foundry_generate (read)
 */

import { z } from 'zod';
import { action, DomainTool } from '../domain.js';
import { handleGenerateLoot, handleGenerateNPC, handleLookupRule } from '../handlers/generation.js';

export const generateTool = new DomainTool({
  name: 'foundry_generate',
  title: 'Generate content',
  toolset: 'generate',
  write: false,
  description: 'Generate throwaway content as text. Nothing is created in Foundry.',
  actions: {
    npc: action({
      description:
        'Random NPC (name, race, class, HP, ability scores, background) as text. Creates no documents.',
      schema: z.object({
        level: z.number().min(1).max(20).optional().describe('NPC level 1-20 (default 1)'),
        race: z.string().optional().describe('Race'),
        class: z.string().optional().describe('Class'),
      }),
      run: (a, ctx) => handleGenerateNPC(a, ctx.foundryClient),
    }),
    loot: action({
      description:
        'Random treasure as text. Only the currency scales with challenge rating; the item list is fixed (a Healing Potion and a Silver Ring) and treasureType is accepted but unused. Creates no documents.',
      schema: z.object({
        challengeRating: z.number().min(0).max(30).optional().describe('Challenge rating 0-30'),
        treasureType: z.string().optional().describe('Accepted but unused'),
      }),
      run: (a, ctx) => handleGenerateLoot(a, ctx.foundryClient),
    }),
    rule: action({
      description:
        'Stub: builds a templated placeholder from the query and consults no rules source, so its text carries no rules content.',
      schema: z.object({
        query: z.string().describe('Rule to look up'),
        system: z.string().optional().describe('Game system'),
      }),
      run: (a, ctx) => handleLookupRule(a, ctx.foundryClient),
    }),
  },
});
