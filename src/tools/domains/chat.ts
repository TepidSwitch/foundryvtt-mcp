/**
 * @fileoverview Chat tools: foundry_chat (read and dice)
 */

import { z } from 'zod';
import { action, DomainTool } from '../domain.js';
import { handleGetChatMessages } from '../handlers/chat.js';
import { handleDrawTable, handleRequestRoll, handleSendChat } from '../handlers/chat-edits.js';
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

const speaker = z
  .string()
  .optional()
  .describe('Speak as this actor (id, name or player name); default is the Game Master');
const alias = z
  .string()
  .optional()
  .describe('Name shown as the speaker (default: the actor, or "Game Master")');
const whisper = z
  .array(z.string())
  .optional()
  .describe('Whisper to these users (names or ids); omit for everyone');
const style = z
  .enum(['other', 'ooc', 'ic', 'emote'])
  .optional()
  .describe(
    'Message style: other, ooc (out of character), ic (in character, default with a speaker), emote',
  );
const abilityList = z
  .array(z.string())
  .optional()
  .describe('Abilities, e.g. ["dex"] or ["str","dex"] for "either"');

export const chatEditTool = new DomainTool({
  name: 'foundry_chat_edit',
  title: 'Post to chat',
  toolset: 'chat',
  write: true,
  destructive: false,
  description:
    'WRITE: post messages to the Foundry chat in the live world: plain messages, roll requests players click to roll for their own character, item cards, and roll-table draws. Only adds messages. Needs FOUNDRY_WRITE_ENABLED=true and a GM login; messages are logged and revertible with foundry_history_edit.',
  actions: {
    send: action({
      description:
        'Post a chat message as the Game Master or as an actor. content is plain text by default (escaped); use format html to include markup or enrichers, or markdown.',
      schema: z.object({
        content: z.string().describe('Message text'),
        format: z
          .enum(['text', 'html', 'markdown'])
          .optional()
          .describe('How content is written (default text)'),
        speaker,
        alias,
        whisper,
        style,
        flavor: z.string().optional().describe('Flavor line shown under the speaker'),
      }),
      run: (a, ctx) => handleSendChat(a, ctx.foundryClient),
    }),
    request_roll: action({
      description:
        'Post a clickable roll request using dnd5e inline rolls: a check (ability and/or skills/tools), skill roll, tool roll, saving throw or concentration save, optionally with a DC. Whoever clicks it rolls with their own character. Skill and tool names may be given as in the sheet ("perception", "sleight of hand").',
      schema: z.object({
        kind: z.enum(['check', 'skill', 'tool', 'save', 'concentration']).describe('Kind of roll'),
        ability: abilityList,
        skill: z
          .array(z.string())
          .optional()
          .describe('Skills, e.g. ["perception"]; several = "either"'),
        tool: z.array(z.string()).optional().describe('Tools, e.g. ["thieves tools"]'),
        dc: z.number().optional().describe('Difficulty class'),
        prompt: z.string().optional().describe('Sentence shown above the roll link'),
        speaker,
        alias,
        whisper,
        flavor: z.string().optional().describe('Flavor line'),
      }),
      run: (a, ctx) => handleRequestRoll(a, ctx.foundryClient),
    }),
    draw_table: action({
      description:
        "Roll a world roll table (plain dice formula such as 1d20) and post the result to chat. The roll is made here; the table's drawn markers are not changed.",
      schema: z.object({
        table: z.string().describe('World roll table id or name'),
        alias,
        whisper,
      }),
      run: (a, ctx) => handleDrawTable(a, ctx.foundryClient),
    }),
  },
});
