/**
 * @fileoverview Actor management tool handlers
 *
 * Handles searching for actors and retrieving detailed actor information.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import { actorLabel, resolveActor, sheetFor } from './character.js';
import { buildSheet } from './dnd5e.js';
import { withToolError } from './utils.js';

/**
 * Handles actor search requests
 */
export async function handleSearchActors(
  args: {
    query?: string;
    type?: string;
    limit?: number;
  },
  foundryClient: FoundryClient,
) {
  const { query, type, limit = 10 } = args;

  return withToolError('search actors', async () => {
    const searchParams: { query: string; type?: string; limit: number } = {
      query: query || '',
      limit,
    };
    if (type) {
      searchParams.type = type;
    }
    const result = await foundryClient.searchActors(searchParams);

    const actorList = result.actors
      .map((actor) => {
        // Prefer values derived from the raw world data (class levels, computed max
        // HP): the snapshot stores neither, so the mapped actor shows "Unknown".
        const raw = foundryClient.getRawActor?.(actor._id);
        if (raw) {
          const sheet = buildSheet(raw);
          const hp =
            sheet.hp.max === null ? `${sheet.hp.value}/?` : `${sheet.hp.value}/${sheet.hp.max}`;
          return `- **${actor.name}** (${actor.type}) - ${actorLabel(raw)} - HP: ${hp} - id \`${actor._id}\``;
        }
        return `- **${actor.name}** (${actor.type}) - Level ${actor.level || 'Unknown'} - HP: ${actor.hp?.value || 'Unknown'}/${actor.hp?.max || 'Unknown'} - id \`${actor._id}\``;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `🎭 **Actor Search Results**
**Query:** ${query || 'All actors'}
**Type Filter:** ${type || 'All types'}
**Results:** ${result.actors.length}/${result.total} total

${actorList || 'No actors found matching the criteria.'}

**Page:** ${result.page} | **Limit:** ${result.limit}`,
        },
      ],
    };
  });
}

/**
 * Handles detailed actor information requests
 */
export async function handleGetActorDetails(
  args: {
    actorId?: string;
    actor?: string;
  },
  foundryClient: FoundryClient,
) {
  const actorId = args.actor ?? args.actorId;

  if (!actorId || typeof actorId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'Actor ID is required and must be a string');
  }

  return withToolError('get actor details', async () => {
    // Socket.IO mode: full computed sheet from the world snapshot. Accepts an id,
    // a name, or a player's name.
    if (foundryClient.getWorldSnapshot?.()) {
      const resolved = resolveActor(foundryClient, actorId);
      return { content: [{ type: 'text', text: sheetFor(foundryClient, resolved) }] };
    }

    // REST mode fallback: the module's actor summary.
    const actor = await foundryClient.getActor(actorId);

    const abilities = actor.abilities
      ? Object.entries(actor.abilities)
          .map(
            ([key, ability]: [string, { value: number; mod: number }]) =>
              `**${key.toUpperCase()}:** ${ability.value} (${ability.mod >= 0 ? '+' : ''}${ability.mod})`,
          )
          .join('\n')
      : 'No ability scores available';

    return {
      content: [
        {
          type: 'text',
          text: `🎭 **Actor Details: ${actor.name}**
**Type:** ${actor.type}
**Level:** ${actor.level || 'Unknown'}
**Hit Points:** ${actor.hp?.value || 'Unknown'}/${actor.hp?.max || 'Unknown'}
**Armor Class:** ${actor.ac?.value || 'Unknown'}

**Ability Scores:**
${abilities}

**Description:** ${(actor as { description?: string }).description || 'No description available.'}`,
        },
      ],
    };
  });
}
