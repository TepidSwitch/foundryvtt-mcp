/**
 * Combat state tool handler
 */

import type { FoundryClient } from '../../foundry/client.js';
import type { WorldCombatant } from './combat-order.js';
import { getCurrentCombatant, getTurnOrder, isCombatStarted } from './combat-order.js';
import { at, buildSheet, isRec, num } from './dnd5e.js';
import { withToolError } from './utils.js';

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Combatant documents carry no display name in current Foundry: the tracker
 * derives it from the token, then the actor. Do the same, so the list is
 * readable even when `name` is absent or empty.
 */
function combatantName(c: WorldCombatant, foundryClient: FoundryClient): string {
  const token = c.tokenId ? foundryClient.findToken(c.tokenId, c.sceneId)?.token : undefined;
  const actorId = c.actorId ?? nonEmpty(token?.actorId);
  const actor = actorId ? foundryClient.getRawActor(actorId) : undefined;
  return nonEmpty(c.name) ?? nonEmpty(token?.name) ?? nonEmpty(actor?.name) ?? 'Unknown combatant';
}

/**
 * HP and AC for the combatant. dnd5e derives AC (and often max HP) at runtime,
 * so the raw `ac.value` and `hp.max` are missing; `buildSheet` reproduces them.
 * An unlinked token keeps its own HP in `delta`, which wins over the base actor.
 */
function hpAcText(c: WorldCombatant, foundryClient: FoundryClient): string {
  const token = c.tokenId ? foundryClient.findToken(c.tokenId, c.sceneId)?.token : undefined;
  const actorId = c.actorId ?? nonEmpty(token?.actorId);
  const actor = actorId ? foundryClient.getRawActor(actorId) : undefined;
  if (!actor) {
    return '';
  }
  try {
    const sheet = buildSheet(actor);
    const deltaHp = at(token?.delta, 'system', 'attributes', 'hp');
    const value =
      isRec(deltaHp) && typeof deltaHp.value === 'number' ? deltaHp.value : sheet.hp.value;
    const max = isRec(deltaHp) && typeof deltaHp.max === 'number' ? deltaHp.max : sheet.hp.max;
    const ac = sheet.ac.value;
    return ` HP: ${num(value)}/${max ?? '?'} AC: ${ac ?? '?'}`;
  } catch {
    // Not a dnd5e-shaped actor: leave the stats out rather than print guesses.
    return '';
  }
}

export async function handleGetCombatState(
  _args: Record<string, unknown>,
  foundryClient: FoundryClient,
) {
  return withToolError('get combat state', async () => {
    const combat = foundryClient.getCombatState();

    if (!combat) {
      return {
        content: [{ type: 'text', text: 'No active combat encounter.' }],
      };
    }

    // `combat` is a live reference into the world-data cache: sort a COPY via
    // the shared helper so a read never reorders cached state (#214). The same
    // helper backs `next_turn`, so both tools agree on what `combat.turn` means.
    const combatants = getTurnOrder(combat)
      .map((c, i) => {
        const current = combat.turn === i ? ' <-- CURRENT' : '';
        const status = c.defeated ? ' [DEFEATED]' : c.hidden ? ' [HIDDEN]' : '';
        const init = c.initiative !== null ? c.initiative.toString() : '?';

        const hpAc = hpAcText(c, foundryClient);

        return `${i + 1}. [${init}] **${combatantName(c, foundryClient)}**${hpAc}${status}${current}`;
      })
      .join('\n');

    const acting = getCurrentCombatant(combat);
    const header = isCombatStarted(combat)
      ? `Round ${combat.round}${acting ? ` — current turn: ${combatantName(acting, foundryClient)}` : ''}`
      : `Round ${combat.round} — not started (initiative order shown; the first combatant acts first)`;

    return {
      content: [
        {
          type: 'text',
          text: `**Active Combat** — ${header}\n\n${combatants}`,
        },
      ],
    };
  });
}
