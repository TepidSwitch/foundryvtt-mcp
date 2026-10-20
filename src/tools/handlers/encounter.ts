/**
 * @fileoverview Encounter builder: suggest options (read) and place one (write)
 *
 * - handleGenerateEncounter: budget from party levels, compendium monsters by
 *   CR/type/habitat, 2-3 options. Creates nothing.
 * - handlePlaceEncounter: import each distinct creature once into a folder
 *   (reusing a world actor with the same compendium source), place tokens with
 *   the shared group layout and optionally start combat, all in one batch.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  buildOptions,
  type Candidate,
  crToXp,
  type Difficulty,
  type EncounterOption,
  partyBudget,
} from '../../dnd5e/encounter.js';
import type { FoundryClient } from '../../foundry/client.js';
import { squareToPixels } from '../../foundry/import.js';
import type { WorldActor } from '../../foundry/types.js';
import { resolveActor } from './character.js';
import { at, buildSheet, formatCr, isRec, parseCr, str } from './dnd5e.js';
import { ensureFolder } from './folders.js';
import {
  type GroupArea,
  layoutGroup,
  resolveGroupArea,
  sceneGeometry,
  tokenSpan,
} from './import-place.js';
import { resolveScene } from './scenes.js';
import { withToolError } from './utils.js';
import { resolveEntryId } from './world-browse.js';

const INDEX_FIELDS = ['system.details.cr', 'system.details.type.value', 'system.details.habitat'];

function snapshotOf(client: FoundryClient) {
  const snapshot = client.getWorldSnapshot();
  if (!snapshot) {
    throw new McpError(ErrorCode.InternalError, 'Not connected — no world data available');
  }
  return snapshot;
}

const COMPENDIUM_ACTOR_UUID = /^Compendium\.(.+)\.Actor\.([A-Za-z0-9]+)$/;

export function compendiumActorUuid(packId: string, documentId: string): string {
  return `Compendium.${packId}.Actor.${documentId}`;
}

// ---------------------------------------------------------------------------
// generate encounter
// ---------------------------------------------------------------------------

export interface GenerateEncounterArgs {
  party?: string[] | undefined;
  difficulty: Difficulty;
  creature_type?: string | undefined;
  environment?: string | undefined;
  max_creatures?: number | undefined;
  packs?: string[] | undefined;
  seed?: number | undefined;
}

function partyLevels(client: FoundryClient, refs: string[] | undefined): number[] {
  if (refs && refs.length > 0) {
    return refs.map((r) => buildSheet(resolveActor(client, r)).level);
  }
  const snapshot = snapshotOf(client);
  const levels: number[] = [];
  for (const user of snapshot.users.filter((u) => u.character)) {
    const actor = snapshot.actors.find((a) => a._id === user.character);
    if (actor) {
      levels.push(buildSheet(actor).level);
    }
  }
  return levels;
}

/** Reads monster candidates (npc entries with a CR) from the given Actor packs. */
async function loadCandidates(
  client: FoundryClient,
  packIds: string[],
  filters: { creatureType?: string | undefined; environment?: string | undefined },
): Promise<{ candidates: Candidate[]; skipped: string[]; habitatKnown: boolean }> {
  const byName = new Map<string, Candidate>();
  const skipped: string[] = [];
  let habitatKnown = false;
  for (const packId of packIds) {
    let index: Array<Record<string, unknown>>;
    try {
      index = await client.getPackIndexFields(packId, INDEX_FIELDS);
    } catch (error) {
      skipped.push(`${packId} (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    for (const doc of index) {
      if (str(doc.type) !== 'npc') {
        continue;
      }
      const cr = parseCr(at(doc, 'system', 'details', 'cr'));
      const xp = crToXp(cr);
      if (cr === null || xp === null) {
        continue;
      }
      const habitat = at(doc, 'system', 'details', 'habitat', 'value');
      const habitats = Array.isArray(habitat) ? habitat : [];
      const habitatTypes = habitats
        .filter(isRec)
        .map((h) => str(h.type).toLowerCase())
        .filter(Boolean);
      if (habitatTypes.length > 0) {
        habitatKnown = true;
      }
      if (filters.creatureType) {
        const type = str(at(doc, 'system', 'details', 'type', 'value')).toLowerCase();
        if (type !== filters.creatureType.toLowerCase()) {
          continue;
        }
      }
      if (filters.environment && !habitatTypes.includes(filters.environment.toLowerCase())) {
        continue;
      }
      const name = str(doc.name);
      const key = name.toLowerCase();
      if (!name || byName.has(key)) {
        continue; // first pack wins when a monster appears in several
      }
      byName.set(key, { uuid: compendiumActorUuid(packId, str(doc._id)), name, cr, xp });
    }
  }
  return { candidates: [...byName.values()], skipped, habitatKnown };
}

function describeOption(o: EncounterOption, budget: number, index: number): string {
  const rows = o.entries
    .map(
      (e) =>
        `- ${e.count}× **${e.candidate.name}** (CR ${formatCr(e.candidate.cr)}, ${e.candidate.xp} XP each)`,
    )
    .join('\n');
  const creatures = JSON.stringify(
    o.entries.map((e) => ({ uuid: e.candidate.uuid, count: e.count })),
  );
  return `### Option ${index + 1}: ${o.label}
${rows}
Total ${o.totalXp} XP of ${budget} budget · ${o.creatureCount} creature${o.creatureCount === 1 ? '' : 's'}
place_encounter creatures: \`${creatures}\``;
}

export async function handleGenerateEncounter(args: GenerateEncounterArgs, client: FoundryClient) {
  return withToolError('generate encounter', async () => {
    const levels = partyLevels(client, args.party);
    if (levels.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'No party found: no user has an assigned character. Pass party as actor ids or names.',
      );
    }
    const budget = partyBudget(levels, args.difficulty);
    const maxCreatures = args.max_creatures ?? 6;
    const packIds =
      args.packs && args.packs.length > 0
        ? args.packs
        : client
            .listPacks()
            .filter((p) => p.type === 'Actor')
            .map((p) => p.id);

    const { candidates, skipped, habitatKnown } = await loadCandidates(client, packIds, {
      creatureType: args.creature_type,
      environment: args.environment,
    });
    // Without a seed, equal-XP ties would always go to the alphabetically first monster.
    const seed = args.seed ?? Math.floor(Math.random() * 1_000_000);
    const options = buildOptions(candidates, budget, maxCreatures, seed);

    const head = `🐉 **Encounter options** — ${args.difficulty} for ${levels.length} character${levels.length === 1 ? '' : 's'} (levels ${levels.join(', ')}) · budget ${budget} XP (2024 rules: monster XP is summed, no multiplier)
Searched ${candidates.length} monster${candidates.length === 1 ? '' : 's'} in ${packIds.length} pack${packIds.length === 1 ? '' : 's'}${args.creature_type ? ` · type ${args.creature_type}` : ''}${args.environment ? ` · environment ${args.environment}` : ''} · max ${maxCreatures} creatures · seed ${seed}`;
    const notes = [
      skipped.length > 0 ? `Skipped packs: ${skipped.join('; ')}` : '',
      args.environment && !habitatKnown
        ? 'No monster in these packs lists a habitat, so the environment filter matched nothing.'
        : '',
    ].filter(Boolean);
    const body =
      options.length > 0
        ? options.map((o, i) => describeOption(o, budget, i)).join('\n\n')
        : 'No monster fits this budget with these filters. Try a higher difficulty, other packs or no creature_type/environment.';
    return {
      content: [
        {
          type: 'text',
          text: `${head}\n\n${body}\n\n${notes.length > 0 ? `${notes.join('\n')}\n\n` : ''}_Nothing was created. Pass an option's creatures array to foundry_tokens_edit place_encounter._`,
        },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// place encounter
// ---------------------------------------------------------------------------

export interface EncounterCreatureArg {
  uuid?: string | undefined;
  compendiumId?: string | undefined;
  documentId?: string | undefined;
  name?: string | undefined;
  actor?: string | undefined;
  count?: number | undefined;
}

export interface PlaceEncounterArgs {
  creatures: EncounterCreatureArg[];
  scene: string;
  area?: { x: number; y: number; width: number; height: number } | undefined;
  region_id?: string | undefined;
  folder?: string | undefined;
  start_combat?: boolean | undefined;
  hidden?: boolean | undefined;
  spacing?: number | undefined;
}

type Resolved =
  | { kind: 'world'; actor: WorldActor; count: number }
  | { kind: 'compendium'; packId: string; documentId: string; source: string; count: number };

async function resolveCreature(client: FoundryClient, c: EncounterCreatureArg): Promise<Resolved> {
  const count = c.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new McpError(ErrorCode.InvalidParams, 'count must be a whole number from 1 to 20');
  }
  if (c.actor) {
    return { kind: 'world', actor: resolveActor(client, c.actor), count };
  }
  let packId = c.compendiumId;
  let documentId = c.documentId;
  if (c.uuid) {
    const m = COMPENDIUM_ACTOR_UUID.exec(c.uuid);
    if (m) {
      packId = m[1];
      documentId = m[2];
    } else if (/^Actor\.[A-Za-z0-9]{16}$/.test(c.uuid)) {
      return { kind: 'world', actor: resolveActor(client, c.uuid.slice(6)), count };
    } else {
      throw new McpError(
        ErrorCode.InvalidParams,
        `uuid "${c.uuid}" must be Compendium.<pack>.Actor.<id> or Actor.<id>`,
      );
    }
  }
  if (!packId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Each creature needs a uuid, an actor, or compendiumId with documentId/name',
    );
  }
  const pack = client.listPacks().find((p) => p.id === packId);
  if (!pack || pack.type !== 'Actor') {
    throw new McpError(ErrorCode.InvalidParams, `${packId} is not an Actor compendium pack`);
  }
  const id = await resolveEntryId(client, packId, documentId, c.name);
  return {
    kind: 'compendium',
    packId,
    documentId: id,
    source: compendiumActorUuid(packId, id),
    count,
  };
}

function sourceOf(actor: WorldActor): string {
  return str(at(actor, '_stats', 'compendiumSource'));
}

export async function handlePlaceEncounter(args: PlaceEncounterArgs, client: FoundryClient) {
  return withToolError('place encounter', async () => {
    if (Boolean(args.area) === Boolean(args.region_id)) {
      throw new McpError(ErrorCode.InvalidParams, 'Give exactly one of area or region_id');
    }
    if (args.creatures.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'creatures must list at least one creature');
    }
    const snapshot = snapshotOf(client);
    const scene = resolveScene(snapshot, args.scene);
    const area: GroupArea = resolveGroupArea(scene, args.area, args.region_id);
    const geometry = sceneGeometry(scene);

    // Resolve everything and merge repeats of the same creature (one import each).
    const merged = new Map<string, Resolved>();
    for (const c of args.creatures) {
      const r = await resolveCreature(client, c);
      const key = r.kind === 'world' ? `w:${r.actor._id}` : `c:${r.source}`;
      const prev = merged.get(key);
      merged.set(key, prev ? { ...r, count: prev.count + r.count } : r);
    }
    const entries = [...merged.values()];

    // Reuse a world actor imported from the same compendium entry.
    const reuse = (r: Resolved): WorldActor | undefined =>
      r.kind === 'world' ? r.actor : snapshot.actors.find((a) => sourceOf(a) === r.source);

    // Check everything fits before writing anything.
    const spans: number[] = [];
    for (const r of entries) {
      const existing = reuse(r);
      if (existing) {
        spans.push(tokenSpan(existing));
      } else if (r.kind === 'compendium') {
        const doc = await client.getCompendiumDocument(r.packId, r.documentId);
        spans.push(tokenSpan(isRec(doc) ? { prototypeToken: doc.prototypeToken } : {}));
      }
    }
    const slots = layoutGroup(
      entries.map((r, i) => ({
        label: r.kind === 'world' ? r.actor.name : r.source,
        span: spans[i] ?? 1,
        count: r.count,
      })),
      area,
      args.spacing ?? 1,
    );
    const hidden = args.hidden ?? true;
    const folderName = args.folder ?? 'Encounters';
    const dry = client.isDryRunning();

    const result = await client.withBatch(async () => {
      const batchId = client.getCurrentBatchId();
      const folderId = entries.some((r) => !reuse(r))
        ? await ensureFolder(client, folderName, 'Actor')
        : undefined;
      const lines: string[] = [];
      const createdActors: string[] = [];
      const tokenIds: Array<{ tokenId: string; actorId: string }> = [];
      for (const [i, r] of entries.entries()) {
        const actor = reuse(r);
        let label: string;
        let actorId: string;
        let name: string;
        if (actor) {
          actorId = actor._id;
          name = actor.name;
          label = 'reused';
        } else if (r.kind === 'compendium') {
          const created = await client.importCompendiumDocument(r.packId, r.documentId, {
            ...(folderId ? { folder: folderId } : {}),
          });
          actorId = created.id;
          name = created.name;
          label = 'imported';
          createdActors.push(created.id);
        } else {
          continue;
        }
        const mine = slots.filter((s) => s.entry === i);
        if (dry) {
          lines.push(`- ${r.count}× **${name}** (${label}, dry run: tokens not placed)`);
          continue;
        }
        const tokens = mine.map((s) => {
          const p = squareToPixels(geometry, s.col, s.row);
          return {
            x: p.x,
            y: p.y,
            ...(r.count > 1 ? { name: `${name} ${s.instance + 1}` } : {}),
            hidden,
          };
        });
        const placed = await client.createSceneTokens(scene._id, actorId, tokens);
        for (const t of placed) {
          tokenIds.push({ tokenId: t.id, actorId });
        }
        lines.push(
          `- ${placed.length}× **${name}** (${label}, actor \`${actorId}\`) tokens ${placed.map((t) => `\`${t.id}\``).join(' ')}`,
        );
      }
      let combatLine = '';
      if (args.start_combat && !dry) {
        const combat = await client.startCombat(
          scene._id,
          tokenIds.map((t) => ({ tokenId: t.tokenId, sceneId: scene._id, actorId: t.actorId })),
        );
        combatLine = `\n⚔️ Combat \`${combat.combatId}\` started with ${combat.combatantCount} combatants.`;
      }
      return { batchId, lines, createdActors, combatLine, folderId };
    });

    const visible = scene.active && !hidden;
    return {
      content: [
        {
          type: 'text',
          text: `${dry ? '🧪 Dry run: ' : '✅ '}Encounter placed on **${scene.name}** (\`${scene._id}\`) in a ${area.cols}×${area.rows} area at square (${area.col}, ${area.row}); tokens ${hidden ? 'hidden' : 'visible'}.
${result.lines.join('\n')}${result.combatLine}
${result.createdActors.length > 0 ? `\nNew actors in folder "${folderName}"${result.folderId ? ` (\`${result.folderId}\`)` : ''}: ${result.createdActors.map((id) => `\`${id}\``).join(', ')}` : ''}
Batch \`${result.batchId}\`: foundry_history_edit undo reverts the whole encounter in one step.${visible ? '\n⚠️ This scene is active and the tokens are not hidden, so players can see them now.' : ''}`,
        },
      ],
    };
  });
}
