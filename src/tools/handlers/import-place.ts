/**
 * @fileoverview Additive write tools: import from a compendium, place tokens
 *
 * Both tools only ever CREATE documents; nothing existing is modified. They
 * require FOUNDRY_WRITE_ENABLED=true and a GM login (enforced by the client).
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import {
  DISPOSITIONS,
  type SceneGeometry,
  sceneSquares,
  squareToPixels,
} from '../../foundry/import.js';
import type { WorldData, WorldScene } from '../../foundry/types.js';
import { geometryOf as canvasGeometry, findEmbedded } from './canvas-common.js';
import { regionBounds } from './canvas-regions.js';
import { resolveActor } from './character.js';
import { at, isRec, num, str } from './dnd5e.js';
import { resolveScene } from './scenes.js';
import { withToolError } from './utils.js';
import { resolveEntryId } from './world-browse.js';

function snapshotOf(foundryClient: FoundryClient): WorldData {
  const snapshot = foundryClient.getWorldSnapshot();
  if (!snapshot) {
    throw new McpError(ErrorCode.InternalError, 'Not connected — no world data available');
  }
  return snapshot;
}

const FOLDER_TYPES: Record<string, string> = {
  Actor: 'Actor',
  Item: 'Item',
  Scene: 'Scene',
  JournalEntry: 'JournalEntry',
  RollTable: 'RollTable',
  Playlist: 'Playlist',
};

/** Finds a world folder of the given document type by id or exact name. */
export function resolveFolder(snapshot: WorldData, ref: string, packType: string): string {
  const type = FOLDER_TYPES[packType];
  const candidates = snapshot.folders.filter((f) => str(f.type) === type);
  const byId = candidates.find((f) => f._id === ref);
  if (byId) {
    return str(byId._id);
  }
  const named = candidates.filter((f) => str(f.name).toLowerCase() === ref.toLowerCase());
  if (named.length === 1 && named[0]) {
    return str(named[0]._id);
  }
  throw new McpError(
    ErrorCode.InvalidParams,
    named.length > 1
      ? `"${ref}" matches ${named.length} ${type} folders — pass a folder id`
      : `No ${type} folder matches "${ref}". Folders are not created automatically; see foundry_world browse kind="folders" folder_type="${type}".`,
  );
}

// ---------------------------------------------------------------------------
// import_from_compendium
// ---------------------------------------------------------------------------

