/**
 * User management tool handler
 */

import type { FoundryClient } from '../../foundry/client.js';
import { withToolError } from './utils.js';

const ROLE_NAMES: Record<number, string> = {
  0: 'None',
  1: 'Player',
  2: 'Trusted Player',
  3: 'Assistant GM',
  4: 'Game Master',
};

export async function handleGetUsers(_args: Record<string, unknown>, foundryClient: FoundryClient) {
  return withToolError('get users', async () => {
    const { users, activeUsers } = foundryClient.getUsers();
    const activeSet = new Set(activeUsers);

    const actors = foundryClient.getWorldSnapshot?.()?.actors ?? [];
    const formatted = users
      .map((u) => {
        const online = activeSet.has(u._id) ? 'Online' : 'Offline';
        const role = ROLE_NAMES[u.role] || `Role ${u.role}`;
        const character = u.character ? actors.find((a) => a._id === u.character) : undefined;
        const played = character
          ? ` — plays **${character.name}** (\`${character._id}\`)`
          : u.character
            ? ` — character id \`${u.character}\``
            : '';
        return `- **${u.name}** (${role}) — ${online} — id \`${u._id}\`${played}`;
      })
      .join('\n');

    const onlineCount = users.filter((u) => activeSet.has(u._id)).length;

    return {
      content: [
        {
          type: 'text',
          text: `**Users** (${onlineCount}/${users.length} online)\n\n${formatted}`,
        },
      ],
    };
  });
}
