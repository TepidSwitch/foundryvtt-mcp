/**
 * @fileoverview Combat tools: foundry_combat (read), foundry_combat_edit (write)
 */

import { z } from 'zod';
import { action, DomainTool, noArgs } from '../domain.js';
import { handleGetCombatState } from '../handlers/combat.js';
import {
  handleEndCombat,
  handleNextTurn,
  handleSetInitiative,
  handleStartCombat,
} from '../handlers/combat-mutations.js';

export const combatTool = new DomainTool({
  name: 'foundry_combat',
  title: 'Foundry combat',
  toolset: 'combat',
  write: false,
  description: 'Read the active combat encounter.',
  actions: {
    state: action({
      description:
        "Active combat: initiative order with each combatant's name, initiative, HP and AC, the current round and whose turn it is. Combatant ids are not printed - read the foundry://combat resource (its combatants[N-1] is the Nth entry here; combat.turn indexes it).",
      schema: noArgs,
      run: (a, ctx) => handleGetCombatState(a, ctx.foundryClient),
    }),
  },
});

export const combatEditTool = new DomainTool({
  name: 'foundry_combat_edit',
  title: 'Run combat',
  toolset: 'combat',
  write: true,
  destructive: true,
  description:
    'WRITE: start, advance and end combat on the active scene in the live world. Needs FOUNDRY_WRITE_ENABLED=true and a GM login.',
  actions: {
    start: action({
      description:
        'Start a new combat seeded from tokens: pass tokenIds, or omit to seed every token on the scene (default: active scene). Always creates an additional encounter - check foundry_combat state first.',
      schema: z.object({
        tokenIds: z.array(z.string()).optional().describe('Tokens to add as combatants'),
        sceneId: z.string().optional().describe('Scene (default: the active scene)'),
      }),
      run: (a, ctx) => handleStartCombat(a, ctx.foundryClient),
    }),
    next_turn: action({
      description:
        'Advance the active combat to the next turn, wrapping to the next round after the last combatant. skipDefeated=true skips defeated combatants.',
      schema: z.object({
        skipDefeated: z.boolean().optional().describe('Skip defeated combatants'),
      }),
      run: (a, ctx) => handleNextTurn(a, ctx.foundryClient),
    }),
    set_initiative: action({
      description:
        "Set a combatant's initiative in the active combat (or combatId), reordering the turn order. If that moves the combatant whose turn it is, the turn index follows them. For another combat the initiative is recorded but its turn order is left alone.",
      schema: z.object({
        combatantId: z.string().describe('Id of the combatant'),
        initiative: z.number().describe('Initiative value'),
        combatId: z.string().optional().describe('Combat to edit (default: the active combat)'),
      }),
      run: (a, ctx) => handleSetInitiative(a, ctx.foundryClient),
    }),
    end: action({
      description:
        'End the active combat by deleting its Combat document, discarding initiative order and round count. Confirm with the user first; foundry_history_edit undo can re-create it.',
      schema: noArgs,
      run: (a, ctx) => handleEndCombat(a, ctx.foundryClient),
    }),
  },
});