export async function handleImportFromCompendium(
  args: {
    compendiumId?: string;
    documentId?: string;
    name?: string;
    actor?: string;
    folder?: string;
    new_name?: string;
  },
  foundryClient: FoundryClient,
) {
  const { compendiumId, documentId, name, actor: actorRef, folder, new_name } = args;
  if (!compendiumId || typeof compendiumId !== 'string') {
    throw new McpError(
      ErrorCode.InvalidParams,
      'compendiumId is required (see foundry_compendium search or packs)',
    );
  }
  if (!documentId && !name) {
    throw new McpError(ErrorCode.InvalidParams, 'Provide documentId or name');
  }
  return withToolError('import from compendium', async () => {
    const snapshot = snapshotOf(foundryClient);
    const pack = foundryClient.listPacks().find((p) => p.id === compendiumId);
    if (!pack) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown compendium pack: ${compendiumId}`);
    }
    if (!(pack.type in FOLDER_TYPES)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Importing ${pack.type} documents is not supported (supported: ${Object.keys(FOLDER_TYPES).join(', ')})`,
      );
    }
    if (actorRef && pack.type !== 'Item') {
      throw new McpError(
        ErrorCode.InvalidParams,
        `actor can only be used with Item compendiums (this pack holds ${pack.type})`,
      );
    }
    if (actorRef && folder) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'folder does not apply when adding an item to an actor',
      );
    }

    const id = await resolveEntryId(foundryClient, compendiumId, documentId, name);
    const source = await foundryClient.getCompendiumDocument(compendiumId, id);
    const sourceName = str(source.name);

    let target: ReturnType<typeof resolveActor> | undefined;
    let folderId: string | undefined;
    if (actorRef) {
      target = resolveActor(foundryClient, actorRef);
    } else if (folder) {
      folderId = resolveFolder(snapshot, folder, pack.type);
    }

    // Importing twice makes two copies; say so rather than blocking.
    const wanted = new_name || sourceName;
    const existing = target
      ? (target.items ?? []).filter((i) => i.name === wanted)
      : (
          {
            Actor: snapshot.actors,
            Item: snapshot.items,
            Scene: snapshot.scenes,
            JournalEntry: snapshot.journal,
            RollTable: snapshot.tables as Array<{ name?: string }>,
          }[pack.type] ?? []
        ).filter((d) => (d as { name?: string }).name === wanted);

    const created = await foundryClient.importCompendiumDocument(compendiumId, id, {
      ...(new_name ? { name: new_name } : {}),
      ...(folderId ? { folder: folderId } : {}),
      ...(target ? { actorId: target._id } : {}),
    });

    const where = target
      ? `on **${target.name}** (\`${target._id}\`)`
      : `into the world${folderId ? ` (folder ${folder})` : ''}`;
    return {
      content: [
        {
          type: 'text',
          text: `✅ Imported **${created.name}** (${created.type}) ${where}
New id: \`${created.id}\` · from \`${compendiumId}\` / \`${id}\`
${existing.length > 0 ? `\n⚠️ ${existing.length} document(s) named "${wanted}" already existed, so this is an additional copy.\n` : ''}
Nothing existing was modified. To undo, delete the new document in Foundry${target ? ' (or with foundry_items_edit remove_from_actor)' : ''}.`,
        },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// place_actor_on_scene
// ---------------------------------------------------------------------------

export async function handlePlaceActorOnScene(
  args: {
    scene?: string;
    actor?: string;
    x?: number;
    y?: number;
    count?: number;
    hidden?: boolean;
    disposition?: string;
    name?: string;
  },
  foundryClient: FoundryClient,
) {
  const { scene: sceneRef, actor: actorRef, x, y, count = 1, hidden, disposition, name } = args;
  if (!sceneRef || typeof sceneRef !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'scene (id or name) is required');
  }
  if (!actorRef || typeof actorRef !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'actor (id or name) is required');
  }
  if ((x === undefined) !== (y === undefined)) {
    throw new McpError(ErrorCode.InvalidParams, 'Provide both x and y (grid squares), or neither');
  }
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new McpError(ErrorCode.InvalidParams, 'count must be a whole number from 1 to 20');
  }
  if (disposition !== undefined && !(disposition in DISPOSITIONS)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `disposition must be one of: ${Object.keys(DISPOSITIONS).join(', ')}`,
    );
  }

  return withToolError('place actor on scene', async () => {
    const snapshot = snapshotOf(foundryClient);
    const scene = resolveScene(snapshot, sceneRef);
    const actor = resolveActor(foundryClient, actorRef);

    const geometry = sceneGeometry(scene);
    const { cols, rows } = sceneSquares(geometry);
    const span = tokenSpan(actor);

    const startCol = x ?? Math.floor(cols / 2);
    const startRow = y ?? Math.floor(rows / 2);
    if (!Number.isFinite(startCol) || !Number.isFinite(startRow)) {
      throw new McpError(ErrorCode.InvalidParams, 'x and y must be numbers');
    }

    // Lay tokens out left to right, wrapping to the next row at the map edge.
    const tokens: Array<{
      x: number;
      y: number;
      name?: string;
      hidden?: boolean;
      disposition?: number;
      label: string;
    }> = [];
    let col = Math.round(startCol);
    let row = Math.round(startRow);
    const base = name || actor.name;
    for (let i = 0; i < count; i++) {
      if (col + span > cols) {
        col = Math.round(startCol);
        row += span;
      }
      if (col < 0 || row < 0 || col + span > cols || row + span > rows) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Square (${col}, ${row}) is outside the ${cols}×${rows} map. Squares run from (0,0) at the top-left of the map image.`,
        );
      }
      const px = squareToPixels(geometry, col, row);
      tokens.push({
        x: px.x,
        y: px.y,
        ...(count > 1 || name ? { name: count > 1 ? `${base} ${i + 1}` : base } : {}),
        ...(typeof hidden === 'boolean' ? { hidden } : {}),
        ...(disposition ? { disposition: DISPOSITIONS[disposition] as number } : {}),
        label: `(${col}, ${row})`,
      });
      col += span;
    }

    const placed = await foundryClient.createSceneTokens(
      scene._id,
      actor._id,
      tokens.map(({ label: _label, ...t }) => t),
    );

    const visible = scene.active && hidden !== true;
    return {
      content: [
        {
          type: 'text',
          text: `✅ Placed ${placed.length} token${placed.length === 1 ? '' : 's'} of **${actor.name}** on **${scene.name}** (\`${scene._id}\`)
${placed.map((p, i) => `- ${p.name || actor.name} \`${p.id}\` at square ${tokens[i]?.label}`).join('\n')}
${visible ? '\n⚠️ This scene is active and the tokens are not hidden, so players can see them now.\n' : ''}
Map is ${cols}×${rows} squares; squares are counted from the top-left of the map image. Nothing existing was modified. Remove tokens in Foundry if unwanted.`,
        },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// place_group
// ---------------------------------------------------------------------------

/** Pixel geometry of a scene, as the grid helpers in foundry/import.ts want it. */
function sceneGeometry(scene: WorldScene): SceneGeometry {
  const raw = scene as unknown as Record<string, unknown>;
  return {
    width: scene.width,
    height: scene.height,
    padding: scene.padding,
    gridSize: num(at(scene, 'grid', 'size'), 100) || 100,
    shiftX: num(raw.shiftX),
    shiftY: num(raw.shiftY),
  };
}

/** Grid squares a token of this actor spans (prototype token width, at least 1). */
function tokenSpan(actor: { prototypeToken?: unknown }): number {
  const proto = isRec(actor.prototypeToken) ? actor.prototypeToken : {};
  return Math.max(1, Math.round(num(proto.width, 1)));
}

export interface GroupEntry {
  /** Free label used in error messages and token names. */
  label: string;
  /** Squares the token spans (1 medium, 2 large, ...). */
  span: number;
  count: number;
}

export interface GroupArea {
  /** Top-left square of the area, from the map's top-left. */
  col: number;
  row: number;
  /** Size in squares. */
  cols: number;
  rows: number;
}

export interface GroupSlot {
  entry: number;
  /** 0-based index within the entry's count. */
  instance: number;
  col: number;
  row: number;
}

/**
 * Lays tokens out left to right, then top to bottom, inside `area`, entry after
 * entry, with `spacing` empty squares between neighbours (rows are as tall as
 * their largest token). Throws InvalidParams, saying how much room is missing,
 * when they do not fit. Pure: no Foundry access, reusable by an encounter builder.
 */
export function layoutGroup(entries: GroupEntry[], area: GroupArea, spacing = 1): GroupSlot[] {
  const gap = Math.max(0, Math.round(spacing));
  const slots: GroupSlot[] = [];
  let col = 0;
  let row = 0;
  let rowHeight = 0;
  let total = 0;
  for (const [entry, e] of entries.entries()) {
    if (e.span > area.cols || e.span > area.rows) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `${e.label} is ${e.span}×${e.span} squares and does not fit in the ${area.cols}×${area.rows} area`,
      );
    }
    for (let instance = 0; instance < e.count; instance++) {
      total += 1;
      if (col > 0 && col + e.span > area.cols) {
        col = 0;
        row += rowHeight + gap;
        rowHeight = 0;
      }
      if (row + e.span > area.rows) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Not enough room: the ${area.cols}×${area.rows} area (spacing ${gap}) holds only ${slots.length} of the ${entries.reduce((n, x) => n + x.count, 0)} tokens (stopped at ${e.label}, token ${total}). Use a bigger area, less spacing, or fewer tokens.`,
        );
      }
      slots.push({ entry, instance, col: area.col + col, row: area.row + row });
      col += e.span + gap;
      rowHeight = Math.max(rowHeight, e.span);
    }
  }
  return slots;
}

