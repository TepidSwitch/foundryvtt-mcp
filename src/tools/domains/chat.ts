/**
 * @fileoverview Chat tools: foundry_chat (read and dice)
 */

import { z } from 'zod';
import { action, DomainTool } from '../domain.js';
import { handleGetChatMessages } from '../handlers/chat.js';
import { handleRollDice } from '../handlers/dice.js';

export const chatTool = new DomainTool({
  name: 'foundry_chat',
  title: 'Foundry chat and dice',
  toolset: 'chat',
  write: false,
  description: 'Read the chat log and roll dice.',
  actions: {
    read: action({
      description:
        'The most recent chat messages from the game log: what players said and roll results.',
      schema: z.object({
        limit: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe('How many messages (default 20, max 100)'),
      }),
      run: (a, ctx) => handleGetChatMessages(a, ctx.foundryClient),
    }),
    roll: action({
      description:
        'Roll dice and return the total with a per-term breakdown. Dice terms and whole numbers joined by + or - ("1d20+5", "2d6 + 1d4", "3d6"; "d20" means one die) always work. Multiplication and modifiers such as "4d6kh3" or "1d20r1" are rejected with an error naming the character and position. Parentheses are evaluated only when FOUNDRY_API_KEY is set (Foundry\'s Roll engine); the default Socket.IO transport rolls locally and rejects them, so prefer the expanded form.',
      schema: z.object({
        formula: z.string().describe('Dice formula, e.g. "1d20+5"'),
        reason: z.string().optional().describe('Optional reason for the roll'),
      }),
      run: (a, ctx) => handleRollDice(a, ctx.foundryClient),
    }),
  },
});
