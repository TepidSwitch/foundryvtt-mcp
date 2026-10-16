/**
 * @fileoverview Token manipulation mutation tool handlers (FR-019)
 *
 * Provides GM-gated token-control tools that operate on tokens placed on
 * scenes: moving a token to new coordinates, and applying/removing a status
 * condition (ActiveEffect) on the token's actor. All are WRITE operations —
 * they require FOUNDRY_WRITE_ENABLED=true and an active Socket.IO connection
 * (mutations use the core `modifyDocument` protocol), and the connected user
 * needs GM/owner permission.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { WorldEffect } from '../../foundry/types.js';
import { withToolError } from './utils.js';

/** Raw token fields we read to resolve its actor and link state. */
interface TokenActorRef {
  actorId?: string;
  actorLink?: boolean;
  name?: string;
  delta?: { effects?: WorldEffect[] };
}

/**
 * Moves a token to x/y coordinates on its scene (FR-019).
 *
 * The token is resolved from the cached worldData; `sceneId` is optional and
 * only scopes the lookup (the parent scene is derived from the located token).
 */
export async function handleMoveToken(
  args: { tokenId: string; x: number; y: number; sceneId?: string },
  foundryClient: FoundryClient,
) {
  const { tokenId, x, y, sceneId } = args;

  if (!tokenId || typeof tokenId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'tokenId is required and must be a string');
  }
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y)
  ) {
    throw new McpError(ErrorCode.InvalidParams, 'x and y are required and must be finite numbers');
  }

  const located = foundryClient.findToken(tokenId, sceneId);
  if (!located) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Token not found: ${tokenId}${sceneId ? ` on scene ${sceneId}` : ''}`,
    );
  }

  return withToolError('move token', async () => {
    const tokenName = (located.token as TokenActorRef).name ?? tokenId;
    await foundryClient.moveToken(located.scene._id, tokenId, x, y);

    return {
      content: [
        {
          type: 'text',
          text: `🚶 **Token Moved**
**Token:** ${tokenName} (${tokenId})
**Scene:** ${located.scene.name} (${located.scene._id})
**Position:** (${x}, ${y})`,
        },
      ],
    };
  });
}

/**
 * Applies or removes a status condition (ActiveEffect) on a token's actor
 * (FR-019).
 *
 * `active` defaults to `true` (apply). Mirrors `Actor#toggleStatusEffect`:
 * the effect is matched by its `statuses` array, so re-applying an already
 * present condition (or removing an absent one) is a no-op. Linked actors
 * resolve to `Actor.<id>`; unlinked tokens target their synthetic actor at
 * `Scene.<sid>.Token.<tid>.ActorDelta.<tid>` (Foundry v14 rejects the
 * older `...Actor.<aid>` form).
 */
export async function handleApplyStatusEffect(
  args: { tokenId: string; statusId: string; active?: boolean; sceneId?: string },
  foundryClient: FoundryClient,
) {
  const { tokenId, statusId, sceneId } = args;
  const active = args.active ?? true;

  if (!tokenId || typeof tokenId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'tokenId is required and must be a string');
  }
  if (!statusId || typeof statusId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'statusId is required and must be a string');
  }

  const located = foundryClient.findToken(tokenId, sceneId);
  if (!located) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Token not found: ${tokenId}${sceneId ? ` on scene ${sceneId}` : ''}`,
    );
  }

  const token = located.token as TokenActorRef;
  const actorId = token.actorId;
  if (!actorId) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Token ${tokenId} has no associated actor; cannot apply status effects.`,
    );
  }

  // Linked tokens share the world actor; unlinked tokens own a synthetic actor
  // (the per-token delta) that must be addressed through the Scene→Token path.
  const linked = token.actorLink === true;
  const parentActorUuid = linked
    ? `Actor.${actorId}`
    : `Scene.${located.scene._id}.Token.${tokenId}.ActorDelta.${tokenId}`;

  // Find an existing effect carrying this status (matches toggleStatusEffect).
  const effects: WorldEffect[] = linked
    ? (foundryClient.getRawActor(actorId)?.effects ?? [])
    : (token.delta?.effects ?? []);
  const existing = effects.find((e) => e.statuses?.includes(statusId));

  return withToolError('apply status effect', async () => {
    if (active) {
      if (existing) {
        return statusResult(
          `Status effect '${statusId}' is already active on ${token.name ?? tokenId}.`,
          tokenId,
          located.scene,
          statusId,
          true,
        );
      }
      const effect = await foundryClient.createActorStatusEffect(parentActorUuid, statusId);
      return statusResult(
        `Applied status effect '${statusId}' (effect ${effect._id}).`,
        tokenId,
        located.scene,
        statusId,
        true,
      );
    }

    if (!existing) {
      return statusResult(
        `Status effect '${statusId}' is not active on ${token.name ?? tokenId}; nothing to remove.`,
        tokenId,
        located.scene,
        statusId,
        false,
      );
    }
    await foundryClient.deleteActorEffect(parentActorUuid, existing._id);
    return statusResult(
      `Removed status effect '${statusId}' (effect ${existing._id}).`,
      tokenId,
      located.scene,
      statusId,
      false,
    );
  });
}

