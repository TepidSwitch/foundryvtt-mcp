/**
 * @fileoverview NPC finder: read-only compendium search for monsters/NPCs
 */

import type { FoundryClient } from '../../foundry/client.js';
import { formatCr } from './dnd5e.js';
import { actorPackIds, loadNpcEntries, type NpcEntry } from './encounter.js';
import { withToolError } from './utils.js';

export interface FindNpcArgs {
  query?: string | undefined;
  cr?: number | undefined;
  cr_min?: number | undefined;
  cr_max?: number | undefined;
  creature_type?: string | undefined;
  environment?: string | undefined;
  packs?: string[] | undefined;
  legacy?: boolean | undefined;
  limit?: number | undefined;
}

/** Closest to `cr` first (when given), then by name. Pure. */
export function rankNpcs(entries: NpcEntry[], args: FindNpcArgs): NpcEntry[] {
  const q = args.query?.trim().toLowerCase();
  return entries
    .filter(
      (e) =>
        (!q || e.name.toLowerCase().includes(q)) &&
        (args.cr_min === undefined || e.cr >= args.cr_min) &&
        (args.cr_max === undefined || e.cr <= args.cr_max),
    )
    .sort((a, b) => {
      const da = args.cr === undefined ? 0 : Math.abs(a.cr - args.cr);
      const db = args.cr === undefined ? 0 : Math.abs(b.cr - args.cr);
      return da - db || a.name.localeCompare(b.name);
    });
}

export async function handleFindNpc(args: FindNpcArgs, client: FoundryClient) {
  return withToolError('find npc', async () => {
    const limit = Math.min(50, Math.max(1, args.limit ?? 10));
    const packIds = actorPackIds(client, args.packs);
    const { entries, skipped } = await loadNpcEntries(client, packIds, {
      creatureType: args.creature_type,
      environment: args.environment,
      legacy: args.legacy,
    });
    // CR 0 would be dropped by a naive `args.cr ?` truthiness test; rankNpcs uses !== undefined.
    const hits = rankNpcs(entries, args);
    const shown = hits.slice(0, limit);
    const rows = shown
      .map(
        (e) =>
          `- **${e.name}** · CR ${formatCr(e.cr)} · ${e.creatureType || 'unknown type'}${e.habitats.length > 0 ? ` · ${e.habitats.join(', ')}` : ''} · ${e.packId}\n  ${e.uuid}`,
      )
      .join('\n');
    const head = `🧙 **NPC search** — ${hits.length} match${hits.length === 1 ? '' : 'es'} in ${packIds.length} pack${packIds.length === 1 ? '' : 's'}${hits.length > shown.length ? `, showing ${shown.length}` : ''}${args.cr !== undefined ? ` · nearest CR ${formatCr(args.cr)} first` : ''}`;
    const notes = skipped.length > 0 ? `\nSkipped packs: ${skipped.join('; ')}` : '';
    const body = shown.length > 0 ? rows : 'No NPC matches these filters.';
    return {
      content: [
        {
          type: 'text',
          text: `${head}\n\n${body}${notes}\n\n_Nothing was created. Bring one into the world with foundry_actors_edit import (compendiumId = the pack, documentId = the uuid's last segment) or foundry_tokens_edit place_encounter (creatures: [{uuid, count}])._`,
        },
      ],
    };
  });
}
