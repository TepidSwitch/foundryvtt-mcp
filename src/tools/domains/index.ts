/**
 * @fileoverview Every domain tool, in the order they are listed
 */

import type { Tool } from '../base.js';
import { actorsEditTool, actorsTool } from './actors.js';
import { chatTool } from './chat.js';
import { combatEditTool, combatTool } from './combat.js';
import { compendiumTool } from './compendium.js';
import { diagnosticsTool } from './diagnostics.js';
import { effectsEditTool } from './effects.js';
import { generateTool } from './generate.js';
import { historyEditTool, historyTool } from './history.js';
import { itemsEditTool, itemsTool } from './items.js';
import { journalsEditTool, journalsTool } from './journals.js';
import { scenesTool, tokensEditTool } from './scenes.js';
import { worldTool } from './world.js';

export const ALL_DOMAIN_TOOLS: Tool[] = [
  actorsTool,
  actorsEditTool,
  itemsTool,
  itemsEditTool,
  effectsEditTool,
  scenesTool,
  tokensEditTool,
  combatTool,
  combatEditTool,
  journalsTool,
  journalsEditTool,
  compendiumTool,
  chatTool,
  worldTool,
  generateTool,
  historyTool,
  historyEditTool,
  diagnosticsTool,
];
