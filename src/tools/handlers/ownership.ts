/**
 * @fileoverview Document ownership: who can see, use or edit an actor
 *
 * Foundry stores `ownership` as `{ <userId | "default">: level }` with levels
 * NONE 0, LIMITED 1, OBSERVER 2, OWNER 3 (CONST.DOCUMENT_OWNERSHIP_LEVELS).
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import { resolveActor } from './character.js';
import { isRec, num, str } from './dnd5e.js';
import { snapshotOf } from './refs.js';
import { withToolError } from './utils.js';

export const OWNERSHIP_LEVELS = { none: 0, limited: 1, observer: 2, owner: 3 } as const;
export type OwnershipLevelName = keyof typeof OWNERSHIP_LEVELS;

const LEVEL_NAMES = ['none', 'limited', 'observer', 'owner'];
const EVERYONE = new Set(['default', 'everyone', 'all']);

export async function handleSetActorOwnership(
  args: { actor: string; user: string; level: OwnershipLevelName },
  foundryClient: FoundryClient,
) {
  return withToolError('set ownership', async () => {
    const snapshot = snapshotOf(foundryClient);
    const actor = resolveActor(foundryClient, args.actor);
    const ref = args.user.trim();

    let key: string;
    let who: string;
    if (EVERYONE.has(ref.toLowerCase())) {
      key = 'default';
      who = 'everyone else (default)';
    } else {
      const lower = ref.toLowerCase();
      const byId = snapshot.users.find((u) => u._id === ref);
      const named = snapshot.users.filter((u) => u.name.toLowerCase() === lower);
      const user = byId ?? (named.length === 1 ? named[0] : undefined);
      if (!user) {
        throw new McpError(
          ErrorCode.InvalidParams,
          named.length > 1
            ? `"${ref}" matches several users — use a user id`
            : `No user matches "${ref}". Users: ${snapshot.users.map((u) => u.name).join(', ')} (see foundry_world users), or "default" for everyone else.`,
        );
      }
      key = user._id;
      who = user.name;
    }

    const level = OWNERSHIP_LEVELS[args.level];
    await foundryClient.updateDocuments('Actor', [{ _id: actor._id, [`ownership.${key}`]: level }]);

    const current = isRec(actor.ownership)
      ? { ...actor.ownership, [key]: level }
      : { [key]: level };
    const names = new Map(snapshot.users.map((u) => [u._id, u.name]));
    const summary = Object.entries(current)
      .map(
        ([k, v]) =>
          `${k === 'default' ? 'default' : (names.get(k) ?? k)}: ${LEVEL_NAMES[num(v)] ?? str(v)}`,
      )
      .join(', ');
    return {
      content: [
        {
          type: 'text',
          text: `🔑 **Ownership Updated** — ${actor.name}\n**${who}:** ${args.level}\n**Now:** ${summary}`,
        },
      ],
    };
  });
}
