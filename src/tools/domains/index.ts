/**
 * @fileoverview Every domain tool, in the order they are listed
 */

import type { Tool } from '../base.js';
import { actorsEditTool, actorsTool } from './actors.js';
import { audioEditTool, audioTool } from './audio.js';
import { chatEditTool, chatTool } from './chat.js';
import { combatEditTool, combatTool } from './combat.js';
import { compendiumTool } from './compendium.js';
import { diagnosticsTool } from './diagnostics.js';
import { effectsEditTool } from './effects.js';
import { generateTool } from './generate.js';
import { historyEditTool, historyTool } from './history.js';
import { itemsEditTool, itemsTool } from './items.js';
import { journalsEditTool, journalsTool } from './journals.js';
import { scenesEditTool, scenesTool, tokensEditTool } from './scenes.js';
import { worldTool } from './world.js';
import { worldEditTool } from './world-edit.js';

export const ALL_DOMAIN_TOOLS: Tool[] = [
  actorsTool,
  actorsEditTool,
  itemsTool,
  itemsEditTool,
  effectsEditTool,
  scenesTool,
  scenesEditTool,
  tokensEditTool,
  combatTool,
  combatEditTool,
  journalsTool,
  journalsEditTool,
  compendiumTool,
  audioTool,
  audioEditTool,
  chatTool,
  chatEditTool,
  worldTool,
  worldEditTool,
  generateTool,
  historyTool,
  historyEditTool,
  diagnosticsTool,
];