export async function handlePlaceGroup(
  args: {
    scene: string;
    actors: Array<{ ref: string; count?: number | undefined }>;
    area?: { x: number; y: number; width: number; height: number } | undefined;
    region_id?: string | undefined;
    spacing?: number | undefined;
    hidden?: boolean | undefined;
    disposition?: string | undefined;
  },
  foundryClient: FoundryClient,
) {
  return withToolError('place token group', async () => {
    if (Boolean(args.area) === Boolean(args.region_id)) {
      throw new McpError(ErrorCode.InvalidParams, 'Give exactly one of area or region_id');
    }
    if (args.actors.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'actors must list at least one actor');
    }
    if (args.disposition !== undefined && !(args.disposition in DISPOSITIONS)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `disposition must be one of: ${Object.keys(DISPOSITIONS).join(', ')}`,
      );
    }
    const scene = resolveScene(snapshotOf(foundryClient), args.scene);
    const g = canvasGeometry(scene);
    const geometry = sceneGeometry(scene);
    const rect = args.area ?? regionBounds(g, findEmbedded(g, 'regions', args.region_id as string));
    // Only whole squares fully inside the rectangle are usable.
    const col = Math.max(0, Math.ceil(rect.x - 1e-6));
    const row = Math.max(0, Math.ceil(rect.y - 1e-6));
    const area: GroupArea = {
      col,
      row,
      cols: Math.min(g.cols, Math.floor(rect.x + rect.width + 1e-6)) - col,
      rows: Math.min(g.rows, Math.floor(rect.y + rect.height + 1e-6)) - row,
    };
    if (area.cols < 1 || area.rows < 1) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `The area holds no whole grid square on the ${g.cols}×${g.rows} map`,
      );
    }
    const resolved = args.actors.map((a) => {
      const count = a.count ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > 20) {
        throw new McpError(ErrorCode.InvalidParams, `count for "${a.ref}" must be 1 to 20`);
      }
      const actor = resolveActor(foundryClient, a.ref);
      return { actor, count, span: tokenSpan(actor) };
    });
    const slots = layoutGroup(
      resolved.map((r) => ({ label: r.actor.name, span: r.span, count: r.count })),
      area,
      args.spacing ?? 1,
    );
    const disposition =
      args.disposition !== undefined ? (DISPOSITIONS[args.disposition] as number) : undefined;

    const lines = await foundryClient.withBatch(async () => {
      const out: string[] = [];
      for (const [i, r] of resolved.entries()) {
        const mine = slots.filter((s) => s.entry === i);
        const tokens = mine.map((s) => {
          const p = squareToPixels(geometry, s.col, s.row);
          return {
            x: p.x,
            y: p.y,
            ...(r.count > 1 ? { name: `${r.actor.name} ${s.instance + 1}` } : {}),
            ...(typeof args.hidden === 'boolean' ? { hidden: args.hidden } : {}),
            ...(disposition !== undefined ? { disposition } : {}),
          };
        });
        const placed = await foundryClient.createSceneTokens(scene._id, r.actor._id, tokens);
        out.push(
          `- ${placed.length}× **${r.actor.name}** (${r.span}×${r.span}) at ${mine.map((s) => `(${s.col}, ${s.row})`).join(' ')}`,
        );
      }
      return out;
    });
    const visible = scene.active && args.hidden !== true;
    return {
      content: [
        {
          type: 'text',
          text: `✅ Placed ${slots.length} tokens on **${scene.name}** in a ${area.cols}×${area.rows} area at square (${area.col}, ${area.row}), spacing ${Math.max(0, Math.round(args.spacing ?? 1))}. One undo reverts them all.
${lines.join('\n')}
${visible ? '\n⚠️ This scene is active and the tokens are not hidden, so players can see them now.\n' : ''}`,
        },
      ],
    };
  });
}
