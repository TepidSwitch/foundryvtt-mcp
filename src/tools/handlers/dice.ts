/**
 * @fileoverview Dice rolling tool handler
 *
 * Rolls locally with the MCP's own roller (see `FoundryClient.rollDice`).
 */

import type { FoundryClient } from '../../foundry/client.js';
import { logger } from '../../utils/logger.js';
import type { ToolResult } from '../base.js';

export async function handleRollDice(
  args: {
    formula: string;
    reason?: string | undefined;
  },
  foundryClient: FoundryClient,
): Promise<ToolResult> {
  const { formula, reason } = args;

  logger.info(`Rolling dice: ${formula}${reason ? ` (${reason})` : ''}`);
  const result = await foundryClient.rollDice(formula, reason);

  return {
    content: [
      {
        type: 'text',
        text: `🎲 **Dice Roll Result**
**Formula:** ${result.formula}
**Total:** ${result.total}
**Breakdown:** ${result.breakdown}
${result.reason ? `**Reason:** ${result.reason}` : ''}
**Timestamp:** ${result.timestamp}`,
      },
    ],
  };
}