/** Builds the MCP text result for a status-effect mutation. */
function statusResult(
  summary: string,
  tokenId: string,
  scene: { _id: string; name: string },
  statusId: string,
  active: boolean,
) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `${active ? '✨' : '🧹'} **Status Effect ${active ? 'Applied' : 'Removed'}**
**Token:** ${tokenId}
**Scene:** ${scene.name} (${scene._id})
**Status:** ${statusId}
${summary}`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// update / delete
// ---------------------------------------------------------------------------

const TOKEN_DISPOSITIONS: Record<string, number> = {
  secret: -2,
  hostile: -1,
  neutral: 0,
  friendly: 1,
};

export interface TokenUpdateFields {
  name?: string;
  hidden?: boolean;
  disposition?: 'secret' | 'hostile' | 'neutral' | 'friendly';
  /** Size in grid squares; sets width and height together. */
  size?: number;
  width?: number;
  height?: number;
  elevation?: number;
  rotation?: number;
  alpha?: number;
  locked?: boolean;
}

/** Updates properties of a placed token (name, visibility, disposition, size, elevation, ...). */
export async function handleUpdateToken(
  args: { tokenId: string; sceneId?: string } & TokenUpdateFields,
  foundryClient: FoundryClient,
) {
  const located = foundryClient.findToken(args.tokenId, args.sceneId);
  if (!located) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Token not found: ${args.tokenId}${args.sceneId ? ` on scene ${args.sceneId}` : ''}`,
    );
  }
  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'hidden', 'elevation', 'rotation', 'alpha', 'locked'] as const) {
    if (args[k] !== undefined) {
      patch[k] = args[k];
    }
  }
  if (args.disposition !== undefined) {
    patch.disposition = TOKEN_DISPOSITIONS[args.disposition];
  }
  if (args.size !== undefined) {
    patch.width = args.size;
    patch.height = args.size;
  }
  if (args.width !== undefined) {
    patch.width = args.width;
  }
  if (args.height !== undefined) {
    patch.height = args.height;
  }
  if (Object.keys(patch).length === 0) {
    throw new McpError(ErrorCode.InvalidParams, 'Give at least one field to change');
  }
  const oldName = (located.token as TokenActorRef).name ?? args.tokenId;
  return withToolError('update token', async () => {
    await foundryClient.updateDocuments(
      'Token',
      [{ _id: args.tokenId, ...patch }],
      `Scene.${located.scene._id}`,
    );
    return {
      content: [
        {
          type: 'text',
          text: `✏️ **Token Updated** "${oldName}" on ${located.scene.name}: ${Object.keys(patch).join(', ')}`,
        },
      ],
    };
  });
}

/** Removes a token from its scene. */
export async function handleDeleteToken(
  args: { tokenId: string; sceneId?: string },
  foundryClient: FoundryClient,
) {
  const located = foundryClient.findToken(args.tokenId, args.sceneId);
  if (!located) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Token not found: ${args.tokenId}${args.sceneId ? ` on scene ${args.sceneId}` : ''}`,
    );
  }
  return withToolError('delete token', async () => {
    await foundryClient.deleteDocuments('Token', [args.tokenId], `Scene.${located.scene._id}`);
    const name = (located.token as TokenActorRef).name ?? args.tokenId;
    return {
      content: [
        {
          type: 'text',
          text: `🗑️ **Token Deleted** "${name}" from ${located.scene.name}. The actor is untouched. Undo with foundry_history_edit undo.`,
        },
      ],
    };
  });
}
